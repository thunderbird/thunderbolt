/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { solvedCaptchaChallenges } from '@/db/captcha-schema'
import { solveAltchaChallenge } from '@/test-utils/altcha'
import { createTestDb } from '@/test-utils/db'
import { createChallenge } from 'altcha-lib/v1'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createAltchaChallenge, createCaptchaVerifier, type CaptchaVerifier } from './captcha'

const altchaSettings = {
  captchaProvider: 'altcha' as const,
  captchaSecret: 'altcha-test-secret-0123456789abcdef',
  captchaDifficulty: 1000,
  captchaTtlSecs: 600,
}
const context = { clientIp: '203.0.113.7' }

describe('createCaptchaVerifier', () => {
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

  it("passes every request when the provider is 'none'", async () => {
    const verifier = createCaptchaVerifier({ ...altchaSettings, captchaProvider: 'none' }, db)
    expect(await verifier.verify(null, { clientIp: 'unknown' })).toBe(true)
    expect(await verifier.verify('anything', { clientIp: '203.0.113.7' })).toBe(true)
  })

  describe('altcha', () => {
    let verifier: CaptchaVerifier

    beforeEach(() => {
      verifier = createCaptchaVerifier(altchaSettings, db)
    })

    it('accepts a freshly solved challenge and records it', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      expect(await verifier.verify(await solveAltchaChallenge(challenge), context)).toBe(true)
      const rows = await db.select().from(solvedCaptchaChallenges)
      expect(rows.map((row) => row.challenge)).toEqual([challenge.challenge])
    })

    it('rejects a replayed solution', async () => {
      const token = await solveAltchaChallenge(await createAltchaChallenge(altchaSettings))
      expect(await verifier.verify(token, context)).toBe(true)
      expect(await verifier.verify(token, context)).toBe(false)
    })

    it('rejects a missing or malformed token', async () => {
      expect(await verifier.verify(null, context)).toBe(false)
      expect(await verifier.verify('not base64 json', context)).toBe(false)
      expect(await verifier.verify(btoa('null'), context)).toBe(false)
      expect(await verifier.verify(btoa('{"algorithm":"SHA-256"}'), context)).toBe(false)
    })

    it('rejects a tampered signature', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      const token = await solveAltchaChallenge(challenge, { signature: '0'.repeat(64) })
      expect(await verifier.verify(token, context)).toBe(false)
    })

    it('rejects a wrong answer', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      const solved = JSON.parse(atob(await solveAltchaChallenge(challenge))) as { number: number }
      const token = await solveAltchaChallenge(challenge, { number: solved.number + 1 })
      expect(await verifier.verify(token, context)).toBe(false)
    })

    it('rejects a challenge signed with another secret', async () => {
      const challenge = await createAltchaChallenge({ ...altchaSettings, captchaSecret: 'x'.repeat(32) })
      expect(await verifier.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('rejects an expired challenge', async () => {
      const challenge = await createChallenge({
        hmacKey: altchaSettings.captchaSecret,
        maxnumber: altchaSettings.captchaDifficulty,
        expires: new Date(Date.now() - 1000),
      })
      expect(await verifier.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('rejects a validly signed challenge that carries no expiry', async () => {
      const challenge = await createChallenge({
        hmacKey: altchaSettings.captchaSecret,
        maxnumber: altchaSettings.captchaDifficulty,
      })
      expect(await verifier.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('rejects a validly signed challenge using an algorithm other than SHA-256', async () => {
      const challenge = await createChallenge({
        algorithm: 'SHA-1',
        hmacKey: altchaSettings.captchaSecret,
        maxnumber: altchaSettings.captchaDifficulty,
        expires: new Date(Date.now() + 60_000),
      })
      expect(await verifier.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })
  })
})

describe('createAltchaChallenge', () => {
  it('signs a SHA-256 challenge with the configured difficulty and expiry', async () => {
    const before = Math.floor(Date.now() / 1000)
    const challenge = await createAltchaChallenge(altchaSettings)
    expect(challenge.algorithm).toBe('SHA-256')
    expect(challenge.maxnumber).toBe(1000)
    const expires = Number(new URLSearchParams(challenge.salt.split('?')[1]).get('expires'))
    expect(expires).toBeGreaterThanOrEqual(before + 600)
    expect(expires).toBeLessThanOrEqual(before + 601)
  })
})
