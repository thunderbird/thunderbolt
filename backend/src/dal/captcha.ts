/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { solvedCaptchaChallenges } from '@/db/captcha-schema'
import { lte } from 'drizzle-orm'

/**
 * Record a solved captcha challenge. Resolves true the first time a challenge is redeemed
 * and false on every later attempt; the primary key makes this atomic across instances.
 */
export const redeemCaptchaChallenge = async (database: QueryableDatabase, challenge: string, expiresAt: Date) => {
  const inserted = await database
    .insert(solvedCaptchaChallenges)
    .values({ challenge, expiresAt })
    .onConflictDoNothing()
    .returning()
  return inserted.length > 0
}

/**
 * How long a solved challenge outlives its expiry. This table is a deny-list, so deleting a row
 * at the exact expiry would reopen replay on any instance whose clock runs behind.
 */
const solvedCaptchaChallengeGraceMs = 5 * 60 * 1000

/**
 * Sweep solved challenges more than `solvedCaptchaChallengeGraceMs` past their expiry
 * (startup + hourly, alongside the E2EE nonce sweep).
 */
export const deleteExpiredCaptchaChallenges = async (database: QueryableDatabase) =>
  database
    .delete(solvedCaptchaChallenges)
    .where(lte(solvedCaptchaChallenges.expiresAt, new Date(Date.now() - solvedCaptchaChallengeGraceMs)))
