/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Schema expected by rate-limiter-flexible's RateLimiterDrizzle adapter. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    points: integer('points').notNull().default(0),
    expire: timestamp('expire', { withTimezone: true }),
  },
  (t) => [index('rate_limits_expire_idx').on(t.expire)],
)
