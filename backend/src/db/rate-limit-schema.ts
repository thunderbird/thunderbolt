import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Schema expected by rate-limiter-flexible's RateLimiterDrizzle adapter. */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  points: integer('points').notNull().default(0),
  expire: timestamp('expire', { withTimezone: true }),
})
