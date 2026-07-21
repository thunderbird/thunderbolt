/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  approveWaitlistEntry,
  getOrCreateOtpChallenge,
  createWaitlistEntry,
  deleteOtpChallengesForEmail,
  deletePersistedSignInOtp,
  getUserByEmail,
  getWaitlistByEmail,
  markUserNotNew,
  validateOtpChallenge,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { getSettings } from '@/config/settings'
import { getTrustedIpHeaders } from '@/utils/request'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { makeSignature } from 'better-auth/crypto'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { anonymous, bearer, deviceAuthorization, emailOTP, type TimeString } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { sso } from '@better-auth/sso'
import {
  isAutoApprovedDomain,
  sendWaitlistJoinedEmail as defaultSendWaitlistJoinedEmail,
  sendWaitlistNotReadyEmail as defaultSendWaitlistNotReadyEmail,
} from '@/waitlist/utils'
import { challengeTokenHeader, otpExpiryMs, otpExpirySeconds } from './otp-constants'
import { buildVerifyUrl, parseTrustedOrigins, sendSignInEmail as defaultSendSignInEmail } from './utils'
import { eq } from 'drizzle-orm'

/**
 * Email-sending dependencies for `createAuth`. Tests can inject mocks here
 * instead of using `mock.module()` (which leaks across files in the same worker).
 */
export type AuthEmailDeps = {
  sendSignInEmail?: typeof defaultSendSignInEmail
  sendWaitlistJoinedEmail?: typeof defaultSendWaitlistJoinedEmail
  sendWaitlistNotReadyEmail?: typeof defaultSendWaitlistNotReadyEmail
}

const otpSignInPath = '/sign-in/email-otp'
const deviceTokenPath = '/device/token'
const authTokenHeader = 'set-auth-token'

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
const buildSsoPlugins = () => {
  const settings = getSettings()

  if (settings.authMode === 'oidc') {
    if (!settings.oidcIssuer || !settings.oidcClientId || !settings.oidcClientSecret) {
      throw new Error(
        'OIDC is enabled (AUTH_MODE=oidc) but one or more required env vars are missing: ' +
          'OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET. Set all three to configure OIDC authentication.',
      )
    }

    return [
      sso({
        defaultSSO: [
          {
            providerId: 'sso',
            domain: new URL(settings.betterAuthUrl).host,
            oidcConfig: {
              issuer: settings.oidcIssuer,
              pkce: true,
              clientId: settings.oidcClientId,
              clientSecret: settings.oidcClientSecret,
              discoveryEndpoint: settings.oidcDiscoveryUrl || `${settings.oidcIssuer}/.well-known/openid-configuration`,
              scopes: ['openid', 'profile', 'email'],
            },
          },
        ],
      }),
    ]
  }

  if (settings.authMode === 'saml') {
    if (!settings.samlEntryPoint || !settings.samlCert || !settings.samlEntityId || !settings.samlIdpIssuer) {
      throw new Error(
        'SAML is enabled (AUTH_MODE=saml) but one or more required env vars are missing: ' +
          'SAML_ENTRY_POINT, SAML_CERT, SAML_ENTITY_ID, SAML_IDP_ISSUER. Set all four to configure SAML authentication.',
      )
    }

    return [
      sso({
        defaultSSO: [
          {
            providerId: 'sso',
            domain: new URL(settings.betterAuthUrl).host,
            samlConfig: {
              issuer: settings.samlIdpIssuer,
              entryPoint: settings.samlEntryPoint,
              cert: settings.samlCert,
              callbackUrl: `${settings.betterAuthUrl}/v1/api/auth/sso/saml2/sp/acs/sso`,
              spMetadata: {
                entityID: settings.samlEntityId,
              },
            },
          },
        ],
      }),
    ]
  }

  return []
}

export const createAuth = (database: typeof DbType, emailDeps: AuthEmailDeps = {}) => {
  const settings = getSettings()
  const parsedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)
  const sendSignInEmail = emailDeps.sendSignInEmail ?? defaultSendSignInEmail
  const sendWaitlistJoinedEmail = emailDeps.sendWaitlistJoinedEmail ?? defaultSendWaitlistJoinedEmail
  const sendWaitlistNotReadyEmail = emailDeps.sendWaitlistNotReadyEmail ?? defaultSendWaitlistNotReadyEmail

  // Include the backend's own origin so the SSO desktop-callback can be used as callbackURL.
  // Spread to avoid mutating the shared default array returned by parseTrustedOrigins.
  const backendOrigin = new URL(settings.betterAuthUrl).origin
  const trustedOrigins = parsedOrigins.includes(backendOrigin) ? parsedOrigins : [...parsedOrigins, backendOrigin]

  if (!settings.trustedProxy && process.env.NODE_ENV === 'production') {
    console.warn(
      'TRUSTED_PROXY is not set. Better Auth rate limiting will use x-forwarded-for ' +
        'which is spoofable without a trusted proxy. Set TRUSTED_PROXY=cloudflare (or akamai) ' +
        'to ensure rate limiting uses the correct client IP header.',
    )
  }

  // The IdP is operator-controlled in self-hosted enterprise deployments, so we trust the
  // 'sso' provider for account linking. Without this, Better Auth blocks linking an SSO
  // account to an existing user record with the same email — causing the SSO callback to
  // fail with "account not linked" for any user record that wasn't originally created via
  // the same SSO flow. Replaces the deprecated `trustEmailVerified` SSO plugin option, and
  // makes trust explicit in operator config rather than depending on the IdP's
  // `email_verified` claim.
  const ssoEnabled = settings.authMode === 'oidc' || settings.authMode === 'saml'

  return betterAuth({
    basePath: '/v1/api/auth',
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
    }),
    trustedOrigins,
    ...(ssoEnabled && {
      account: {
        accountLinking: {
          trustedProviders: ['sso'],
        },
      },
    }),
    // NOTE: Uses in-memory storage by default — not shared across instances in
    // horizontally-scaled deployments. Provides single-instance defence only.
    // TODO(THU-113): Replace with proof-of-work challenge (ALTCHA) for distributed protection.
    rateLimit: {
      enabled: settings.rateLimitEnabled,
      window: 60,
      max: 10,
      customRules: {
        '/get-session': { window: 1, max: 30 },
      },
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
        // Exposes isAnonymous on the session user object so downstream consumers
        // (e.g. the PowerSync route guard) can read it without an extra DB lookup.
        isAnonymous: {
          type: 'boolean',
          required: false,
          defaultValue: false,
        },
      },
    },
    session: {
      additionalFields: {
        deviceId: {
          type: 'string',
          required: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // normalizeEmail is .toLowerCase().trim() — idempotent on Better Auth's
          // synthetic anonymous emails (`temp@{generateId()}.com`). No guard needed.
          before: async (userData) => ({
            data: { ...userData, email: normalizeEmail(userData.email) },
          }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Guard: prevent session fixation. A real (non-anonymous) user MUST NOT be
        // able to acquire a new anonymous session that could shadow their real session.
        // Reject /sign-in/anonymous if caller is already authenticated as a non-anonymous
        // user. Anonymous sign-in is intentionally NOT waitlist-gated.
        if (ctx.path === '/sign-in/anonymous') {
          const existing = await getSessionFromCtx(ctx, { disableRefresh: true })
          if (existing?.user && (existing.user as { isAnonymous?: boolean }).isAnonymous !== true) {
            throw ctx.error('BAD_REQUEST', { message: 'Already authenticated' })
          }
          return
        }

        if (ctx.path !== otpSignInPath) {
          // Anonymous sign-in (above) is intentionally NOT waitlist-gated — that's the feature.
          // All other non-OTP paths are also unchecked here.
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
            throw ctx.error('UNAUTHORIZED', { message: 'Sign-in not available' })
          }
        }

        // Token stays valid for remaining attempts. Cleaned up on successful sign-in
        // (after hook) or by expiry. This allows the 3-attempt limit to work correctly.
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === deviceTokenPath) {
          const sessionToken = ctx.context.newSession?.session.token
          if (!sessionToken) {
            return
          }

          // Device authorization creates a session without setting its cookie, so the bearer
          // plugin cannot expose the signed cookie value through its normal after-hook.
          const signedToken = `${sessionToken}.${await makeSignature(sessionToken, ctx.context.secret)}`
          const exposedHeaders = ctx.context.responseHeaders?.get('access-control-expose-headers') ?? ''
          const headersSet = new Set(
            exposedHeaders
              .split(',')
              .map((header) => header.trim())
              .filter(Boolean),
          )
          headersSet.add(authTokenHeader)
          ctx.setHeader(authTokenHeader, signedToken)
          ctx.setHeader('Access-Control-Expose-Headers', Array.from(headersSet).join(', '))
          return
        }

        if (ctx.path !== otpSignInPath) {
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

        async sendVerificationOTP({ email, otp, type }) {
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
                await deletePersistedSignInOtp(database, normalizedEmail)
                return
              }
            } else if (waitlistEntry.status !== 'approved') {
              if (autoApproved) {
                await approveWaitlistEntry(database, waitlistEntry.id)
              } else {
                console.info('Handling sign-in for non-approved email (sending waitlist email)')
                await sendWaitlistNotReadyEmail({ email: normalizedEmail })
                await deletePersistedSignInOtp(database, normalizedEmail)
                return
              }
            }
          }

          // First-writer-wins: reuses existing challenge if /waitlist/join already
          // created one, or creates on-demand for Better Auth's native send-OTP endpoint.
          const challengeToken = await getOrCreateOtpChallenge(database, {
            id: crypto.randomUUID(),
            email: normalizedEmail,
            challengeToken: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + otpExpiryMs),
          })
          const verifyUrl = buildVerifyUrl(settings.appUrl, normalizedEmail, otp, challengeToken)

          await sendSignInEmail({ email: normalizedEmail, otp, verifyUrl })
        },
      }),
      // Device Authorization Grant (RFC 8628) — lets the headless `thunderbolt` CLI log in:
      // it requests a device+user code, the user approves at `${appUrl}/device`, then polls
      // /device/token, which returns the account's session token as `access_token`. Turning
      // that into a credential the CLI can replay (this stack runs bearer with requireSignature,
      // so the raw token is not directly usable as `Authorization: Bearer`) is the CLI-login
      // phase's job. verificationUri is derived from appUrl so self-hosters point their own
      // frontend without any hardcoded host.
      deviceAuthorization({
        // Settings validation enforces the time-string format; casts only narrow the
        // Zod-inferred string to Better Auth's template literal type.
        expiresIn: settings.deviceAuthExpiresIn as TimeString,
        interval: settings.deviceAuthInterval as TimeString,
        verificationUri: `${settings.appUrl}/device`,
      }),
      // API keys (PATs) for zero-human CI / self-host. enableSessionForAPIKeys mocks a session
      // for the key's owner when an `x-api-key` header is present, so a key authenticates as the
      // account that created it — the escape hatch when the interactive device grant can't run.
      // The plugin's per-key rate limit defaults to 10 requests/day, which is unusable for
      // automation; disable it and rely on the account/IP-level limits already in this stack.
      // A leaked PAT is mitigated by expiry and revoking the key (same posture as a
      // compromised device). Installed plugin runtime interprets defaultExpiresIn as seconds.
      apiKey({
        enableSessionForAPIKeys: true,
        keyExpiration: { defaultExpiresIn: settings.apiKeyDefaultExpiresInSeconds },
        rateLimit: { enabled: false },
      }),
      // Anonymous plugin is operator-gated: register only when AUTH_ALLOW_ANONYMOUS=true.
      // Otherwise /v1/api/auth/sign-in/anonymous returns 404 — defense-in-depth against
      // a malicious client bypassing the frontend `VITE_AUTH_ENABLE_ANONYMOUS` overlay.
      ...(settings.authAllowAnonymous
        ? [
            anonymous({
              // Disables Better Auth's auto-delete + `/delete-anonymous-user` endpoint — the
              // latter is an unauthenticated CSRF surface. We own the delete in onLinkAccount
              // instead so the endpoint stays closed.
              disableDeleteAnonymousUser: true,
              onLinkAccount: async ({ anonymousUser }) => {
                await database.delete(schema.user).where(eq(schema.user.id, anonymousUser.user.id))
              },
            }),
          ]
        : []),
      ...buildSsoPlugins(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
