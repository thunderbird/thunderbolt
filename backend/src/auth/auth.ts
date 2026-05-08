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
import {
  migrateAnonymousUserData,
  assertAnonymousRowCountUnderCap,
  isTransientDbError,
} from '@/dal/anonymous'
import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { normalizeEmail } from '@/lib/email'
import { getSettings } from '@/config/settings'
import { getTrustedIpHeaders } from '@/utils/request'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { anonymous, bearer, emailOTP } from 'better-auth/plugins'
import { sso } from '@better-auth/sso'
import { isAutoApprovedDomain, sendWaitlistJoinedEmail, sendWaitlistNotReadyEmail } from '@/waitlist/utils'
import { challengeTokenHeader, otpExpiryMs, otpExpirySeconds } from './otp-constants'
import { buildVerifyUrl, parseTrustedOrigins, sendSignInEmail } from './utils'
import { eq, sql } from 'drizzle-orm'

const otpSignInPath = '/sign-in/email-otp'

// Retry tuning constants for anonymous promotion (M3).
// Increase ANONYMOUS_PROMOTION_MAX_ATTEMPTS if transient error rates rise above 1%.
const ANONYMOUS_PROMOTION_MAX_ATTEMPTS = 3
const ANONYMOUS_PROMOTION_BACKOFF_MS = 100

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

export const createAuth = async (database: typeof DbType) => {
  const settings = getSettings()
  const parsedOrigins = parseTrustedOrigins(process.env.TRUSTED_ORIGINS)

  // Startup health check (external-4): refuse to boot if the anonymous-user migration hasn't
  // run yet. Prevents the "plugin enabled before migration" deployment hazard where the
  // anonymous plugin is active but the `is_anonymous` column doesn't exist yet.
  // Run migration `bun db migrate` (backend/drizzle/0015_anonymous_user.sql) if this throws.
  const columnCheck = await database.execute<Record<string, unknown>>(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user' AND column_name = 'is_anonymous'
  `)
  // Drizzle returns driver-specific shapes: postgres-js gives a RowList (Array subclass),
  // PGlite gives { rows: Row[] }. Normalize to a row count for the nil check.
  const columnCheckRowCount = Array.isArray(columnCheck)
    ? columnCheck.length
    : (columnCheck as { rows: unknown[] }).rows.length
  if (columnCheckRowCount === 0) {
    throw new Error(
      '[AUTH-INIT] Database is missing the `user.is_anonymous` column. ' +
        'Run pending migrations (`bun db migrate`) before starting the auth module. ' +
        'See backend/drizzle/0015_anonymous_user.sql.',
    )
  }

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
        // (e.g. M4's PowerSync guard) can read it without an extra DB lookup.
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
        // This is external-14: reject /sign-in/anonymous if caller is already authenticated
        // as a non-anonymous user. Anonymous sign-in is intentionally NOT waitlist-gated.
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
      // Anonymous sessions plugin (THU-383).
      //
      // `disableDeleteAnonymousUser: true` is INTENTIONAL and MUST NOT be removed.
      // Reasons:
      //   1. We own the anonymous-user delete ourselves inside `onLinkAccount`'s transaction
      //      so that migration + delete are atomic. Letting the plugin delete outside our tx
      //      would create a window where migration succeeds but anon-user delete fails,
      //      leaving a ghost anon-user record.
      //   2. This flag also disables the `/delete-anonymous-user` endpoint, which removes
      //      an unauthenticated CSRF surface (external-3).
      //
      // Better Auth v1.6.9 library validation (N-1 confirmed):
      // The after-hook for linkAccount reads:
      //   `if (options?.disableDeleteAnonymousUser || isSameUser || newSessionIsAnonymous) return`
      // The disable flag is the FIRST check — no eager `getUser(anonId)` occurs before it.
      // Safe to keep this flag without paying the cost of an extra round-trip.
      anonymous({
        disableDeleteAnonymousUser: true, // We own the in-tx delete — see comment above
        onLinkAccount: async ({ anonymousUser, newUser, ctx }) => {
          let lastError: unknown
          for (let attempt = 0; attempt < ANONYMOUS_PROMOTION_MAX_ATTEMPTS; attempt++) {
            try {
              await database.transaction(async (tx) => {
                // N-3: cap check INSIDE the same tx for snapshot atomicity — must not be
                // moved outside the transaction boundary.
                // Cast tx: Drizzle transactions are structurally compatible with
                // the DB type for DML operations. The M2 DAL types the param as
                // `typeof DbType` (which includes `$client` from the driver instance).
                // Transactions omit `$client`, but all actual query operations work.
                const txDb = tx as unknown as typeof database
                await assertAnonymousRowCountUnderCap(txDb, anonymousUser.user.id, 10000)
                await migrateAnonymousUserData(txDb, anonymousUser.user.id, newUser.user.id)
                // We own the anonymous-user delete (disableDeleteAnonymousUser: true).
                // In-tx so migration + delete are atomic; on rollback both revert.
                await tx.delete(schema.user).where(eq(schema.user.id, anonymousUser.user.id))
              })
              return
            } catch (err) {
              lastError = err
              // DrizzleQueryError wraps the PG error code in err.cause.code, not err.code
              // (M2 discovery). Pass err.cause ?? err so isTransientDbError sees the right shape.
              const cause = (err as { cause?: unknown }).cause ?? err
              if (!isTransientDbError(cause)) break
              await new Promise((r) => setTimeout(r, ANONYMOUS_PROMOTION_BACKOFF_MS * (attempt + 1)))
            }
          }

          // Permanent failure (option c): delete the brand-new real user, rethrow so
          // the client receives an error and the user remains anonymous. They can retry
          // OTP sign-in cleanly — their anonymous session is intact.
          console.error('[ANON-PROMOTE-FAIL]', {
            anonId: anonymousUser.user.id,
            newId: newUser.user.id,
            // Log message only — never log email or other PII here.
            error: lastError instanceof Error ? lastError.message : String(lastError),
          })
          try {
            await ctx.context.internalAdapter.deleteUser(newUser.user.id)
          } catch (cleanupErr) {
            // Both the migration AND the cleanup failed — ops must intervene manually.
            // The new user record is now orphaned; see runbook in docs/architecture/e2e-encryption.md.
            console.error('[ANON-PROMOTE-CATASTROPHIC]', {
              newId: newUser.user.id,
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            })
          }
          throw lastError
        },
      }),
      ...buildSsoPlugins(),
    ],
  })
}

export type Auth = Awaited<ReturnType<typeof createAuth>>
