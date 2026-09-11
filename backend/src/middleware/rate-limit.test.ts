/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSharedIsolatedTestDb } from '@/test-utils/db'
import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { createInferenceUsageReceiptRoutes } from '@/inference/usage-receipt-routes'
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mockAuth } from '@/test-utils/mock-auth'
import { inferenceUsageReceiptPath } from '@shared/inference-usage'
import { Elysia } from 'elysia'
import {
  createAuthIpRateLimit,
  createIpTierRateLimit,
  createRateLimitConsumer,
  createUserTierRateLimit,
  type IpRateLimitSettings,
  type RateLimitSettings,
  type UserRateLimitTier,
} from './rate-limit'

/**
 * Helper that creates a tiny Elysia app with a given rate limit middleware.
 * When `userId` is provided the derive sets a fake user context, otherwise
 * the user is null (unauthenticated).
 */
const createTestApp = (
  database: typeof DbType,
  settings: RateLimitSettings,
  tier: UserRateLimitTier,
  userId?: string,
) =>
  new Elysia()
    .derive(() => ({ user: userId ? { id: userId } : null }))
    .use(createUserTierRateLimit(database, settings, tier))
    .get('/v1/test', () => ({ ok: true }))

/** Helper that creates a test app with IP-based rate limiting (trustedProxy=cloudflare). */
const createIpTestApp = (database: typeof DbType, settings: IpRateLimitSettings) =>
  new Elysia().use(createAuthIpRateLimit(database, settings)).get('/v1/test', () => ({ ok: true }))

/** Build a request with a given client IP via the CF-Connecting-IP header. */
const requestWithIp = (ip: string) => new Request('http://localhost/v1/test', { headers: { 'cf-connecting-ip': ip } })

describe('Rate Limiting', () => {
  let database: typeof DbType

  // RateLimiterDrizzle issues its own `client.transaction()` calls, which open a
  // nested raw BEGIN on the connection. On the shared `createTestDb` singleton
  // (which is mid-BEGIN/ROLLBACK and serializes every test file through one WASM
  // mutex) that breaks transaction isolation and, under CI CPU starvation, stalls
  // the setup hook on the shared lock. Reuse the suite-wide isolated connection:
  // creating a fresh PGlite for every `--rerun-each` pass accumulates WASM runtimes
  // until initialization stalls. Each test still clears the table in beforeEach.
  beforeAll(async () => {
    const isolatedDb = await getSharedIsolatedTestDb()
    database = isolatedDb.db
  })

  beforeEach(async () => {
    await database.delete(rateLimits)
  })

  const enabledSettings: RateLimitSettings = { enabled: true }

  describe('user-based rate limiting', () => {
    it('should allow requests under the limit for an authenticated user', async () => {
      const app = createTestApp(database, enabledSettings, 'inference', 'user-1')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
    })

    it('should return 429 after an authenticated user exceeds the limit', async () => {
      const app = createTestApp(database, enabledSettings, 'inference', 'user-2')

      for (let i = 0; i < 60; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should set RateLimit headers on successful requests', async () => {
      const app = createTestApp(database, enabledSettings, 'inference', 'user-3')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.headers.get('ratelimit-limit')).toBe('60')
      expect(response.headers.get('ratelimit-remaining')).toBe('59')
      expect(response.headers.get('ratelimit-reset')).toBeTruthy()
    })

    it('should set Retry-After header on 429 responses', async () => {
      const app = createTestApp(database, enabledSettings, 'inference', 'user-4')

      for (let i = 0; i < 60; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
    })

    it('should skip rate limiting when no user context is available', async () => {
      const app = createTestApp(database, enabledSettings, 'inference')

      for (let i = 0; i < 65; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should track limits independently per user', async () => {
      const appA = createTestApp(database, enabledSettings, 'inference', 'user-5a')
      const appB = createTestApp(database, enabledSettings, 'inference', 'user-5b')

      // Exhaust user A's limit
      for (let i = 0; i < 60; i++) {
        await appA.handle(new Request('http://localhost/v1/test'))
      }

      const blockedResponse = await appA.handle(new Request('http://localhost/v1/test'))
      expect(blockedResponse.status).toBe(429)

      // User B should still be allowed
      const allowedResponse = await appB.handle(new Request('http://localhost/v1/test'))
      expect(allowedResponse.status).toBe(200)
    })
  })

  describe('inference receipt rate limiting', () => {
    it('allows full receipt and pro throughput independently before rate limiting each bucket', async () => {
      const userId = 'receipt-pro-shared-user'
      const receiptApp = createTestApp(database, enabledSettings, 'receipt', userId)
      const proApp = createTestApp(database, enabledSettings, 'pro', userId)

      for (let i = 0; i < 100; i++) {
        expect((await receiptApp.handle(new Request('http://localhost/v1/test'))).status).toBe(200)
        expect((await proApp.handle(new Request('http://localhost/v1/test'))).status).toBe(200)
      }

      expect((await receiptApp.handle(new Request('http://localhost/v1/test'))).status).toBe(429)
      expect((await proApp.handle(new Request('http://localhost/v1/test'))).status).toBe(429)
    })

    it('does not consume the inference request bucket', async () => {
      const userId = 'receipt-inference-shared-user'
      const receiptApp = createTestApp(database, enabledSettings, 'receipt', userId)
      const inferenceApp = createTestApp(database, enabledSettings, 'inference', userId)

      const receiptResponse = await receiptApp.handle(new Request('http://localhost/v1/test'))
      const inferenceResponse = await inferenceApp.handle(new Request('http://localhost/v1/test'))

      expect(receiptResponse.headers.get('ratelimit-remaining')).toBe('99')
      expect(inferenceResponse.headers.get('ratelimit-remaining')).toBe('59')
    })

    it('enforces the authenticated receipt route without rate-limiting a sibling route', async () => {
      const app = new Elysia()
        .use(
          createInferenceUsageReceiptRoutes({
            auth: mockAuth,
            database,
            secret: 'rate-limit-test-secret',
            rateLimit: createUserTierRateLimit(database, enabledSettings, 'receipt'),
          }),
        )
        .get('/unrelated', () => 'ok')
      const createReceiptRequest = () =>
        new Request(`http://localhost/${inferenceUsageReceiptPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })

      for (let i = 0; i < 100; i++) {
        expect((await app.handle(createReceiptRequest())).status).toBe(400)
      }

      expect((await app.handle(createReceiptRequest())).status).toBe(429)
      const unrelatedResponse = await app.handle(new Request('http://localhost/unrelated'))
      expect(unrelatedResponse.status).toBe(200)
      expect(unrelatedResponse.headers.get('ratelimit-limit')).toBeNull()
    })
  })

  describe('pro rate limiting', () => {
    it('should allow requests under the pro tier limit', async () => {
      const app = createTestApp(database, enabledSettings, 'pro', 'pro-user-1')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('100')
      expect(response.headers.get('ratelimit-remaining')).toBe('99')
    })

    it('should return 429 after exceeding the pro tier limit', async () => {
      const app = createTestApp(database, enabledSettings, 'pro', 'pro-user-2')

      for (let i = 0; i < 100; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should track limits independently from inference tier', async () => {
      const inferenceApp = createTestApp(database, enabledSettings, 'inference', 'shared-user')
      const proApp = createTestApp(database, enabledSettings, 'pro', 'shared-user')

      // Exhaust inference limit (60 requests)
      for (let i = 0; i < 60; i++) {
        await inferenceApp.handle(new Request('http://localhost/v1/test'))
      }
      const blockedInference = await inferenceApp.handle(new Request('http://localhost/v1/test'))
      expect(blockedInference.status).toBe(429)

      // Pro should still work (separate tier/prefix)
      const allowedPro = await proApp.handle(new Request('http://localhost/v1/test'))
      expect(allowedPro.status).toBe(200)
    })
  })

  describe('debug transcript rate limiting', () => {
    it('allows ten uploads per user each hour', async () => {
      const app = createTestApp(database, enabledSettings, 'debug-transcript', 'transcript-user')

      for (let index = 0; index < 10; index++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }

      const blockedResponse = await app.handle(new Request('http://localhost/v1/test'))

      expect(blockedResponse.status).toBe(429)
      expect(blockedResponse.headers.get('ratelimit-limit')).toBe('10')
      expect(Number(blockedResponse.headers.get('ratelimit-reset'))).toBeGreaterThan(3500)
    })
  })

  describe('disabled rate limiting', () => {
    it('should not rate limit when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false }
      const app = createTestApp(database, disabledSettings, 'inference', 'user-6')

      for (let i = 0; i < 65; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should not rate limit pro tier when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false }
      const app = createTestApp(database, disabledSettings, 'pro', 'user-disabled-pro')

      for (let i = 0; i < 105; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })
  })

  describe('IP-based rate limiting', () => {
    const ipSettings: IpRateLimitSettings = { enabled: true, trustedProxy: 'cloudflare' }

    it('returns an empty IP tier plugin when disabled', async () => {
      const plugin = createIpTierRateLimit(database, { ...ipSettings, enabled: false }, 'debug-transcript-intake')
      expect(plugin.routes).toHaveLength(0)
      const app = new Elysia().use(plugin).get('/v1/test', () => ({ ok: true }))
      const response = await app.handle(requestWithIp('10.4.0.1'))
      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBeNull()
      expect(await database.select().from(rateLimits)).toHaveLength(0)
    })

    it('allows 600 intake requests per IP each hour independently of other IPs', async () => {
      const app = new Elysia()
        .use(createIpTierRateLimit(database, ipSettings, 'debug-transcript-intake'))
        .get('/v1/test', () => ({ ok: true }))

      for (let index = 0; index < 600; index++) {
        expect((await app.handle(requestWithIp('10.4.0.1'))).status).toBe(200)
      }
      const blocked = await app.handle(requestWithIp('10.4.0.1'))
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('ratelimit-limit')).toBe('600')
      expect(Number(blocked.headers.get('ratelimit-reset'))).toBeGreaterThan(3500)
      expect((await app.handle(requestWithIp('10.4.0.2'))).status).toBe(200)
    })

    it('should allow requests under the limit for an IP', async () => {
      const app = createIpTestApp(database, ipSettings)

      const response = await app.handle(requestWithIp('10.0.0.1'))

      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('10')
      expect(response.headers.get('ratelimit-remaining')).toBe('9')
    })

    it('should return 429 after an IP exceeds the limit', async () => {
      const app = createIpTestApp(database, ipSettings)

      for (let i = 0; i < 10; i++) {
        await app.handle(requestWithIp('10.0.0.2'))
      }

      const response = await app.handle(requestWithIp('10.0.0.2'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should set Retry-After header on 429 responses', async () => {
      const app = createIpTestApp(database, ipSettings)

      for (let i = 0; i < 10; i++) {
        await app.handle(requestWithIp('10.0.0.3'))
      }

      const response = await app.handle(requestWithIp('10.0.0.3'))

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
    })

    it('should track limits independently per IP', async () => {
      const app = createIpTestApp(database, ipSettings)

      // Exhaust IP A's limit
      for (let i = 0; i < 10; i++) {
        await app.handle(requestWithIp('10.0.0.4'))
      }

      const blockedResponse = await app.handle(requestWithIp('10.0.0.4'))
      expect(blockedResponse.status).toBe(429)

      // IP B should still be allowed
      const allowedResponse = await app.handle(requestWithIp('10.0.0.5'))
      expect(allowedResponse.status).toBe(200)
    })

    it('should fail CLOSED when IP is unknown — throttle via a shared bucket instead of skipping', async () => {
      const app = createIpTestApp(database, ipSettings)

      // Request without cf-connecting-ip header — extractClientIp returns the socket IP fallback.
      // In test (no real server), socket IP is 'unknown'. Unidentifiable traffic must NOT bypass
      // the limit: it shares a single `ip:unknown` bucket and gets a 429 past the threshold.
      for (let i = 0; i < 10; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }

      const blocked = await app.handle(new Request('http://localhost/v1/test'))
      expect(blocked.status).toBe(429)
      const body = await blocked.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should isolate the shared unknown bucket from identifiable IPs (no funnelling of real clients)', async () => {
      const app = createIpTestApp(database, ipSettings)

      // Exhaust the shared `ip:unknown` bucket with unidentifiable requests.
      for (let i = 0; i < 10; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }
      expect((await app.handle(new Request('http://localhost/v1/test'))).status).toBe(429)

      // A request with a resolvable IP keeps its own bucket and is unaffected.
      expect((await app.handle(requestWithIp('10.2.0.1'))).status).toBe(200)
    })

    it('should track independently from user-based tiers', async () => {
      const app = new Elysia()
        .derive(() => ({ user: { id: 'shared-ip-user' } }))
        .use(createAuthIpRateLimit(database, ipSettings))
        .use(createUserTierRateLimit(database, enabledSettings, 'inference'))
        .get('/v1/test', () => ({ ok: true }))

      // Exhaust IP limit (10 requests)
      for (let i = 0; i < 10; i++) {
        await app.handle(requestWithIp('10.0.0.6'))
      }
      const blockedByIp = await app.handle(requestWithIp('10.0.0.6'))
      expect(blockedByIp.status).toBe(429)

      // User-based inference limit should still work from a different IP
      const allowedByUser = await app.handle(requestWithIp('10.0.0.7'))
      expect(allowedByUser.status).toBe(200)
    })

    it('should not rate limit when disabled', async () => {
      const disabledSettings: IpRateLimitSettings = { enabled: false, trustedProxy: 'cloudflare' }
      const app = createIpTestApp(database, disabledSettings)

      for (let i = 0; i < 15; i++) {
        const response = await app.handle(requestWithIp('10.0.0.8'))
        expect(response.status).toBe(200)
      }
    })
  })

  describe('IP rate limiting with fetch handlers (mount bypass regression)', () => {
    const ipSettings: IpRateLimitSettings = { enabled: true, trustedProxy: 'cloudflare' }

    /** Minimal WinterCG-compatible fetch handler (simulates Better Auth's auth.handler). */
    const fakeFetchHandler = (_req: Request) =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })

    it('should enforce rate limits on a fetch handler routed via .all()', async () => {
      const app = new Elysia()
        .use(createAuthIpRateLimit(database, ipSettings))
        .all('/*', ({ request }) => fakeFetchHandler(request), { parse: 'none' })

      for (let i = 0; i < 10; i++) {
        const resp = await app.handle(requestWithIp('10.3.0.1'))
        expect(resp.status).toBe(200)
      }

      const blocked = await app.handle(requestWithIp('10.3.0.1'))
      expect(blocked.status).toBe(429)
    })

    it('should set rate limit headers on responses from fetch handlers', async () => {
      const app = new Elysia()
        .use(createAuthIpRateLimit(database, ipSettings))
        .all('/*', ({ request }) => fakeFetchHandler(request), { parse: 'none' })

      const response = await app.handle(requestWithIp('10.3.0.2'))

      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('10')
      expect(response.headers.get('ratelimit-remaining')).toBe('9')
    })

    it('should track IPs independently for fetch handler routes', async () => {
      const app = new Elysia()
        .use(createAuthIpRateLimit(database, ipSettings))
        .all('/*', ({ request }) => fakeFetchHandler(request), { parse: 'none' })

      // Exhaust IP A
      for (let i = 0; i < 10; i++) {
        await app.handle(requestWithIp('10.3.0.3'))
      }
      expect((await app.handle(requestWithIp('10.3.0.3'))).status).toBe(429)

      // IP B should still be allowed
      expect((await app.handle(requestWithIp('10.3.0.4'))).status).toBe(200)
    })

    it('should enforce rate limits when rate limiter is .use()d on a plugin with a fetch handler', async () => {
      // Mirrors the createBetterAuthPlugin pattern: plugin.use(ipRateLimit) then plugin.all(...)
      const plugin = new Elysia({ name: 'test-auth-plugin' })
        .use(createAuthIpRateLimit(database, ipSettings))
        .all('/*', ({ request }) => fakeFetchHandler(request), { parse: 'none' })

      const app = new Elysia().use(plugin)

      for (let i = 0; i < 10; i++) {
        const resp = await app.handle(requestWithIp('10.3.0.5'))
        expect(resp.status).toBe(200)
      }

      const blocked = await app.handle(requestWithIp('10.3.0.5'))
      expect(blocked.status).toBe(429)
    })
  })
  describe('createRateLimitConsumer', () => {
    it('returns null when rate limiting is disabled', () => {
      expect(createRateLimitConsumer(database, { enabled: false }, 'debug-transcript-intake')).toBeNull()
    })

    it('limits each key independently and reports 429 through set', async () => {
      const consume = createRateLimitConsumer(database, enabledSettings, 'debug-transcript-intake')!
      const set = {
        headers: {} as Record<string, string | string[] | number>,
        status: undefined as number | string | undefined,
      }

      for (let i = 0; i < 600; i++) {
        expect(await consume('client:a', set)).toBeUndefined()
      }
      expect(await consume('client:a', set)).toEqual({ error: 'Too many requests. Please try again later.' })
      expect(set.status).toBe(429)

      const other = {
        headers: {} as Record<string, string | string[] | number>,
        status: undefined as number | string | undefined,
      }
      expect(await consume('client:b', other)).toBeUndefined()
    })
  })
})
