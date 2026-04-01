import type { db as DbType } from '@/db/client'
import { incrementRateLimit, decrementRateLimit, deleteRateLimitByIp, deleteAllRateLimits } from '@/dal'
import { extractClientIp } from '@/utils/request'
import { rateLimit, type Context as RateLimitContext, type Options } from 'elysia-rate-limit'

/**
 * Postgres-backed rate limit context for elysia-rate-limit.
 * Uses an atomic UPSERT query with a sliding window per IP.
 * Keys are prefixed with a tier name to prevent counter interference across tiers.
 */
export class PostgresRateLimitContext implements RateLimitContext {
  private duration = 60_000
  private database: typeof DbType
  private tier: string

  constructor(database: typeof DbType, tier = 'standard') {
    this.database = database
    this.tier = tier
  }

  init(options: Omit<Options, 'context'>) {
    this.duration = options.duration
  }

  /** Prefix the raw IP key with the tier to isolate counters across rate limit tiers. */
  private prefixedKey(key: string) {
    return `${this.tier}:${key}`
  }

  async increment(key: string) {
    const prefixed = this.prefixedKey(key)
    const durationSecs = this.duration / 1000
    const row = await incrementRateLimit(this.database, prefixed, durationSecs)
    const nextReset = new Date(row.windowStart.getTime() + this.duration)

    return { count: row.count, nextReset }
  }

  async decrement(key: string) {
    const prefixed = this.prefixedKey(key)
    await decrementRateLimit(this.database, prefixed)
  }

  async reset(key?: string) {
    if (key) {
      const prefixed = this.prefixedKey(key)
      await deleteRateLimitByIp(this.database, prefixed)
    } else {
      await deleteAllRateLimits(this.database)
    }
  }

  kill() {
    // No-op — uses the shared database connection
  }
}

type RateLimitTier = {
  max: number
  duration: number
}

type RateLimitSettings = {
  enabled: boolean
  inference: RateLimitTier
  auth: RateLimitTier
  standard: RateLimitTier
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

/** Create a rate limiter scoped to a specific tier. */
const createTieredRateLimit = (
  database: typeof DbType,
  tierName: string,
  tier: RateLimitTier,
  skip?: (req: Request) => boolean,
) =>
  rateLimit({
    max: tier.max,
    duration: tier.duration,
    scoping: 'scoped',
    context: new PostgresRateLimitContext(database, tierName),
    generator: (req, server) => extractClientIp(req.headers, server?.requestIP(req)?.address ?? 'unknown'),
    errorResponse: new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }),
    skip: skip ? (req) => skip(req) : undefined,
  })

/** Create rate limit middleware for inference routes. */
export const createInferenceRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return rateLimit({ max: Number.MAX_SAFE_INTEGER, duration: 1 })
  return createTieredRateLimit(database, 'inference', settings.inference)
}

/** Create rate limit middleware for auth routes (only credential-based sign-in/sign-up). */
export const createAuthRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return rateLimit({ max: Number.MAX_SAFE_INTEGER, duration: 1 })
  return createTieredRateLimit(database, 'auth', settings.auth, (req) => {
    const path = new URL(req.url).pathname
    return !rateLimitedAuthPrefixes.some((p) => path.startsWith(p))
  })
}

/** Create rate limit middleware for standard routes. */
export const createStandardRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return rateLimit({ max: Number.MAX_SAFE_INTEGER, duration: 1 })
  return createTieredRateLimit(database, 'standard', settings.standard, (req) => {
    const path = new URL(req.url).pathname
    return exemptPaths.has(path) || exemptPrefixes.some((p) => path.startsWith(p))
  })
}
