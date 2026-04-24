import { testDbManager } from '@/test-utils/db'
import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import {
  createAuthIpRateLimit,
  createInferenceRateLimit,
  createProRateLimit,
  type IpRateLimitSettings,
  type RateLimitSettings,
} from './rate-limit'

/**
 * Helper that creates a tiny Elysia app with a given rate limit middleware.
 * When `userId` is provided the derive sets a fake user context, otherwise
 * the user is null (unauthenticated).
 */
const createTestApp = (
  database: typeof DbType,
  settings: RateLimitSettings,
  middleware: (db: typeof DbType, s: RateLimitSettings) => ReturnType<typeof createInferenceRateLimit>,
  userId?: string,
) =>
  new Elysia()
    .derive(() => ({ user: userId ? { id: userId } : null }))
    .use(middleware(database, settings))
    .get('/v1/test', () => ({ ok: true }))

/** Helper that creates a test app with IP-based rate limiting (trustedProxy=cloudflare). */
const createIpTestApp = (database: typeof DbType, settings: IpRateLimitSettings) =>
  new Elysia().use(createAuthIpRateLimit(database, settings)).get('/v1/test', () => ({ ok: true }))

/** Build a request with a given client IP via the CF-Connecting-IP header. */
const requestWithIp = (ip: string) => new Request('http://localhost/v1/test', { headers: { 'cf-connecting-ip': ip } })

describe('Rate Limiting', () => {
  let database: typeof DbType
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    await testDbManager.initialize()
    const testDb = await testDbManager.createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
  })

  afterAll(async () => {
    await cleanup()
  })

  beforeEach(async () => {
    await database.delete(rateLimits)
  })

  const enabledSettings: RateLimitSettings = { enabled: true }

  describe('user-based rate limiting', () => {
    it('should allow requests under the limit for an authenticated user', async () => {
      const app = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-1')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
    })

    it('should return 429 after an authenticated user exceeds the limit', async () => {
      const app = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-2')

      for (let i = 0; i < 20; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should set RateLimit headers on successful requests', async () => {
      const app = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-3')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.headers.get('ratelimit-limit')).toBe('20')
      expect(response.headers.get('ratelimit-remaining')).toBe('19')
      expect(response.headers.get('ratelimit-reset')).toBeTruthy()
    })

    it('should set Retry-After header on 429 responses', async () => {
      const app = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-4')

      for (let i = 0; i < 20; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
    })

    it('should skip rate limiting when no user context is available', async () => {
      const app = createTestApp(database, enabledSettings, createInferenceRateLimit)

      for (let i = 0; i < 25; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should track limits independently per user', async () => {
      const appA = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-5a')
      const appB = createTestApp(database, enabledSettings, createInferenceRateLimit, 'user-5b')

      // Exhaust user A's limit
      for (let i = 0; i < 20; i++) {
        await appA.handle(new Request('http://localhost/v1/test'))
      }

      const blockedResponse = await appA.handle(new Request('http://localhost/v1/test'))
      expect(blockedResponse.status).toBe(429)

      // User B should still be allowed
      const allowedResponse = await appB.handle(new Request('http://localhost/v1/test'))
      expect(allowedResponse.status).toBe(200)
    })
  })

  describe('pro rate limiting', () => {
    it('should allow requests under the pro tier limit', async () => {
      const app = createTestApp(database, enabledSettings, createProRateLimit, 'pro-user-1')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('50')
      expect(response.headers.get('ratelimit-remaining')).toBe('49')
    })

    it('should return 429 after exceeding the pro tier limit', async () => {
      const app = createTestApp(database, enabledSettings, createProRateLimit, 'pro-user-2')

      for (let i = 0; i < 50; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should track limits independently from inference tier', async () => {
      const inferenceApp = createTestApp(database, enabledSettings, createInferenceRateLimit, 'shared-user')
      const proApp = createTestApp(database, enabledSettings, createProRateLimit, 'shared-user')

      // Exhaust inference limit (20 requests)
      for (let i = 0; i < 20; i++) {
        await inferenceApp.handle(new Request('http://localhost/v1/test'))
      }
      const blockedInference = await inferenceApp.handle(new Request('http://localhost/v1/test'))
      expect(blockedInference.status).toBe(429)

      // Pro should still work (separate tier/prefix)
      const allowedPro = await proApp.handle(new Request('http://localhost/v1/test'))
      expect(allowedPro.status).toBe(200)
    })
  })

  describe('disabled rate limiting', () => {
    it('should not rate limit when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false }
      const app = createTestApp(database, disabledSettings, createInferenceRateLimit, 'user-6')

      for (let i = 0; i < 25; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should not rate limit pro tier when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false }
      const app = createTestApp(database, disabledSettings, createProRateLimit, 'user-disabled-pro')

      for (let i = 0; i < 55; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })
  })

  describe('IP-based rate limiting', () => {
    const ipSettings: IpRateLimitSettings = { enabled: true, trustedProxy: 'cloudflare' }

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

    it('should skip rate limiting when IP is unknown (no proxy header, no socket)', async () => {
      const app = createIpTestApp(database, ipSettings)

      // Request without cf-connecting-ip header — extractClientIp returns the socket IP fallback.
      // In test (no real server), socket IP is 'unknown', so rate limiting is skipped.
      for (let i = 0; i < 15; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should track independently from user-based tiers', async () => {
      const app = new Elysia()
        .derive(() => ({ user: { id: 'shared-ip-user' } }))
        .use(createAuthIpRateLimit(database, ipSettings))
        .use(createInferenceRateLimit(database, enabledSettings))
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
})
