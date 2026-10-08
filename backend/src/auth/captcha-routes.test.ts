/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { rateLimits } from '@/db/rate-limit-schema'
import { createApp } from '@/index'
import { solveAltchaChallenge } from '@/test-utils/altcha'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import type { Challenge } from 'altcha-lib/v1/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { captchaTokenHeader } from './captcha'

const envKeys = [
  'AUTH_ALLOW_ANONYMOUS',
  'CAPTCHA_PROVIDER',
  'CAPTCHA_SECRET',
  'CAPTCHA_DIFFICULTY',
  'RATE_LIMIT_ENABLED',
  'TRUSTED_PROXY',
  'ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX',
  'ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS',
] as const

describe('captcha challenge route and anonymous sign-in', () => {
  let savedEnv: Partial<Record<string, string>>
  let db: Awaited<ReturnType<typeof getSharedIsolatedTestDb>>['db']

  // RateLimiterDrizzle commits its own transactions, so this suite cannot use createTestDb.
  beforeAll(async () => {
    db = (await getSharedIsolatedTestDb()).db
  })

  beforeEach(async () => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
    process.env.AUTH_ALLOW_ANONYMOUS = 'true'
    process.env.CAPTCHA_PROVIDER = 'altcha'
    process.env.CAPTCHA_SECRET = 'altcha-test-secret-0123456789abcdef'
    process.env.CAPTCHA_DIFFICULTY = '1000'
    process.env.RATE_LIMIT_ENABLED = 'true'
    process.env.TRUSTED_PROXY = 'cloudflare'
    delete process.env.ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX
    delete process.env.ANONYMOUS_SIGN_IN_RATE_LIMIT_WINDOW_SECS
    clearSettingsCache()
    await db.delete(rateLimits)
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    clearSettingsCache()
  })

  const challengeRequest = (ip: string) =>
    new Request('http://localhost/v1/captcha/challenge', { headers: { 'cf-connecting-ip': ip } })

  const signInRequest = (ip: string, token?: string) =>
    new Request('http://localhost/v1/api/auth/sign-in/anonymous', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': ip,
        'content-type': 'application/json',
        ...(token && { [captchaTokenHeader]: token }),
      },
      body: '{}',
    })

  it('returns a signed SHA-256 challenge in the widget format', async () => {
    const app = await createApp({ database: db })
    const response = await app.handle(challengeRequest('198.51.100.20'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
    const body = (await response.json()) as Challenge
    expect(body).toEqual({
      algorithm: 'SHA-256',
      challenge: expect.stringMatching(/^[0-9a-f]{64}$/),
      maxnumber: 1000,
      salt: expect.stringMatching(/\?expires=\d+&$/),
      signature: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('is not mounted when the provider is none', async () => {
    process.env.CAPTCHA_PROVIDER = 'none'
    clearSettingsCache()
    const app = await createApp({ database: db })
    expect((await app.handle(challengeRequest('198.51.100.21'))).status).toBe(404)
  })

  it('rate limits per IP in its own bucket, sized like anonymous sign-in', async () => {
    process.env.ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX = '3'
    clearSettingsCache()
    const app = await createApp({ database: db })
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.handle(challengeRequest('198.51.100.22'))).status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
    const keys = (await db.select().from(rateLimits)).map((row) => row.key)
    expect(keys).toEqual(['captcha-challenge:ip:198.51.100.22'])
  })

  it('accepts a raised sign-in limit once the provider is altcha', async () => {
    process.env.ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX = '200'
    clearSettingsCache()
    const app = await createApp({ database: db })
    const response = await app.handle(challengeRequest('198.51.100.23'))
    expect(response.headers.get('ratelimit-limit')).toBe('200')
  })

  it('requires a solved, unused challenge for anonymous sign-in', async () => {
    const app = await createApp({ database: db })
    const ip = '198.51.100.24'

    expect((await app.handle(signInRequest(ip))).status).toBe(403)

    const challenge = (await (await app.handle(challengeRequest(ip))).json()) as Challenge
    const token = await solveAltchaChallenge(challenge)
    expect((await app.handle(signInRequest(ip, token))).status).toBe(200)
    expect((await app.handle(signInRequest(ip, token))).status).toBe(403)
  })
})
