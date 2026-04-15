import {
  approveWaitlistEntry,
  getOrCreateOtpChallenge,
  createWaitlistEntry,
  deleteOtpChallengesForEmail,
  getUserByEmail,
  getWaitlistByEmail,
  markUserNotNew,
  validateOtpChallenge,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { eq, like } from 'drizzle-orm'
import { normalizeEmail } from '@/lib/email'
import { getSettings } from '@/config/settings'
import { getTrustedIpHeaders } from '@/utils/request'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, emailOTP } from 'better-auth/plugins'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { isAutoApprovedDomain, sendWaitlistJoinedEmail, sendWaitlistNotReadyEmail } from '@/waitlist/utils'
import { challengeTokenHeader, otpExpiryMs, otpExpirySeconds } from './otp-constants'
import { buildVerifyUrl, getValidatedOrigin, parseTrustedOrigins, sendSignInEmail } from './utils'

const OTP_SIGN_IN_PATH = '/sign-in/email-otp'

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

export const createAuth = (database: typeof DbType) => {
  const settings = getSettings()

  if (!settings.trustedProxy && process.env.NODE_ENV === 'production') {
    console.warn(
      'TRUSTED_PROXY is not set. Better Auth rate limiting will use x-forwarded-for ' +
        'which is spoofable without a trusted proxy. Set TRUSTED_PROXY=cloudflare (or akamai) ' +
        'to ensure rate limiting uses the correct client IP header.',
    )
  }

  return betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
    }),
    trustedOrigins,
    // NOTE: Uses in-memory storage by default — not shared across instances in
    // horizontally-scaled deployments. Provides single-instance defence only.
    // TODO(THU-113): Replace with proof-of-work challenge (ALTCHA) for distributed protection.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: getTrustedIpHeaders(settings.trustedProxy),
      },
    },
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
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== OTP_SIGN_IN_PATH) {
          return
        }

        const challengeToken = ctx.headers?.get(challengeTokenHeader)
        const rawEmail = (ctx.body as { email?: string })?.email

        if (!challengeToken || !rawEmail) {
          throw ctx.error('UNAUTHORIZED', { message: 'Challenge token required' })
        }

        const normalizedEmail = normalizeEmail(rawEmail)

        const valid = await validateOtpChallenge(database, normalizedEmail, challengeToken)
        if (!valid) {
          throw ctx.error('UNAUTHORIZED', { message: 'Invalid challenge token' })
        }

        // Block sign-in for non-approved waitlist users (defense-in-depth).
        // Even if a challenge token was somehow obtained, pending users cannot sign in.
        const existingUser = await getUserByEmail(database, normalizedEmail)
        if (!existingUser) {
          const waitlistEntry = await getWaitlistByEmail(database, normalizedEmail)
          if (!waitlistEntry || waitlistEntry.status !== 'approved') {
            throw ctx.error('UNAUTHORIZED', { message: 'Not approved' })
          }
        }

        // Token stays valid for remaining attempts. Cleaned up on successful sign-in
        // (after hook) or by expiry. This allows the 3-attempt limit to work correctly.
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== OTP_SIGN_IN_PATH) {
          return
        }

        const newSession = ctx.context.newSession
        if (!newSession?.user) {
          return
        }

        const email = (ctx.body as { email?: string })?.email
        if (email) {
          await deleteOtpChallengesForEmail(database, normalizeEmail(email))
        }

        const sessionUser = newSession.user
        const isNewUser = (sessionUser as { isNew?: boolean }).isNew ?? true

        if (isNewUser) {
          await markUserNotNew(database, sessionUser.id)
        }

        return ctx.json({
          session: newSession.session,
          user: sessionUser,
        })
      }),
    },
    plugins: [
      bearer({ requireSignature: true }), // Enables Authorization: Bearer <token> for mobile apps where cookies don't work
      emailOTP({
        otpLength: 8,
        expiresIn: otpExpirySeconds,
        allowedAttempts: 3, // Built-in rate limiting - returns TOO_MANY_ATTEMPTS after exceeded
        resendStrategy: 'reuse', // Preserves attempt counter on resend (prevents reset-by-resend attack).
        // Defense-in-depth: 8-digit OTP (100M keyspace) + 3 attempts + 15s cooldown between
        // code requests + session binding (challenge token) make brute-force infeasible.
        // TODO(THU-113): proof-of-work (ALTCHA) will add further distributed protection.

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
                // Clean up the OTP that Better Auth already persisted (it generates before calling this callback)
                await database
                  .delete(schema.verification)
                  .where(like(schema.verification.identifier, `%${normalizedEmail}%`))
                return
              }
            } else if (waitlistEntry.status !== 'approved') {
              if (autoApproved) {
                await approveWaitlistEntry(database, waitlistEntry.id)
              } else {
                console.info('Handling sign-in for non-approved email (sending waitlist email)')
                await sendWaitlistNotReadyEmail({ email: normalizedEmail })
                // Clean up the OTP that Better Auth already persisted (it generates before calling this callback)
                await database
                  .delete(schema.verification)
                  .where(like(schema.verification.identifier, `%${normalizedEmail}%`))
                return
              }
            }
          }

          const origin = getValidatedOrigin(trustedOrigins, ctx?.request)
          // First-writer-wins: reuses existing challenge if /waitlist/join already
          // created one, or creates on-demand for Better Auth's native send-OTP endpoint.
          const challengeToken = await getOrCreateOtpChallenge(database, {
            id: crypto.randomUUID(),
            email: normalizedEmail,
            challengeToken: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + otpExpiryMs),
          })
          const verifyUrl = buildVerifyUrl(origin, normalizedEmail, otp, ctx?.request, challengeToken)

          await sendSignInEmail({ email: normalizedEmail, otp, verifyUrl })
        },
      }),
      ...buildOidcPlugins(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
