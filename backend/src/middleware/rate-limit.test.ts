import { testDbManager } from '@/test-utils/db'
import type { db as DbType } from '@/db/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { sql } from 'drizzle-orm'
import { PostgresRateLimitContext, createStandardRateLimit } from './rate-limit'

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
    await database.execute(sql`DELETE FROM rate_limits`)
  })

  describe('PostgresRateLimitContext', () => {
    it('should increment count for a new IP', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      const result = await ctx.increment('192.168.1.1')

      expect(result.count).toBe(1)
      expect(result.nextReset).toBeInstanceOf(Date)
    })

    it('should increment count for subsequent requests from same IP', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      await ctx.increment('192.168.1.1')
      await ctx.increment('192.168.1.1')
      const result = await ctx.increment('192.168.1.1')

      expect(result.count).toBe(3)
    })

    it('should track IPs independently', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      await ctx.increment('192.168.1.1')
      await ctx.increment('192.168.1.1')
      const result = await ctx.increment('10.0.0.1')

      expect(result.count).toBe(1)
    })

    it('should decrement count', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      await ctx.increment('192.168.1.1')
      await ctx.increment('192.168.1.1')
      await ctx.increment('192.168.1.1')
      await ctx.decrement('192.168.1.1')

      const result = await ctx.increment('192.168.1.1')
      expect(result.count).toBe(3) // 3 - 1 + 1 = 3
    })

    it('should reset a specific IP', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      await ctx.increment('192.168.1.1')
      await ctx.increment('192.168.1.1')
      await ctx.reset('192.168.1.1')

      const result = await ctx.increment('192.168.1.1')
      expect(result.count).toBe(1)
    })

    it('should reset all IPs', async () => {
      const ctx = new PostgresRateLimitContext(database)
      ctx.init({
        duration: 60_000,
        max: 100,
        errorResponse: '',
        scoping: 'global',
        countFailedRequest: false,
        generator: () => '',
        skip: () => false,
        headers: true,
      })

      await ctx.increment('192.168.1.1')
      await ctx.increment('10.0.0.1')
      await ctx.reset()

      const result1 = await ctx.increment('192.168.1.1')
      const result2 = await ctx.increment('10.0.0.1')
      expect(result1.count).toBe(1)
      expect(result2.count).toBe(1)
    })
  })

  describe('createStandardRateLimit integration', () => {
    const rateLimitSettings = {
      enabled: true,
      inference: { max: 20, duration: 60_000 },
      auth: { max: 10, duration: 900_000 },
      standard: { max: 5, duration: 60_000 },
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

    it('should exempt health endpoint', async () => {
      const app = createTestApp()

      // Exhaust the limit
      for (let i = 0; i < 6; i++) {
        await app.handle(new Request('http://localhost/v1/test'))
      }

      // Health should still work
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
      const disabledSettings = { ...rateLimitSettings, enabled: false }
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
