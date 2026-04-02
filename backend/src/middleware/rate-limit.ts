import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { extractClientIp } from '@/utils/request'
import { Elysia } from 'elysia'
import { RateLimiterDrizzle, RateLimiterRes } from 'rate-limiter-flexible'

type RateLimitTier = 'inference' | 'auth' | 'standard'

type RateLimitTierConfig = {
  max: number
  durationSecs: number
}

export type RateLimitSettings = {
  enabled: boolean
  inference: RateLimitTierConfig
  auth: RateLimitTierConfig
  standard: RateLimitTierConfig
  trustedProxy: '' | 'cloudflare' | 'akamai'
}

const exemptPaths = new Set(['/v1/health', '/v1/posthog/config', '/v1/posthog/events'])

const exemptPrefixes = ['/v1/api/auth/get-session']

/**
 * Auth paths that are abuse-prone and should be rate-limited.
 * All other auth paths (session checks, OIDC callbacks, etc.) are exempt.
 */
const rateLimitedAuthPrefixes = [
  '/v1/api/auth/sign-in',
  '/v1/api/auth/sign-up',
  '/v1/api/auth/forget-password',
  '/v1/api/auth/reset-password',
]

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

/** Extract client IP from request, respecting the trusted proxy setting. */
const getClientIp = (req: Request, server: Elysia['server'], trustedProxy: RateLimitSettings['trustedProxy']): string =>
  extractClientIp(req.headers, server?.requestIP(req)?.address ?? 'unknown', trustedProxy)

/**
 * Build an IP-based rate limit middleware (no auth context needed).
 * Used for unauthenticated routes like auth endpoints and the global standard limit.
 */
const createIpRateLimitMiddleware = (
  limiter: RateLimiterDrizzle,
  trustedProxy: RateLimitSettings['trustedProxy'],
  skip?: (req: Request) => boolean,
) =>
  new Elysia()
    .onBeforeHandle(async ({ request, set, server }) => {
      if (skip?.(request)) return

      const key = getClientIp(request, server, trustedProxy)

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
    })
    .as('scoped')

/**
 * Build a user-based rate limit middleware for authenticated routes.
 * Reads the `user` already derived by createSessionGuard to avoid a
 * redundant getSession() call; falls back to IP-based keying when
 * the user context is unavailable.
 * Must be .use()'d AFTER createSessionGuard so the user is derived.
 */
const createUserRateLimitMiddleware = (limiter: RateLimiterDrizzle, trustedProxy: RateLimitSettings['trustedProxy']) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { request, set, server } = ctx
      const user = (ctx as Record<string, unknown>).user as { id: string } | null | undefined
      const key = user?.id ? `user:${user.id}` : `ip:${getClientIp(request, server, trustedProxy)}`

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
    })
    .as('scoped')

/** Create rate limit middleware for inference routes (keyed by user). */
export const createInferenceRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createLimiter(database, 'inference', settings.inference)
  return createUserRateLimitMiddleware(limiter, settings.trustedProxy)
}

/** Create rate limit middleware for auth routes (IP-based, only credential paths). */
export const createAuthRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createLimiter(database, 'auth', settings.auth)
  return createIpRateLimitMiddleware(limiter, settings.trustedProxy, (req) => {
    const path = new URL(req.url).pathname
    return !rateLimitedAuthPrefixes.some((p) => path.startsWith(p))
  })
}

/** Create rate limit middleware for standard routes (IP-based, health/posthog exempt). */
export const createStandardRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return new Elysia()
  const limiter = createLimiter(database, 'standard', settings.standard)
  return createIpRateLimitMiddleware(limiter, settings.trustedProxy, (req) => {
    const path = new URL(req.url).pathname
    return exemptPaths.has(path) || exemptPrefixes.some((p) => path.startsWith(p))
  })
}
