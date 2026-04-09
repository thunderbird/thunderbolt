import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import type { Settings } from '@/config/settings'
import { extractClientIp } from '@/utils/request'
import { Elysia } from 'elysia'
import { RateLimiterAbstract, RateLimiterDrizzle, RateLimiterRes } from 'rate-limiter-flexible'

/** Context shape when the auth macro has resolved a session. */
type AuthResolvedContext = {
  user?: { id: string } | null
}

// TODO(THU-113): Add proof-of-work challenge (ALTCHA) for auth route abuse prevention

type RateLimitTier = 'inference' | 'pro'

type IpRateLimitTier = 'waitlist'

type RateLimitTierConfig = {
  max: number
  durationSecs: number
}

export type RateLimitSettings = {
  enabled: boolean
}

/** Hardcoded per-tier limits. */
const tierConfigs: Record<RateLimitTier, RateLimitTierConfig> = {
  inference: { max: 20, durationSecs: 60 },
  pro: { max: 50, durationSecs: 60 },
}

/** Hardcoded per-tier limits for IP-based rate limiting. */
const ipTierConfigs: Record<IpRateLimitTier, RateLimitTierConfig> = {
  waitlist: { max: 5, durationSecs: 60 },
}

/** Create a rate-limiter-flexible instance for a specific tier. */
const createLimiter = (database: typeof DbType, tier: RateLimitTier) => {
  const config = tierConfigs[tier]
  return new RateLimiterDrizzle({
    storeClient: database,
    schema: rateLimits,
    keyPrefix: tier,
    points: config.max,
    duration: config.durationSecs,
    clearExpiredByTimeout: true,
  })
}

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
      if (!user?.id) return
      return consumeOrReject(limiter, `user:${user.id}`, set)
    })
    .as('scoped')

/** Create rate limit middleware for inference routes (keyed by user). */
export const createInferenceRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createLimiter(database, 'inference')
  return createUserRateLimitMiddleware(limiter)
}

/** Create rate limit middleware for pro tool routes (keyed by user). */
export const createProRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createLimiter(database, 'pro')
  return createUserRateLimitMiddleware(limiter)
}

/** Create a rate-limiter-flexible instance for an IP-based tier. */
const createIpLimiter = (database: typeof DbType, tier: IpRateLimitTier) => {
  const config = ipTierConfigs[tier]
  return new RateLimiterDrizzle({
    storeClient: database,
    schema: rateLimits,
    keyPrefix: tier,
    points: config.max,
    duration: config.durationSecs,
    clearExpiredByTimeout: true,
  })
}

/**
 * Build an IP-based rate limit middleware for unauthenticated routes.
 * Extracts the client IP using the trusted proxy configuration and
 * rate-limits by IP address.
 */
const createIpRateLimitMiddleware = (
  limiter: RateLimiterDrizzle,
  trustedProxy: Settings['trustedProxy'],
) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { set, request } = ctx
      const ip = extractClientIp(request.headers, ctx.server?.requestIP(request)?.address, trustedProxy)
      if (!ip || ip === 'unknown') return
      return consumeOrReject(limiter, `ip:${ip}`, set)
    })
    .as('scoped')

/** Create IP-based rate limit middleware for waitlist routes. */
export const createWaitlistRateLimit = (
  database: typeof DbType,
  settings: RateLimitSettings,
  trustedProxy: Settings['trustedProxy'] = '',
) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createIpLimiter(database, 'waitlist')
  return createIpRateLimitMiddleware(limiter, trustedProxy)
}
