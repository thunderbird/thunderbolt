import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import * as schema from '@/db/schema'
import { waitlist } from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, emailOTP } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import { sendWaitlistJoinedEmail, sendWaitlistNotReadyEmail } from '@/waitlist/utils'
import { buildVerifyUrl, getValidatedOrigin, parseTrustedOrigins, sendSignInEmail } from './utils'

/**
 * Trusted origins for CORS and email link validation
 * First origin is the default fallback for verify URLs
 */
const trustedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)

/**
 * Create a Better Auth instance with the provided database
 * This factory pattern allows tests to inject their own database
 *
 * Uses emailOTP for passwordless authentication:
 * - OTPs are stored in the database (verification table) by Better Auth
 * - Sign-in emails include both an OTP code and a "magic link" that embeds the OTP
 * - Both paths (manual OTP entry, clicking link) use the same verification endpoint
 * - No separate email verification needed - signing in proves email ownership
 */
export const createAuth = (database: typeof DbType) =>
  betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
    }),
    trustedOrigins,
    user: {
      additionalFields: {
        isNew: {
          type: 'boolean',
          required: false,
          defaultValue: true,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (userData) => ({
            data: { ...userData, email: normalizeEmail(userData.email) },
          }),
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email-otp') {
          return
        }

        const newSession = ctx.context.newSession
        if (!newSession?.user) {
          return
        }

        const sessionUser = newSession.user
        const isNewUser = (sessionUser as { isNew?: boolean }).isNew ?? true

        if (isNewUser) {
          await database.update(user).set({ isNew: false }).where(eq(user.id, sessionUser.id))
        }

        return ctx.json({
          session: newSession.session,
          user: sessionUser,
        })
      }),
    },
    plugins: [
      bearer(), // Enables Authorization: Bearer <token> for mobile apps where cookies don't work
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        allowedAttempts: 3, // Built-in rate limiting - returns TOO_MANY_ATTEMPTS after exceeded

        async sendVerificationOTP({ email, otp, type }, ctx) {
          // We only support sign-in (no password-based auth, so no email-verification or forget-password)
          if (type !== 'sign-in') {
            console.warn(`Unexpected OTP type requested: ${type}`)
            return
          }

          const normalizedEmail = normalizeEmail(email)

          // Check if user already has an account (existing users bypass waitlist)
          const existingUser = await database
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, normalizedEmail))
            .limit(1)

          // If user doesn't exist, check waitlist status
          if (existingUser.length === 0) {
            const waitlistEntry = await database
              .select({ status: waitlist.status })
              .from(waitlist)
              .where(eq(waitlist.email, normalizedEmail))
              .limit(1)

            // For non-approved users, send appropriate email but don't reveal status
            // (they'll see the OTP screen but won't receive the actual code)
            if (waitlistEntry.length === 0 || waitlistEntry[0].status !== 'approved') {
              console.info('📧 Handling sign-in for non-approved email (sending waitlist email)')

              if (waitlistEntry.length === 0) {
                // Add to waitlist if not already there (helpful UX)
                // Use onConflictDoNothing to handle rare race condition gracefully
                await database
                  .insert(waitlist)
                  .values({
                    id: crypto.randomUUID(),
                    email: normalizedEmail,
                    status: 'pending',
                  })
                  .onConflictDoNothing()
                await sendWaitlistJoinedEmail({ email: normalizedEmail })
              } else {
                // On waitlist but not approved — send a "not ready yet" email
                await sendWaitlistNotReadyEmail({ email: normalizedEmail })
              }

              // Return without sending OTP - user will see OTP screen but won't have the code
              // This prevents revealing whether an email is on the waitlist or not
              return
            }
          }

          const origin = getValidatedOrigin(trustedOrigins, ctx?.request)
          const verifyUrl = buildVerifyUrl(origin, normalizedEmail, otp, ctx?.request)

          await sendSignInEmail({ email: normalizedEmail, otp, verifyUrl })
        },
      }),
    ],
  })

export type Auth = ReturnType<typeof createAuth>
