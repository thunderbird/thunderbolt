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
import { cliRegistrationPendingDeviceId } from '@/dal/sessions'
import * as schema from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { resolveEmailLocale } from '@/emails/i18n'
import { getSettings } from '@/config/settings'
import { createRateLimitConsumer, type RateLimitSet } from '@/middleware/rate-limit'
import { extractClientIp, getTrustedIpHeaders } from '@/utils/request'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { betterAuth, type User } from 'better-auth'
import { makeSignature } from 'better-auth/crypto'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { anonymous, bearer, deviceAuthorization, emailOTP, type TimeString } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { computeDiscoveryUrl, sso, type SSOOptions } from '@better-auth/sso'
import {
  isAutoApprovedDomain,
  sendWaitlistJoinedEmail as defaultSendWaitlistJoinedEmail,
  sendWaitlistNotReadyEmail as defaultSendWaitlistNotReadyEmail,
} from '@/waitlist/utils'
import { captchaTokenHeader, createCaptchaProvider } from './captcha'
import { anonymousSignInPath, authBasePath } from './paths'
import { challengeTokenHeader, otpExpiryMs, otpExpirySeconds, testSignInOtp } from './otp-constants'
import { buildVerifyUrl, parseTrustedOrigins, sendSignInEmail as defaultSendSignInEmail } from './utils'
import { eq } from 'drizzle-orm'

/**
 * Email and sign-in code dependencies for `createAuth`. Tests can inject mocks here
 * instead of using `mock.module()` (which leaks across files in the same worker).
 */
export type AuthEmailDeps = {
  generateSignInOtp?: () => string
  sendSignInEmail?: typeof defaultSendSignInEmail
  sendWaitlistJoinedEmail?: typeof defaultSendWaitlistJoinedEmail
  sendWaitlistNotReadyEmail?: typeof defaultSendWaitlistNotReadyEmail
}

/** Prefer injection, then the fixed test code; otherwise retain Better Auth's random generator. */
export const signInOtpOptions = ({
  generateSignInOtp,
  nodeEnv,
}: {
  generateSignInOtp?: () => string
  nodeEnv: string | undefined
}) => {
  if (generateSignInOtp) {
    return { generateOTP: generateSignInOtp }
  }
  if (nodeEnv !== 'test') {
    return {}
  }
  return { generateOTP: () => testSignInOtp }
}

const otpSignInPath = '/sign-in/email-otp'
const deviceTokenPath = '/device/token'
const authTokenHeader = 'set-auth-token'

/**
 * Signs an SSO identity into the existing user with the same verified email. We trust the
 * operator's env-configured IdP once Better Auth has checked the SAML signature or OIDC
 * id_token, never its `email_verified` claim. See backend/docs/authentication.md.
 */
const linkSsoToVerifiedEmailOwner: NonNullable<SSOOptions['resolveUser']> = async ({ providerUser }, { database }) => {
  const existing = await database.findOne<User>({
    model: 'user',
    where: [{ field: 'email', value: normalizeEmail(providerUser.email) }],
  })
  return existing?.emailVerified ? { action: 'link', userId: existing.id, profile: 'preserve' } : { action: 'continue' }
}

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
        // A falsy limit makes /sso/register answer 403, so only the env-configured provider exists.
        providersLimit: 0,
        defaultSSO: [
          {
            providerId: 'sso',
            domain: new URL(settings.betterAuthUrl).host,
            oidcConfig: {
              issuer: settings.oidcIssuer,
              pkce: true,
              clientId: settings.oidcClientId,
              clientSecret: settings.oidcClientSecret,
              // Better Auth's own helper rather than string concatenation: it strips a
              // trailing slash from the issuer, as OIDC Discovery requires. Concatenating
              // produced a double slash and a 404 for the providers that publish issuer
              // URLs that way (Authentik among them).
              discoveryEndpoint: settings.oidcDiscoveryUrl || computeDiscoveryUrl(settings.oidcIssuer),
              scopes: ['openid', 'profile', 'email'],
            },
          },
        ],
        resolveUser: linkSsoToVerifiedEmailOwner,
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
        // A falsy limit makes /sso/register answer 403, so only the env-configured provider exists.
        providersLimit: 0,
        defaultSSO: [
          {
            providerId: 'sso',
            domain: new URL(settings.betterAuthUrl).host,
            samlConfig: {
              // `issuer` names our service provider; the IdP is identified by idpMetadata.entityID.
              issuer: settings.samlEntityId,
              entryPoint: settings.samlEntryPoint,
              cert: settings.samlCert,
              idpMetadata: {
                entityID: settings.samlIdpIssuer,
              },
            },
          },
        ],
        resolveUser: linkSsoToVerifiedEmailOwner,
      }),
    ]
  }

  return []
}

/** The single key of the deployment-wide anonymous sign-in budget: every client shares it. */
const anonymousSignInBudgetKey = 'all'

/** Rate-limit headers as Better Auth's `ctx.error` takes them. */
const toHeaderRecord = (headers: RateLimitSet['headers']) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]))

export const createAuth = (database: typeof DbType, emailDeps: AuthEmailDeps = {}) => {
  const settings = getSettings()
  const parsedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)
  const sendSignInEmail = emailDeps.sendSignInEmail ?? defaultSendSignInEmail
  const sendWaitlistJoinedEmail = emailDeps.sendWaitlistJoinedEmail ?? defaultSendWaitlistJoinedEmail
  const sendWaitlistNotReadyEmail = emailDeps.sendWaitlistNotReadyEmail ?? defaultSendWaitlistNotReadyEmail
  const captchaProvider = createCaptchaProvider(settings, database)
  // Deployment-wide anonymous sign-in budget: one bucket every client shares. Charged in the
  // before-hook only once a sign-in has passed the captcha, so unsolved attempts cannot drain
  // it; the per-IP bucket runs earlier, in the Elysia limiter around the mount.
  const anonymousSignInBudget = settings.authAllowAnonymous
    ? createRateLimitConsumer(database, { enabled: settings.rateLimitEnabled }, 'anonymous-sign-in-global', {
        max: settings.anonymousSignInGlobalRateLimitMax,
        durationSecs: settings.anonymousSignInGlobalRateLimitWindowSecs,
      })
    : null

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

  const ssoEnabled = settings.authMode === 'oidc' || settings.authMode === 'saml'

  return betterAuth({
    basePath: authBasePath,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
      // The SSO plugin's resolveUser hook refuses to run without native transactions.
      transaction: ssoEnabled,
    }),
    trustedOrigins,
    // NOTE: Uses in-memory storage by default — not shared across instances in
    // horizontally-scaled deployments. Provides single-instance defence only. Today this
    // limiter and the DB-backed `auth` IP tier are the controls; the captcha on anonymous
    // sign-in (CAPTCHA_PROVIDER) will be the distributed bot control once the app supports
    // ALTCHA.
    rateLimit: {
      enabled: settings.rateLimitEnabled,
      window: 60,
      max: 10,
      customRules: {
        '/get-session': { window: 1, max: 30 },
        // Anonymous sign-in is limited only by our DB-backed limiter (createAuthPluginIpRateLimit):
        // a true fixed window, shared across instances and keyed on the TRUSTED_PROXY-resolved IP.
        // Better Auth's limiter resets only after a full idle window and falls back to
        // x-forwarded-for, so steady venue traffic would be refused well under the limit.
        [anonymousSignInPath]: false,
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
          // synthetic anonymous emails (`{generateId()}@anonymous.placeholder.invalid`). No guard needed.
          before: async (userData) => ({
            data: { ...userData, email: normalizeEmail(userData.email) },
          }),
        },
      },
      session: {
        create: {
          before: async (sessionData, context) =>
            context?.path === deviceTokenPath
              ? { data: { ...sessionData, deviceId: cliRegistrationPendingDeviceId } }
              : undefined,
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Guard: prevent session fixation. A real (non-anonymous) user MUST NOT be
        // able to acquire a new anonymous session that could shadow their real session.
        // Reject /sign-in/anonymous if caller is already authenticated as a non-anonymous
        // user. Anonymous sign-in is intentionally NOT waitlist-gated.
        if (ctx.path === anonymousSignInPath) {
          // Better Auth's hook context exposes no socket address, so only a trusted proxy
          // header can identify the client here.
          const headers = ctx.headers ?? new Headers()
          const captchaSolved = await captchaProvider.verify(headers.get(captchaTokenHeader), {
            clientIp: extractClientIp(headers, 'unknown', settings.trustedProxy),
          })
          if (!captchaSolved) {
            throw ctx.error('FORBIDDEN', {
              message: 'Captcha verification failed',
              code: 'CAPTCHA_VERIFICATION_FAILED',
            })
          }
          const existing = await getSessionFromCtx(ctx, { disableRefresh: true })
          if (existing?.user && (existing.user as { isAnonymous?: boolean }).isAnonymous !== true) {
            throw ctx.error('BAD_REQUEST', { message: 'Already authenticated' })
          }
          if (anonymousSignInBudget) {
            const set: RateLimitSet = { headers: {} }
            const rejected = await anonymousSignInBudget(anonymousSignInBudgetKey, set)
            if (rejected) {
              throw ctx.error('TOO_MANY_REQUESTS', { message: rejected.error }, toHeaderRecord(set.headers))
            }
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
        ...signInOtpOptions({ generateSignInOtp: emailDeps.generateSignInOtp, nodeEnv: process.env.NODE_ENV }),
        otpLength: 8,
        expiresIn: otpExpirySeconds,
        allowedAttempts: 3, // Built-in rate limiting - returns TOO_MANY_ATTEMPTS after exceeded
        resendStrategy: 'reuse', // Preserves attempt counter on resend (prevents reset-by-resend attack).
        // Defense-in-depth: 8-digit OTP (100M keyspace) + 3 attempts + 15s cooldown between
        // code requests + session binding (challenge token) make brute-force infeasible.

        async sendVerificationOTP({ email, otp, type }, ctx) {
          // We only support sign-in (no password-based auth, so no email-verification or forget-password)
          if (type !== 'sign-in') {
            console.warn(`Unexpected OTP type requested: ${type}`)
            return
          }

          const normalizedEmail = normalizeEmail(email)
          // Better Auth hands this callback the endpoint context, so the
          // recipient's own `X-App-Language` is still in reach even though the
          // send happens below the route handler. `getHeader` reads better-call's
          // normalized view, which covers both the `headers` and `request` call
          // shapes. Server-side callers (`auth.api.sendVerificationOTP`) must
          // pass the header explicitly or this falls back to English — see
          // `@/waitlist/routes`.
          const locale = resolveEmailLocale(ctx?.getHeader('X-App-Language'))

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
                await sendWaitlistJoinedEmail({ email: normalizedEmail, locale })
                await deletePersistedSignInOtp(database, normalizedEmail)
                return
              }
            } else if (waitlistEntry.status !== 'approved') {
              if (autoApproved) {
                await approveWaitlistEntry(database, waitlistEntry.id)
              } else {
                console.info('Handling sign-in for non-approved email (sending waitlist email)')
                await sendWaitlistNotReadyEmail({ email: normalizedEmail, locale })
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

          await sendSignInEmail({ email: normalizedEmail, otp, verifyUrl, locale })
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
