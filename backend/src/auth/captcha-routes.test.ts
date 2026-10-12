/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache, getSettings } from '@/config/settings'
import { createErrorResponse } from '@/middleware/error-handling'
import { rateLimits } from '@/db/rate-limit-schema'
import { createApp } from '@/index'
import { solveAltchaChallenge } from '@/test-utils/altcha'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import type { Challenge } from 'altcha-lib/v1/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { captchaTokenHeader, createCaptchaProvider } from './captcha'
import { createCaptchaRoutes } from './captcha-routes'

const envKeys = [
  'AUTH_ALLOW_ANONYMOUS',
  'CAPTCHA_PROVIDER',
  'ALTCHA_SECRET',
  'ALTCHA_DIFFICULTY',
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
    process.env.ALTCHA_SECRET = 'altcha-test-secret-0123456789abcdef'
    process.env.ALTCHA_DIFFICULTY = '50000'
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
    const body = (await response.json()) as Challenge
    expect(body).toEqual({
      algorithm: 'SHA-256',
      challenge: expect.stringMatching(/^[0-9a-f]{64}$/),
      maxnumber: 50000,
      salt: expect.stringMatching(/\?expires=\d+&$/),
      signature: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it.each([
    ['the provider issues no challenges', 'none', true],
    ['anonymous auth is off', 'altcha', false],
  ] as const)('mounts no route and builds no limiter when %s', async (_label, captchaProvider, authAllowAnonymous) => {
    const createIpRateLimit = mock(() => new Elysia())
    const routes = createCaptchaRoutes({
      provider: createCaptchaProvider({ ...getSettings(), captchaProvider }, db),
      authAllowAnonymous,
      createIpRateLimit,
    })
    expect((await routes.handle(new Request('http://localhost/captcha/challenge'))).status).toBe(404)
    expect(createIpRateLimit).not.toHaveBeenCalled()
  })

  it('mounts the route and its limiter when the provider issues challenges and anonymous auth is on', async () => {
    const createIpRateLimit = mock(() => new Elysia())
    const routes = createCaptchaRoutes({
      provider: createCaptchaProvider(getSettings(), db),
      authAllowAnonymous: true,
      createIpRateLimit,
    })
    expect((await routes.handle(new Request('http://localhost/captcha/challenge'))).status).toBe(200)
    expect(createIpRateLimit).toHaveBeenCalledTimes(1)
  })

  it('is not mounted when the provider is none', async () => {
    process.env.CAPTCHA_PROVIDER = 'none'
    clearSettingsCache()
    const app = await createApp({ database: db })
    expect((await app.handle(challengeRequest('198.51.100.21'))).status).toBe(404)
  })

  it('is not mounted when anonymous auth is off', async () => {
    process.env.AUTH_ALLOW_ANONYMOUS = 'false'
    clearSettingsCache()
    const app = await createApp({ database: db })
    expect((await app.handle(challengeRequest('198.51.100.26'))).status).toBe(404)
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

  it('sizes the challenge bucket from ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX, like the sign-in bucket', async () => {
    process.env.ANONYMOUS_SIGN_IN_RATE_LIMIT_MAX = '200'
    clearSettingsCache()
    const app = await createApp({ database: db })
    const challenge = await app.handle(challengeRequest('198.51.100.23'))
    const signIn = await app.handle(signInRequest('198.51.100.23'))
    expect(challenge.headers.get('ratelimit-limit')).toBe('200')
    expect(signIn.headers.get('ratelimit-limit')).toBe('200')
  })

  it('answers a limiter failure with the safe error envelope, leaking nothing from the query', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const throwingLimiter = new Elysia()
      .onBeforeHandle(() => {
        throw new DrizzleQueryError('select "points" from "rate_limits" where "key" = $1', ['ip:198.51.100.25'])
      })
      .as('scoped')
    const routes = createCaptchaRoutes({
      provider: createCaptchaProvider(getSettings(), db),
      authAllowAnonymous: true,
      createIpRateLimit: () => throwingLimiter,
    })

    const response = await routes.handle(new Request('http://localhost/captcha/challenge'))
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toEqual(createErrorResponse('Internal Server Error'))
    expect(text).not.toContain('rate_limits')
    expect(text).not.toContain('198.51.100.25')
    errorSpy.mockRestore()
  })

  /** Points drawn from the deployment-wide anonymous sign-in budget, or null before the first. */
  const globalBudgetPoints = async () => {
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, 'anonymous-sign-in-global:all'))
    return row?.points ?? null
  }

  it('leaves the deployment-wide budget untouched for sign-ins that fail the captcha', async () => {
    const app = await createApp({ database: db })
    for (let i = 0; i < 5; i++) {
      expect((await app.handle(signInRequest('198.51.100.27'))).status).toBe(403)
    }
    expect(await globalBudgetPoints()).toBeNull()
  })

  it('charges the deployment-wide budget once per sign-in that passes the captcha', async () => {
    const app = await createApp({ database: db })
    const ip = '198.51.100.28'
    const challenge = (await (await app.handle(challengeRequest(ip))).json()) as Challenge
    const token = await solveAltchaChallenge(challenge)

    expect((await app.handle(signInRequest(ip, token))).status).toBe(200)
    expect(await globalBudgetPoints()).toBe(1)
    // The replay fails the captcha, so it is not charged either.
    expect((await app.handle(signInRequest(ip, token))).status).toBe(403)
    expect(await globalBudgetPoints()).toBe(1)
  })

  it('requires a solved, unused challenge for anonymous sign-in', async () => {
    const app = await createApp({ database: db })
    const ip = '198.51.100.24'

    const missing = await app.handle(signInRequest(ip))
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual({
      message: 'Captcha verification failed',
      code: 'CAPTCHA_VERIFICATION_FAILED',
    })

    const challenge = (await (await app.handle(challengeRequest(ip))).json()) as Challenge
    const token = await solveAltchaChallenge(challenge)
    expect((await app.handle(signInRequest(ip, token))).status).toBe(200)
    expect((await app.handle(signInRequest(ip, token))).status).toBe(403)
  })
})
