import type { db as DbType } from '@/db/client'
import { extractClientIp } from '@/utils/request'
import { rateLimit, type Context as RateLimitContext, type Options } from 'elysia-rate-limit'
import { sql } from 'drizzle-orm'

/**
 * Postgres-backed rate limit context for elysia-rate-limit.
 * Uses an atomic UPSERT query with a sliding window per IP.
 */
export class PostgresRateLimitContext implements RateLimitContext {
  private duration = 60_000
  private database: typeof DbType

  constructor(database: typeof DbType) {
    this.database = database
  }

  init(options: Omit<Options, 'context'>) {
    this.duration = options.duration
  }

  async increment(key: string) {
    const durationSecs = this.duration / 1000
    const result = await this.database.execute<{ count: number; window_start: string }>(sql`
      INSERT INTO rate_limits (ip, count, window_start)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (ip)
      DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start + make_interval(secs => ${durationSecs}) < NOW()
          THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start + make_interval(secs => ${durationSecs}) < NOW()
          THEN NOW()
          ELSE rate_limits.window_start
        END
      RETURNING count, window_start
    `)

    const row = Array.isArray(result)
      ? result[0]
      : (result as unknown as { rows: { count: number; window_start: string }[] }).rows[0]
    const nextReset = new Date(new Date(row.window_start).getTime() + this.duration)

    return { count: row.count, nextReset }
  }

  async decrement(key: string) {
    await this.database.execute(sql`
      UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE ip = ${key}
    `)
  }

  async reset(key?: string) {
    if (key) {
      await this.database.execute(sql`DELETE FROM rate_limits WHERE ip = ${key}`)
    } else {
      await this.database.execute(sql`DELETE FROM rate_limits`)
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

/** Create a rate limiter scoped to a specific tier. */
const createTieredRateLimit = (database: typeof DbType, tier: RateLimitTier, skip?: (req: Request) => boolean) =>
  rateLimit({
    max: tier.max,
    duration: tier.duration,
    scoping: 'scoped',
    context: new PostgresRateLimitContext(database),
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
  return createTieredRateLimit(database, settings.inference)
}

/** Create rate limit middleware for auth routes. */
export const createAuthRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return rateLimit({ max: Number.MAX_SAFE_INTEGER, duration: 1 })
  return createTieredRateLimit(database, settings.auth)
}

/** Create rate limit middleware for standard routes. */
export const createStandardRateLimit = (database: typeof DbType, settings: RateLimitSettings) => {
  if (!settings.enabled) return rateLimit({ max: Number.MAX_SAFE_INTEGER, duration: 1 })
  return createTieredRateLimit(database, settings.standard, (req) => {
    const path = new URL(req.url).pathname
    return exemptPaths.has(path) || exemptPrefixes.some((p) => path.startsWith(p))
  })
}
