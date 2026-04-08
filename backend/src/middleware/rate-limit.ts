import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { extractClientIp } from '@/utils/request'
import { Elysia } from 'elysia'
import { RateLimiterAbstract, RateLimiterDrizzle, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

/** Context shape when the auth macro has resolved a session. */
type AuthResolvedContext = {
  user?: { id: string } | null
}

type RateLimitTier = 'inference' | 'pro' | 'auth'

type RateLimitTierConfig = {
  max: number
  durationSecs: number
}

export type RateLimitSettings = {
  enabled: boolean
  trustedProxy: '' | 'cloudflare' | 'akamai'
}

/** Hardcoded per-tier limits. */
const tierConfigs: Record<RateLimitTier, RateLimitTierConfig> = {
  inference: { max: 20, durationSecs: 60 },
  pro: { max: 50, durationSecs: 60 },
  auth: { max: 10, durationSecs: 900 },
}

/**
 * Auth paths that are abuse-prone and should be rate-limited.
 * Only sign-in is active (emailOTP); sign-up/password routes are
 * included defensively in case Better Auth exposes them.
 */
const rateLimitedAuthPrefixes = ['/v1/api/auth/sign-in']

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
 * Reads the `user` already derived by the auth macro to avoid a
 * redundant getSession() call; skips rate limiting when the user
 * context is unavailable.
 * Must be .use()'d AFTER createAuthMacro so the user is resolved.
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

/** Create DB-backed IP-based rate limit middleware for auth routes. */
export const createAuthRateLimit = (settings: RateLimitSettings & { database?: typeof DbType }) => {
  if (!settings.enabled) return new Elysia()
  const config = tierConfigs.auth
  const limiter = settings.database
    ? new RateLimiterDrizzle({
        storeClient: settings.database,
        schema: rateLimits,
        keyPrefix: 'auth',
        points: config.max,
        duration: config.durationSecs,
        clearExpiredByTimeout: true,
      })
    : new RateLimiterMemory({
        keyPrefix: 'auth',
        points: config.max,
        duration: config.durationSecs,
      })
  return new Elysia()
    .onBeforeHandle(async ({ request, set, server }) => {
      const path = new URL(request.url).pathname
      if (!rateLimitedAuthPrefixes.some((p) => path.startsWith(p))) return
      const socketIp = server?.requestIP(request)?.address ?? '0.0.0.0'
      const ip = extractClientIp(request.headers, socketIp, settings.trustedProxy)
      const hasher = new Bun.CryptoHasher('sha256')
      const key = hasher.update(ip).digest('hex')
      return consumeOrReject(limiter, key, set)
    })
    .as('scoped')
}
