/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { solvedCaptchaChallenges } from '@/db/captcha-schema'
import { solveAltchaChallenge } from '@/test-utils/altcha'
import { createTestDb } from '@/test-utils/db'
import { createChallenge } from 'altcha-lib/v1'
import type { Challenge } from 'altcha-lib/v1/types'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createCaptchaProvider, type CaptchaProvider } from './captcha'

const altchaSettings = {
  captchaProvider: 'altcha' as const,
  altchaSecret: 'altcha-test-secret-0123456789abcdef',
  altchaDifficulty: 1000,
  altchaTtlSecs: 600,
}
const context = { clientIp: '203.0.113.7' }

describe('createCaptchaProvider', () => {
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

  it("passes every request and issues no challenges when the provider is 'none'", async () => {
    const provider = createCaptchaProvider({ ...altchaSettings, captchaProvider: 'none' }, db)
    expect(await provider.verify(null, { clientIp: 'unknown' })).toBe(true)
    expect(await provider.verify('anything', { clientIp: '203.0.113.7' })).toBe(true)
    expect(provider.issueChallenge).toBeUndefined()
  })

  describe('altcha', () => {
    let provider: CaptchaProvider
    /** A challenge from the provider under test, typed as the ALTCHA widget reads it. */
    const createAltchaChallenge = async (settings = altchaSettings) =>
      (await createCaptchaProvider(settings, db).issueChallenge?.()) as Challenge

    beforeEach(() => {
      provider = createCaptchaProvider(altchaSettings, db)
    })

    it('accepts a freshly solved challenge and records it', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      expect(await provider.verify(await solveAltchaChallenge(challenge), context)).toBe(true)
      const rows = await db.select().from(solvedCaptchaChallenges)
      expect(rows.map((row) => row.challenge)).toEqual([challenge.challenge])
    })

    it('rejects a replayed solution', async () => {
      const token = await solveAltchaChallenge(await createAltchaChallenge(altchaSettings))
      expect(await provider.verify(token, context)).toBe(true)
      expect(await provider.verify(token, context)).toBe(false)
    })

    it('rejects a missing or malformed token', async () => {
      expect(await provider.verify(null, context)).toBe(false)
      expect(await provider.verify('not base64 json', context)).toBe(false)
      expect(await provider.verify(btoa('null'), context)).toBe(false)
      expect(await provider.verify(btoa('{"algorithm":"SHA-256"}'), context)).toBe(false)
    })

    it('rejects a tampered signature', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      const token = await solveAltchaChallenge(challenge, { signature: '0'.repeat(64) })
      expect(await provider.verify(token, context)).toBe(false)
    })

    it('rejects a wrong answer', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      const solved = JSON.parse(atob(await solveAltchaChallenge(challenge))) as { number: number }
      const token = await solveAltchaChallenge(challenge, { number: solved.number + 1 })
      expect(await provider.verify(token, context)).toBe(false)
    })

    it('rejects a challenge signed with another secret', async () => {
      const challenge = await createAltchaChallenge({ ...altchaSettings, altchaSecret: 'x'.repeat(32) })
      expect(await provider.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('rejects an expired challenge', async () => {
      const challenge = await createChallenge({
        hmacKey: altchaSettings.altchaSecret,
        maxnumber: altchaSettings.altchaDifficulty,
        expires: new Date(Date.now() - 1000),
      })
      expect(await provider.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('rejects a validly signed challenge that carries no expiry', async () => {
      const challenge = await createChallenge({
        hmacKey: altchaSettings.altchaSecret,
        maxnumber: altchaSettings.altchaDifficulty,
      })
      expect(await provider.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('does not burn a challenge when a payload for it is rejected', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      const token = await solveAltchaChallenge(challenge)
      const { number } = JSON.parse(atob(token)) as { number: number }
      const wrongAnswer = await solveAltchaChallenge(challenge, { number: number + 1 })
      expect(await provider.verify(wrongAnswer, context)).toBe(false)
      expect(await provider.verify(token, context)).toBe(true)
    })

    it('stores the expiry signed into the challenge, in milliseconds', async () => {
      const challenge = await createAltchaChallenge(altchaSettings)
      await provider.verify(await solveAltchaChallenge(challenge), context)
      const expires = Number(new URLSearchParams(challenge.salt.split('?')[1]).get('expires'))
      const [row] = await db.select().from(solvedCaptchaChallenges)
      expect(row!.expiresAt.getTime()).toBe(expires * 1000)
    })

    it('accepts exactly one of two concurrent submissions of one solution', async () => {
      const token = await solveAltchaChallenge(await createAltchaChallenge(altchaSettings))
      const results = await Promise.all([provider.verify(token, context), provider.verify(token, context)])
      expect(results.sort()).toEqual([false, true])
    })

    it('logs a reason code for each rejection, never the payload', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      const expired = await createChallenge({
        hmacKey: altchaSettings.altchaSecret,
        maxnumber: altchaSettings.altchaDifficulty,
        expires: new Date(Date.now() - 1000),
      })
      const noExpiry = await createChallenge({
        hmacKey: altchaSettings.altchaSecret,
        maxnumber: altchaSettings.altchaDifficulty,
      })
      const fresh = await solveAltchaChallenge(await createAltchaChallenge(altchaSettings))
      await provider.verify(fresh, context)

      for (const token of [null, await solveAltchaChallenge(noExpiry), await solveAltchaChallenge(expired), fresh]) {
        expect(await provider.verify(token, context)).toBe(false)
      }

      expect(warnSpy.mock.calls).toEqual([
        ['Captcha verification failed:', 'malformed'],
        ['Captcha verification failed:', 'no_expiry'],
        ['Captcha verification failed:', 'invalid'],
        ['Captcha verification failed:', 'replayed'],
      ])
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(fresh)
      warnSpy.mockRestore()
    })

    it('rejects a validly signed challenge using an algorithm other than SHA-256', async () => {
      const challenge = await createChallenge({
        algorithm: 'SHA-1',
        hmacKey: altchaSettings.altchaSecret,
        maxnumber: altchaSettings.altchaDifficulty,
        expires: new Date(Date.now() + 60_000),
      })
      expect(await provider.verify(await solveAltchaChallenge(challenge), context)).toBe(false)
    })

    it('signs a SHA-256 challenge with the configured difficulty and expiry', async () => {
      const before = Math.floor(Date.now() / 1000)
      const challenge = await createAltchaChallenge()
      expect(challenge.algorithm).toBe('SHA-256')
      expect(challenge.maxnumber).toBe(1000)
      const expires = Number(new URLSearchParams(challenge.salt.split('?')[1]).get('expires'))
      expect(expires).toBeGreaterThanOrEqual(before + 600)
      expect(expires).toBeLessThanOrEqual(before + 601)
    })
  })
})
