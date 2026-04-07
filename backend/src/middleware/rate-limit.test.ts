import { testDbManager } from '@/test-utils/db'
import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createAuthRateLimit, createInferenceRateLimit, type RateLimitSettings } from './rate-limit'

/**
 * Helper that creates a tiny Elysia app mimicking a session guard +
 * user-based rate limit.  When `userId` is provided the derive sets
 * a fake user context, otherwise the user is null (unauthenticated).
 */
const createTestApp = (database: typeof DbType, settings: RateLimitSettings, userId?: string) =>
  new Elysia()
    .derive(() => ({ user: userId ? { id: userId } : null }))
    .use(createInferenceRateLimit(database, settings))
    .get('/v1/test', () => ({ ok: true }))

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

  const enabledSettings: RateLimitSettings = { enabled: true, trustedProxy: '' }

  describe('user-based rate limiting', () => {
    it('should allow requests under the limit for an authenticated user', async () => {
      const app = createTestApp(database, enabledSettings, 'user-1')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
    })

    it('should return 429 after an authenticated user exceeds the limit', async () => {
      const app = createTestApp(database, enabledSettings, 'user-2')

      for (let i = 0; i < 20; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should set RateLimit headers on successful requests', async () => {
      const app = createTestApp(database, enabledSettings, 'user-3')

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.headers.get('ratelimit-limit')).toBe('20')
      expect(response.headers.get('ratelimit-remaining')).toBe('19')
      expect(response.headers.get('ratelimit-reset')).toBeTruthy()
    })

    it('should set Retry-After header on 429 responses', async () => {
      const app = createTestApp(database, enabledSettings, 'user-4')

      for (let i = 0; i < 20; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
    })

    it('should skip rate limiting when no user context is available', async () => {
      const app = createTestApp(database, enabledSettings)

      for (let i = 0; i < 25; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })

    it('should track limits independently per user', async () => {
      const appA = createTestApp(database, enabledSettings, 'user-5a')
      const appB = createTestApp(database, enabledSettings, 'user-5b')

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

  describe('disabled rate limiting', () => {
    it('should not rate limit when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false, trustedProxy: '' }
      const app = createTestApp(database, disabledSettings, 'user-6')

      for (let i = 0; i < 25; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })
  })

  describe('IP-based auth rate limiting', () => {
    const createAuthTestApp = (settings: RateLimitSettings) =>
      new Elysia()
        .use(createAuthRateLimit(settings))
        .post('/v1/api/auth/sign-in/email-otp', () => ({ ok: true }))
        .get('/v1/api/auth/get-session', () => ({ session: null }))

    it('should allow requests under the limit', async () => {
      const app = createAuthTestApp(enabledSettings)

      const response = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/email-otp', { method: 'POST' }),
      )

      expect(response.status).toBe(200)
    })

    it('should return 429 after exceeding the limit on auth paths', async () => {
      const app = createAuthTestApp(enabledSettings)

      for (let i = 0; i < 10; i++) {
        await app.handle(new Request('http://localhost/v1/api/auth/sign-in/email-otp', { method: 'POST' }))
      }

      const response = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in/email-otp', { method: 'POST' }),
      )

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should not rate limit non-abuse-prone auth paths', async () => {
      const app = createAuthTestApp(enabledSettings)

      // Exhaust the limit on sign-in
      for (let i = 0; i < 10; i++) {
        await app.handle(new Request('http://localhost/v1/api/auth/sign-in/email-otp', { method: 'POST' }))
      }

      // Session check should still work
      const response = await app.handle(new Request('http://localhost/v1/api/auth/get-session'))
      expect(response.status).toBe(200)
    })

    it('should not rate limit when disabled', async () => {
      const disabledSettings: RateLimitSettings = { enabled: false, trustedProxy: '' }
      const app = createAuthTestApp(disabledSettings)

      for (let i = 0; i < 15; i++) {
        const response = await app.handle(
          new Request('http://localhost/v1/api/auth/sign-in/email-otp', { method: 'POST' }),
        )
        expect(response.status).toBe(200)
      }
    })
  })
})
