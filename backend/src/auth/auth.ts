/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  approveWaitlistEntry,
  getOrCreateOtpChallenge,
  createWaitlistEntry,
  consumeOtpChallenge,
  deletePersistedSignInOtp,
  getUserByEmail,
  getWaitlistByEmail,
  passkeyHoldsSyncSlot,
  userHasPasskey,
  markUserNotNew,
  validateOtpChallenge,
} from '@/dal'
import type { db as DbType } from '@/db/client'
import { cliRegistrationPendingDeviceId, isCliGrantSession } from '@/dal/sessions'
import * as schema from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { resolveEmailLocale } from '@/emails/i18n'
import { getPasskeyAndroidOriginsList, getSettings, isPasskeyEnabled, getPasskeyRpName } from '@/config/settings'
import { createRateLimitConsumer, type RateLimitSet } from '@/middleware/rate-limit'
import { extractClientIp, getTrustedIpHeaders, withTrustedClientIp } from '@/utils/request'
import { captchaTokenHeader, captchaVerificationFailedCode } from '@shared/captcha'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { makeSignature } from 'better-auth/crypto'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { anonymous, bearer, deviceAuthorization, emailOTP, type TimeString } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { passkey } from '@better-auth/passkey'
import {
  isAutoApprovedDomain,
  sendWaitlistJoinedEmail as defaultSendWaitlistJoinedEmail,
  sendWaitlistNotReadyEmail as defaultSendWaitlistNotReadyEmail,
} from '@/waitlist/utils'
import { admitsWithoutWaitlist } from '@/identity/admission'
import { apiKeyOwnerHasAccess } from '@/identity/api-key-access'
import { identity } from '@/identity/plugin'
import { buildScimPlugins } from '@/identity/scim/plugin'
import { buildSsoPlugins, isForeignSsoRequest } from '@/identity/sso'
import { isSsoAuthMode } from '@/identity/sso-connections'
import { createCaptchaProvider } from './captcha'
import { anonymousSignInPath, authBasePath, getSessionPath } from './paths'
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

/** The caller fields the passkey before-hook rules need. */
type SessionLookup = {
  user: { id: string; isAnonymous?: boolean | null }
  session: { deviceId?: string | null }
} | null

const samlAcsPath = '/sso/saml2/sp/acs/:providerId'

/**
 * Name each cookie with its RelayState so a browser can hold several pending logins.
 * Over HTTPS, `__Host-` prevents another subdomain from setting the cookie.
 */
const samlLoginCookie = (relayState: string, isHttps: boolean) =>
  `${isHttps ? '__Host-' : ''}thunderbolt_saml_login_${relayState}`

/** The single key of the deployment-wide anonymous sign-in budget: every client shares it. */
const anonymousSignInBudgetKey = 'all'

/** Rate-limit headers as Better Auth's `ctx.error` takes them. */
const toHeaderRecord = (headers: RateLimitSet['headers']) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]))

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
        'which is spoofable without a trusted proxy. Set TRUSTED_PROXY=cloudflare, akamai, or the fixed proxy hop count ' +
        'to ensure rate limiting uses the correct client IP header.',
    )
  }

  const ssoEnabled = isSsoAuthMode(settings)
  const isHttps = settings.betterAuthUrl.startsWith('https://')

  // This before-hook runs ahead of every plugin hook, bearer included, so
  // `getSessionFromCtx` can't see a bearer-only session here. Going through the
  // real `getSession` endpoint runs the full pipeline. Assigned once `auth` exists.
  let resolveSession: (headers: Headers) => Promise<SessionLookup> = async () => null

  const auth = betterAuth({
    basePath: authBasePath,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema,
      // SSO and SCIM refuse to run without native transactions, and the identity plugin's
      // sign-in writes (membership, source, audit event) must commit together.
      transaction: true,
    }),
    trustedOrigins,
    // NOTE: Uses in-memory storage by default — not shared across instances in
    // horizontally-scaled deployments. Provides single-instance defence only. The DB-backed
    // `auth` IP tier holds across instances, and CAPTCHA_PROVIDER=altcha (with an app built with
    // VITE_CAPTCHA_PROVIDER=altcha) is the distributed bot control on anonymous sign-in.
    // `/get-session` is exempt from the `auth` tier (see createAuthPluginIpRateLimit), so the
    // custom rule below is its only limit.
    rateLimit: {
      enabled: settings.rateLimitEnabled,
      window: 60,
      max: 10,
      customRules: {
        [getSessionPath]: { window: 1, max: 30 },
        // Anonymous sign-in is limited only by our DB-backed limiter (createAuthPluginIpRateLimit):
        // a true fixed window, shared across instances and keyed on the TRUSTED_PROXY-resolved IP.
        // Better Auth's limiter resets only after a full idle window and falls back to
        // x-forwarded-for, so steady venue traffic would be refused well under the limit.
        [anonymousSignInPath]: false,
        // SCIM has its own per-connection budget in createScimRequestHandler.
        '/scim/v2/**': false,
      },
    },
    advanced: {
      database: { joins: true },
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
        if (ssoEnabled && (await isForeignSsoRequest(ctx.context.adapter, ctx.path, ctx))) {
          console.warn(`Refused ${ctx.path}: it names no SSO connection of this deployment`)
          throw ctx.error('FORBIDDEN', { message: 'This SSO connection is not available' })
        }

        // Better Auth checks RelayState and InResponseTo against rows shared by all browsers. Require this
        // browser's cookie when RelayState is present. With IdP-initiated login enabled, responses without
        // RelayState remain unbound and retain that mode's documented login-CSRF risk.
        if (ssoEnabled && ctx.path === samlAcsPath && ctx.body?.SAMLResponse) {
          const relayState = ctx.body.RelayState
          const bound =
            typeof relayState === 'string' &&
            relayState !== '' &&
            ctx.getCookie(samlLoginCookie(relayState, isHttps)) !== null
          if (!bound && (relayState || !settings.samlAllowIdpInitiated)) {
            console.warn('Refused a SAML response for a login this browser did not start')
            // Use the plugin's existing landing for an unsolicited response.
            const landing = new URL(settings.appUrl)
            landing.searchParams.set('error', 'unsolicited_response')
            throw ctx.redirect(landing.toString())
          }
        }

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
              code: captchaVerificationFailedCode,
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

        // Passkey management (register/list/update/delete) requires a real account:
        // an anonymous user's credential would bind to a throwaway identity that is
        // deleted on promotion. The two authentication paths stay open — they're how
        // sign-in works and need no session at all.
        if (
          ctx.path.startsWith('/passkey/') &&
          ctx.path !== '/passkey/generate-authenticate-options' &&
          ctx.path !== '/passkey/verify-authentication'
        ) {
          const headers = ctx.headers ?? new Headers()
          const existing = await resolveSession(headers)
          // Every guarded passkey route needs a session. Answering here, rather than leaving it
          // to Better Auth, keeps a member the identity plugin refuses from being authenticated
          // by the route's own internal session lookup, which skips that check.
          if (!existing) {
            throw ctx.error('UNAUTHORIZED')
          }
          if (existing.user.isAnonymous) {
            throw ctx.error('FORBIDDEN', { message: 'Passkeys are not available for anonymous users' })
          }
          // API keys and CLI device grants are delegated, non-interactive
          // credentials; letting one register a passkey would turn it into a
          // permanent interactive sign-in that outlives the key.
          if (headers.has('x-api-key') || isCliGrantSession(existing.session.deviceId)) {
            throw ctx.error('FORBIDDEN', { message: 'Passkeys need an interactive session' })
          }
          // One passkey per account — it is also the account's single E2EE
          // passkey slot. The unique index on passkey.user_id backs this up.
          const isRegistration =
            ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration'
          if (isRegistration && (await userHasPasskey(database, existing.user.id))) {
            throw ctx.error('CONFLICT', { message: 'This account already has a passkey' })
          }
          // A passkey holding the sync slot can still unlock the AK, so deleting
          // its row first would leave a working slot nobody can see or remove.
          // The client clears the slot with an AK rotation, then deletes. This
          // gives a clear error; the slot's foreign key also covers a racing enroll.
          const passkeyId = (ctx.body as { id?: string } | undefined)?.id
          if (
            ctx.path === '/passkey/delete-passkey' &&
            passkeyId &&
            (await passkeyHoldsSyncSlot(database, existing.user.id, passkeyId))
          ) {
            throw ctx.error('CONFLICT', { message: 'Remove this passkey from sync before deleting it' })
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
        if (!existingUser && !(await admitsWithoutWaitlist(database, normalizedEmail))) {
          const waitlistEntry = await getWaitlistByEmail(database, normalizedEmail)
          if (!waitlistEntry || waitlistEntry.status !== 'approved') {
            throw ctx.error('UNAUTHORIZED', { message: 'Sign-in not available' })
          }
        }

        // Token stays valid for remaining attempts. Cleaned up on successful sign-in
        // (after hook) or by expiry. This allows the 3-attempt limit to work correctly.
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ssoEnabled && ctx.path === '/sign-in/sso') {
          const url = (ctx.context.returned as { url?: string } | undefined)?.url
          const relayState = url && new URL(url).searchParams.get('RelayState')
          if (relayState) {
            // Set directly to keep it host-only; createAuthCookie can add Domain. Cross-site ACS POSTs
            // need SameSite=None over HTTPS. Match the plugin's five-minute requestTTL.
            ctx.setCookie(samlLoginCookie(relayState, isHttps), '1', {
              path: '/',
              httpOnly: true,
              maxAge: 300,
              ...(isHttps ? { secure: true, sameSite: 'none' } : { sameSite: 'lax' }),
            })
          }
          return
        }

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
        const challengeToken = ctx.headers?.get(challengeTokenHeader)
        if (email && challengeToken) {
          await consumeOtpChallenge(database, normalizeEmail(email), challengeToken)
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
      identity(),
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

          // Existing users bypass waitlist entirely, and so does an address another admission
          // path will let in at sign-in.
          const existingUser = await getUserByEmail(database, normalizedEmail)

          if (!existingUser && !(await admitsWithoutWaitlist(database, normalizedEmail))) {
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
        customAPIKeyValidator: apiKeyOwnerHasAccess,
        keyExpiration: { defaultExpiresIn: settings.apiKeyDefaultExpiresInSeconds },
        rateLimit: { enabled: false },
      }),
      // Changing the RP ID orphans every registered passkey. `origin` comes from
      // the trusted-origins list plus the Android app's signing-key origins, never
      // the request's Origin header. The challenge
      // rides a signed cookie, which `elysia-plugin.ts` relays through the
      // `X-Passkey-Challenge` header.
      ...(isPasskeyEnabled(settings)
        ? [
            passkey({
              rpID: settings.passkeyRpId,
              rpName: getPasskeyRpName(settings),
              origin: [...trustedOrigins, ...getPasskeyAndroidOriginsList(settings)],
            }),
          ]
        : []),
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
      ...buildSsoPlugins(settings),
      ...buildScimPlugins(settings),
    ],
  })

  resolveSession = (headers) => auth.api.getSession({ headers, query: { disableRefresh: true } })

  // Better Auth exposes its request handler under two names. Both get the resolved client IP,
  // so no caller can reach it with a client-supplied one.
  const handler = (request: Request) => auth.handler(withTrustedClientIp(request, settings.trustedProxy))
  return { ...auth, handler, fetch: handler }
}

export type Auth = ReturnType<typeof createAuth>
