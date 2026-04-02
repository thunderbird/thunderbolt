import { testDbManager } from '@/test-utils/db'
import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createStandardRateLimit, type RateLimitSettings } from './rate-limit'

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

  describe('createStandardRateLimit integration', () => {
    const rateLimitSettings: RateLimitSettings = {
      enabled: true,
      inference: { max: 20, durationSecs: 60 },
      auth: { max: 10, durationSecs: 900 },
      standard: { max: 5, durationSecs: 60 },
      trustedProxy: '',
    }

    const createTestApp = () =>
      new Elysia()
        .use(createStandardRateLimit(database, rateLimitSettings))
        .get('/v1/test', () => ({ ok: true }))
        .get('/v1/health', () => ({ status: 'ok' }))
        .get('/v1/posthog/config', () => ({ config: true }))
        .get('/v1/api/auth/get-session', () => ({ session: null }))

    it('should allow requests under the limit', async () => {
      const app = createTestApp()

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(200)
    })

    it('should return 429 after exceeding the limit', async () => {
      const app = createTestApp()

      for (let i = 0; i < 5; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should set RateLimit headers on successful requests', async () => {
      const app = createTestApp()

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.headers.get('ratelimit-limit')).toBe('5')
      expect(response.headers.get('ratelimit-remaining')).toBe('4')
      expect(response.headers.get('ratelimit-reset')).toBeTruthy()
    })

    it('should set Retry-After header on 429 responses', async () => {
      const app = createTestApp()

      for (let i = 0; i < 5; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/test'))

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
    })

    it('should exempt health endpoint', async () => {
      const app = createTestApp()

      for (let i = 0; i < 6; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/health'))
      expect(response.status).toBe(200)
    })

    it('should exempt posthog endpoints', async () => {
      const app = createTestApp()

      for (let i = 0; i < 6; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/posthog/config'))
      expect(response.status).toBe(200)
    })

    it('should exempt session check endpoint', async () => {
      const app = createTestApp()

      for (let i = 0; i < 6; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      const response = await app.handle(new Request('http://localhost/v1/api/auth/get-session'))
      expect(response.status).toBe(200)
    })

    it('should not rate limit when disabled', async () => {
      const disabledSettings: RateLimitSettings = { ...rateLimitSettings, enabled: false }
      const app = new Elysia()
        .use(createStandardRateLimit(database, disabledSettings))
        .get('/v1/test', () => ({ ok: true }))

      for (let i = 0; i < 10; i++) {
        const response = await app.handle(new Request('http://localhost/v1/test'))
        expect(response.status).toBe(200)
      }
    })
  })
})
