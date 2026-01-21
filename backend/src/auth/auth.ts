import type { db as DbType } from '@/db/client'
import { user } from '@/db/auth-schema'
import { waitlist } from '@/db/schema'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, emailOTP } from 'better-auth/plugins'
import { and, eq, isNull } from 'drizzle-orm'
import { Resend } from 'resend'
import { buildVerifyUrl, getValidatedOrigin, parseTrustedOrigins, sendSignInEmail } from './utils'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

if (!resend) {
  console.warn('⚠️ RESEND_API_KEY is not set - auth emails will not be sent')
}

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
    }),
    trustedOrigins,
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

          // Check if user already has an account (existing users bypass waitlist)
          const existingUser = await database
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, email.toLowerCase()))
            .limit(1)

          // If user doesn't exist, check waitlist status
          if (existingUser.length === 0) {
            const waitlistEntry = await database
              .select({ status: waitlist.status })
              .from(waitlist)
              .where(and(eq(waitlist.email, email.toLowerCase()), isNull(waitlist.deletedAt)))
              .limit(1)

            // If not on waitlist or not approved, don't send OTP
            // Return silently to not reveal waitlist status
            if (waitlistEntry.length === 0 || waitlistEntry[0].status !== 'approved') {
              console.info(`🚫 Blocked sign-in attempt for non-approved email: ${email}`)
              return
            }
          }

          const origin = getValidatedOrigin(trustedOrigins, ctx?.request)
          const verifyUrl = buildVerifyUrl(origin, email, otp, ctx?.request)

          await sendSignInEmail({
            resend,
            email,
            otp,
            verifyUrl,
            isProduction: process.env.NODE_ENV === 'production',
          })
        },
      }),
    ],
  })

export type Auth = ReturnType<typeof createAuth>
