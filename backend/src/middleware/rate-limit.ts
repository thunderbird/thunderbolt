/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { anonymousSignInPath, authBasePath, getSessionPath } from '@/auth/paths'
import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { extractClientIp, type TrustedProxy } from '@/utils/request'
import { Elysia } from 'elysia'
import { type RateLimiterAbstract, RateLimiterDrizzle, RateLimiterRes } from 'rate-limiter-flexible'

/** Context shape when the auth macro has resolved a session. */
type AuthResolvedContext = {
  user?: { id: string } | null
}

type RateLimitTier =
  | 'inference'
  | 'pro'
  | 'auth'
  | 'integration-oauth'
  | 'anonymous-sign-in'
  | 'anonymous-sign-in-global'
  | 'captcha-challenge'
  | 'debug-transcript'
  | 'debug-transcript-intake'
  | 'scim'
  | 'scim-auth-failure'
  | 'scim-failure-record'
/** Tiers whose limit the caller passes: operator-configured, or sized by the module that owns them. */
type ConfiguredRateLimitTier =
  | 'anonymous-sign-in'
  | 'anonymous-sign-in-global'
  | 'captcha-challenge'
  | 'scim'
  | 'scim-auth-failure'
  | 'scim-failure-record'
/** Tiers with a hardcoded limit. */
type FixedRateLimitTier = Exclude<RateLimitTier, ConfiguredRateLimitTier>
export type UserRateLimitTier = Exclude<FixedRateLimitTier, 'auth'>

export type RateLimitTierConfig = {
  max: number
  durationSecs: number
}

export type RateLimitSettings = {
  enabled: boolean
}

export type IpRateLimitSettings = RateLimitSettings & {
  trustedProxy: TrustedProxy
}

export type AuthPluginIpRateLimitSettings = IpRateLimitSettings & {
  anonymousSignIn: RateLimitTierConfig
}

/** Hardcoded per-tier limits. */
const tierConfigs = {
  inference: { max: 60, durationSecs: 60 },
  pro: { max: 100, durationSecs: 60 },
  auth: { max: 10, durationSecs: 60 },
  'integration-oauth': { max: 30, durationSecs: 60 },
  'debug-transcript': { max: 10, durationSecs: 60 * 60 },
  'debug-transcript-intake': { max: 600, durationSecs: 60 * 60 },
} satisfies Record<FixedRateLimitTier, RateLimitTierConfig>

/** Create a rate-limiter-flexible instance for a specific tier. */
const createLimiter = (database: typeof DbType, tier: RateLimitTier, config: RateLimitTierConfig) =>
  new RateLimiterDrizzle({
    storeClient: database,
    schema: rateLimits,
    keyPrefix: tier,
    points: config.max,
    duration: config.durationSecs,
    clearExpiredByTimeout: true,
  })

/** Set rate limit response headers. */
const setRateLimitHeaders = (
  headers: Record<string, string | string[] | number>,
  limit: number,
  remaining: number,
  resetSecs: number,
) => {
  headers['RateLimit-Limit'] = String(limit)
  headers['RateLimit-Remaining'] = String(remaining)
  headers['RateLimit-Reset'] = String(resetSecs)
}

/** Consume a rate limit point or return a 429 response. */
const consumeOrReject = async (
  limiter: RateLimiterAbstract,
  key: string,
  set: { status?: number | string; headers: Record<string, string | string[] | number> },
) => {
  try {
    const res = await limiter.consume(key)
    setRateLimitHeaders(set.headers, limiter.points, res.remainingPoints, Math.ceil(res.msBeforeNext / 1000))
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      set.status = 429
      set.headers['Retry-After'] = String(Math.ceil(err.msBeforeNext / 1000))
      setRateLimitHeaders(set.headers, limiter.points, 0, Math.ceil(err.msBeforeNext / 1000))
      return { error: 'Too many requests. Please try again later.' }
    }
    throw err
  }
}

/**
 * Build a user-based rate limit middleware for authenticated routes.
 * Reads the `user` already resolved by the auth macro to avoid a
 * redundant getSession() call; skips rate limiting when the user
 * context is unavailable.
 *
 * Must be .use()'d INSIDE a guard({ auth: true }) so the macro's
 * resolve populates `ctx.user` before this onBeforeHandle fires.
 * Registering at the app level (outside the guard) causes the
 * macro resolve to run after onBeforeHandle, making rate limiting
 * a silent no-op.
 */
const createUserRateLimitMiddleware = (limiter: RateLimiterDrizzle) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { set } = ctx
      const user = (ctx as AuthResolvedContext).user
      if (!user?.id) {
        return
      }
      return consumeOrReject(limiter, `user:${user.id}`, set)
    })
    .as('scoped')

/** Create user-keyed middleware for one configured rate-limit tier. */
export const createUserTierRateLimit = (
  database: typeof DbType,
  settings: RateLimitSettings,
  tier: UserRateLimitTier,
) => {
  if (!settings.enabled) {
    return new Elysia()
  }
  return createUserRateLimitMiddleware(createLimiter(database, tier, tierConfigs[tier]))
}

/**
 * Build an IP-based rate limit middleware for unauthenticated routes.
 * Uses `extractClientIp` to resolve the real client IP behind a trusted proxy,
 * falling back to the Bun socket IP when no proxy is configured.
 *
 * Fails CLOSED when the client IP cannot be resolved: unidentifiable traffic
 * shares a single `ip:unknown` bucket rather than skipping the limit, so this
 * control guarding abuse-prone unauthenticated endpoints (OTP send, waitlist
 * join) can never silently disable itself. Identifiable clients are unaffected —
 * each keeps its own `ip:<addr>` bucket, so real traffic is never funnelled into
 * the shared one. In practice 'unknown' never occurs under TCP-listening Bun
 * (`server.requestIP()` always returns the peer address); it would only arise on
 * a non-TCP transport (e.g. a Unix-domain socket), where collectively capping
 * unattributable traffic is the safe default.
 *
 * `limiterFor` returns null for a request that is exempt from this middleware.
 */
const createIpRateLimitMiddleware = (
  limiterFor: (request: Request) => RateLimiterDrizzle | null,
  trustedProxy: IpRateLimitSettings['trustedProxy'],
) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { set } = ctx
      const limiter = limiterFor(ctx.request)
      if (!limiter) {
        return
      }
      // `|| 'unknown'` (not `??`): a degenerate empty-string address folds into the
      // same shared fail-closed bucket as a missing one, never a stray `ip:` key.
      const socketIp = ctx.server?.requestIP(ctx.request)?.address || 'unknown'
      const clientIp = extractClientIp(ctx.request.headers, socketIp, trustedProxy)
      return consumeOrReject(limiter, `ip:${clientIp}`, set)
    })
    .as('scoped')

/**
 * A tier and its limit: fixed tiers use `tierConfigs`; operator-sized tiers take their config
 * from the caller ('captcha-challenge' the object that sizes 'anonymous-sign-in').
 */
type TierArgs =
  | [tier: FixedRateLimitTier]
  | [tier: Exclude<ConfiguredRateLimitTier, 'anonymous-sign-in'>, config: RateLimitTierConfig]

/** Create the limiter for a tier, from `tierConfigs` or the caller's operator config. */
const createTierLimiter = (database: typeof DbType, ...args: TierArgs) =>
  args.length === 1 ? createLimiter(database, args[0], tierConfigs[args[0]]) : createLimiter(database, ...args)

/** IP-keyed middleware for one tier; fails closed like createAuthIpRateLimit. */
export const createIpTierRateLimit = (database: typeof DbType, settings: IpRateLimitSettings, ...args: TierArgs) => {
  if (!settings.enabled) {
    return new Elysia()
  }
  const limiter = createTierLimiter(database, ...args)
  return createIpRateLimitMiddleware(() => limiter, settings.trustedProxy)
}

/** Create IP-based rate limit middleware for auth and unauthenticated routes. */
export const createAuthIpRateLimit = (database: typeof DbType, settings: IpRateLimitSettings) =>
  createIpTierRateLimit(database, settings, 'auth')

const anonymousSignInMountPath = `${authBasePath}${anonymousSignInPath}`
const scimMountPath = `${authBasePath}/scim/v2`
const getSessionMountPath = `${authBasePath}${getSessionPath}`

/** Exact match, as Better Auth routes it: a trailing slash or lookalike prefix is a 404 there. */
const isAnonymousSignIn = (request: Request) => new URL(request.url).pathname === anonymousSignInMountPath

/** SCIM has its own per-connection budget (createScimRequestHandler), so it skips the auth tiers. */
const isScim = (request: Request) => {
  const { pathname } = new URL(request.url)
  return pathname === scimMountPath || pathname.startsWith(`${scimMountPath}/`)
}

/** GET with an exact path match, like `isAnonymousSignIn`; the app only ever GETs it. */
const isGetSession = (request: Request) =>
  request.method === 'GET' && new URL(request.url).pathname === getSessionMountPath

/**
 * IP rate limit for the Better Auth mount. Anonymous sign-in draws from its own
 * operator-configured 'anonymous-sign-in' bucket so raising it never loosens any other
 * auth route. GET get-session is exempt: the app calls it on every boot, reconnect and
 * cross-tab session change, so visitors sharing one IP would exhaust 'auth' between them,
 * and Better Auth's own '/get-session' rule still limits it. Everything else draws from the fixed 'auth' tier.
 * The deployment-wide 'anonymous-sign-in-global' budget is charged later, in the auth
 * before-hook, once the captcha has passed. SCIM is exempt: an IdP's sync would exhaust 'auth'
 * within seconds, and SCIM has its own budget.
 */
export const createAuthPluginIpRateLimit = (database: typeof DbType, settings: AuthPluginIpRateLimitSettings) => {
  if (!settings.enabled) {
    return new Elysia()
  }
  const authLimiter = createLimiter(database, 'auth', tierConfigs.auth)
  const anonymousSignInLimiter = createLimiter(database, 'anonymous-sign-in', settings.anonymousSignIn)
  return createIpRateLimitMiddleware((request) => {
    if (isGetSession(request) || isScim(request)) {
      return null
    }
    return isAnonymousSignIn(request) ? anonymousSignInLimiter : authLimiter
  }, settings.trustedProxy)
}

export type RateLimitSet = Parameters<typeof consumeOrReject>[2]

/** Consume one point for `key`; resolves to the 429 body when the limit is hit. */
export type RateLimitConsumer = (key: string, set: RateLimitSet) => Promise<{ error: string } | undefined>

/**
 * Rate limiting whose key is neither the session user nor the IP (an intake client, or the
 * single key of a deployment-wide budget: anonymous sign-in).
 */
export const createRateLimitConsumer = (
  database: typeof DbType,
  settings: RateLimitSettings,
  ...args: TierArgs
): RateLimitConsumer | null => {
  if (!settings.enabled) {
    return null
  }
  const limiter = createTierLimiter(database, ...args)
  return (key, set) => consumeOrReject(limiter, key, set)
}

/** Counts only failures: `check` refuses a key that used its budget, `record` spends one point. */
export type FailureRateLimit = {
  check: (key: string, set: RateLimitSet) => Promise<{ error: string } | undefined>
  record: (key: string) => Promise<void>
}

/**
 * A budget charged only by failed attempts (a rejected credential, say), so a client that keeps
 * succeeding never meets it.
 */
export const createFailureRateLimit = (
  database: typeof DbType,
  settings: RateLimitSettings,
  ...args: TierArgs
): FailureRateLimit | null => {
  if (!settings.enabled) {
    return null
  }
  const limiter = createTierLimiter(database, ...args)
  return {
    check: async (key, set) => {
      const res = await limiter.get(key)
      if (!res || res.consumedPoints < limiter.points) {
        return undefined
      }
      const resetSecs = Math.ceil(res.msBeforeNext / 1000)
      set.status = 429
      set.headers['Retry-After'] = String(resetSecs)
      setRateLimitHeaders(set.headers, limiter.points, 0, resetSecs)
      return { error: 'Too many requests. Please try again later.' }
    },
    record: async (key) => {
      try {
        await limiter.consume(key)
      } catch (err) {
        if (!(err instanceof RateLimiterRes)) {
          throw err
        }
      }
    },
  }
}
