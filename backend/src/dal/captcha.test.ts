/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { solvedCaptchaChallenges } from '@/db/captcha-schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { deleteExpiredCaptchaChallenges, redeemCaptchaChallenge } from './captcha'

describe('captcha DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  const inOneMinute = () => new Date(Date.now() + 60_000)
  // The sweep's grace for clock skew between instances.
  const graceMs = 5 * 60 * 1000

  it('redeemCaptchaChallenge succeeds once per challenge', async () => {
    expect(await redeemCaptchaChallenge(db, 'challenge-a', inOneMinute())).toBe(true)
    expect(await redeemCaptchaChallenge(db, 'challenge-a', inOneMinute())).toBe(false)
    expect(await redeemCaptchaChallenge(db, 'challenge-b', inOneMinute())).toBe(true)
  })

  it('deleteExpiredCaptchaChallenges removes rows past the grace window and keeps the rest', async () => {
    const now = Date.now()
    await redeemCaptchaChallenge(db, 'past-grace', new Date(now - graceMs - 1000))
    await redeemCaptchaChallenge(db, 'within-grace', new Date(now - graceMs + 60_000))
    await redeemCaptchaChallenge(db, 'live', inOneMinute())

    await deleteExpiredCaptchaChallenges(db)

    const remaining = (await db.select().from(solvedCaptchaChallenges)).map((row) => row.challenge).sort()
    expect(remaining).toEqual(['live', 'within-grace'])
  })
})
