/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * ALTCHA challenges already redeemed, so a solved token works once across every backend
 * instance. Rows are useless after `expiresAt` (the challenge itself is rejected by then)
 * and are swept on an interval.
 */
export const solvedCaptchaChallenges = pgTable(
  'solved_captcha_challenges',
  {
    challenge: text('challenge').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('solved_captcha_challenges_expires_at_idx').on(t.expiresAt)],
)
