import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { eq, sql } from 'drizzle-orm'

/** Atomically increment the rate limit counter for an IP, resetting the window if expired. Returns the new count and next reset time. */
export const incrementRateLimit = async (database: typeof DbType, ip: string, durationSecs: number) => {
  const rows = await database
    .insert(rateLimits)
    .values({ ip, count: 1, windowStart: new Date() })
    .onConflictDoUpdate({
      target: rateLimits.ip,
      set: {
        count: sql`CASE
          WHEN ${rateLimits.windowStart} + make_interval(secs => ${durationSecs}) < NOW()
          THEN 1
          ELSE ${rateLimits.count} + 1
        END`,
        windowStart: sql`CASE
          WHEN ${rateLimits.windowStart} + make_interval(secs => ${durationSecs}) < NOW()
          THEN NOW()
          ELSE ${rateLimits.windowStart}
        END`,
      },
    })
    .returning()

  return rows[0]
}

/** Decrement the rate limit counter for an IP (floors at 0). */
export const decrementRateLimit = async (database: typeof DbType, ip: string) =>
  database
    .update(rateLimits)
    .set({ count: sql<number>`GREATEST(${rateLimits.count} - 1, 0)` })
    .where(eq(rateLimits.ip, ip))

/** Delete the rate limit record for a specific IP. */
export const deleteRateLimitByIp = async (database: typeof DbType, ip: string) =>
  database.delete(rateLimits).where(eq(rateLimits.ip, ip))

/** Delete all rate limit records. */
export const deleteAllRateLimits = async (database: typeof DbType) => database.delete(rateLimits)
