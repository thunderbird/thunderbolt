import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const rateLimits = pgTable('rate_limits', {
  ip: text('ip').primaryKey(),
  count: integer('count').notNull().default(1),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
})
