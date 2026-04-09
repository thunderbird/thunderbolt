import { approveWaitlistEntry, createWaitlistEntry, getUserByEmail, getWaitlistByEmail, markUserNotNew } from '@/dal'
import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { getSettings } from '@/config/settings'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, emailOTP } from 'better-auth/plugins'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { isAutoApprovedDomain, sendWaitlistJoinedEmail, sendWaitlistNotReadyEmail } from '@/waitlist/utils'
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
const buildOidcPlugins = () => {
  const settings = getSettings()

  if (settings.authMode !== 'oidc') {
    return []
  }

  if (!settings.oidcIssuer || !settings.oidcClientId || !settings.oidcClientSecret) {
    throw new Error(
      'OIDC is enabled (AUTH_MODE=oidc) but one or more required env vars are missing: ' +
        'OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET. Set all three to configure OIDC authentication.',
    )
  }

  return [
    genericOAuth({
      config: [
        {
          providerId: 'oidc',
          discoveryUrl: `${settings.oidcIssuer}/.well-known/openid-configuration`,
          clientId: settings.oidcClientId,
          clientSecret: settings.oidcClientSecret,
          scopes: ['openid', 'profile', 'email'],
          redirectURI: `${settings.betterAuthUrl}/v1/api/auth/oauth2/callback/oidc`,
          pkce: true,
        },
      ],
    }),
  ]
}

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
        // Defense-in-depth: strip session tokens so a CORS misconfiguration can't leak portable bearer credentials.
        // The frontend acquires tokens via the set-auth-token response header, not from JSON bodies.
        if (ctx.path === '/get-session') {
          const body = ctx.context.returned as { session?: Record<string, unknown> } | null
          if (body?.session?.token !== undefined) {
            const { token: _, ...session } = body.session
            return ctx.json({ ...body, session })
          }
        }
        if (ctx.path === '/list-sessions' && Array.isArray(ctx.context.returned)) {
          return ctx.json(
            (ctx.context.returned as Record<string, unknown>[]).map(({ token: _, ...session }) => session),
          )
        }

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
          await markUserNotNew(database, sessionUser.id)
        }

        const { token: _, ...sessionWithoutToken } = newSession.session as Record<string, unknown>
        return ctx.json({
          session: sessionWithoutToken,
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

          // Existing users bypass waitlist entirely
          const existingUser = await getUserByEmail(database, normalizedEmail)

          if (!existingUser) {
            const waitlistEntry = await getWaitlistByEmail(database, normalizedEmail)
            const autoApproved = isAutoApprovedDomain(normalizedEmail)

            if (!waitlistEntry) {
              await createWaitlistEntry(database, {
                id: crypto.randomUUID(),
                email: normalizedEmail,
                status: autoApproved ? 'approved' : 'pending',
              })
              if (!autoApproved) {
                await sendWaitlistJoinedEmail({ email: normalizedEmail })
                return
              }
            } else if (waitlistEntry.status !== 'approved') {
              if (autoApproved) {
                await approveWaitlistEntry(database, waitlistEntry.id)
              } else {
                console.info('Handling sign-in for non-approved email (sending waitlist email)')
                await sendWaitlistNotReadyEmail({ email: normalizedEmail })
                return
              }
            }
          }

          const origin = getValidatedOrigin(trustedOrigins, ctx?.request)
          const verifyUrl = buildVerifyUrl(origin, normalizedEmail, otp, ctx?.request)

          await sendSignInEmail({ email: normalizedEmail, otp, verifyUrl })
        },
      }),
      ...buildOidcPlugins(),
    ],
  })

export type Auth = ReturnType<typeof createAuth>
