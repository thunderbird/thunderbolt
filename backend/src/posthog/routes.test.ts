import type { Settings } from '@/config/settings'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createPostHogRoutes } from './routes'

const mockSettings: Settings = {
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'INFO',
  port: 8000,
  appUrl: 'http://localhost:1420',
  posthogHost: 'https://us.i.posthog.com',
  posthogApiKey: 'test-posthog-key',
  corsOrigins: 'http://localhost:1420',
  corsAllowCredentials: true,
  corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  corsAllowHeaders: 'Content-Type,Authorization',
  corsExposeHeaders: '',
  waitlistEnabled: false,
  waitlistAutoApproveDomains: '',
  powersyncUrl: '',
  powersyncJwtKid: '',
  powersyncJwtSecret: '',
  powersyncTokenExpirySeconds: 3600,
  authMode: 'consumer' as const,
  oidcClientId: '',
  oidcClientSecret: '',
  oidcIssuer: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  trustedProxy: 'cloudflare',
}

describe('PostHog Routes', () => {
  let mockFetch: ReturnType<typeof mock>

  const createApp = (fetchFn?: typeof fetch, settings?: Settings) =>
    new Elysia().use(createPostHogRoutes(fetchFn ?? (mockFetch as unknown as typeof fetch), settings ?? mockSettings))

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
  })

  describe('content-length check', () => {
    it('should return 413 when Content-Length exceeds 3MB', async () => {
      const app = createApp()
      const response = await app.handle(
        new Request('http://localhost/posthog/batch', {
          method: 'POST',
          headers: {
            'Content-Length': String(4 * 1024 * 1024),
            'CF-Connecting-IP': '1.2.3.4',
          },
        }),
      )

      expect(response.status).toBe(413)
      const body = await response.json()
      expect(body.error).toBe('Request body too large')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should proxy normally when Content-Length is under 3MB', async () => {
      const app = createApp()
      const response = await app.handle(
        new Request('http://localhost/posthog/batch', {
          method: 'POST',
          headers: {
            'Content-Length': '1024',
            'CF-Connecting-IP': '1.2.3.4',
          },
        }),
      )

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should proxy normally when Content-Length header is absent', async () => {
      const app = createApp()
      const response = await app.handle(
        new Request('http://localhost/posthog/e', {
          method: 'GET',
          headers: { 'CF-Connecting-IP': '1.2.3.4' },
        }),
      )

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('rate limiting', () => {
    it('should return 429 after exceeding the rate limit', async () => {
      const app = createApp()

      for (let i = 0; i < 60; i++) {
        await app.handle(
          new Request('http://localhost/posthog/batch', {
            method: 'POST',
            headers: { 'CF-Connecting-IP': '10.0.0.1' },
          }),
        )
      }

      const response = await app.handle(
        new Request('http://localhost/posthog/batch', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '10.0.0.1' },
        }),
      )

      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBeTruthy()
      const body = await response.json()
      expect(body.error).toBe('Too many requests. Please try again later.')
    })

    it('should include RateLimit-* headers on normal requests', async () => {
      const app = createApp()
      const response = await app.handle(
        new Request('http://localhost/posthog/batch', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '10.0.0.2' },
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('ratelimit-limit')).toBe('60')
      expect(response.headers.get('ratelimit-remaining')).toBeTruthy()
      expect(response.headers.get('ratelimit-reset')).toBeTruthy()
    })
  })

  describe('GET /config', () => {
    it('should return the PostHog API key', async () => {
      const app = createApp()
      const response = await app.handle(
        new Request('http://localhost/posthog/config', {
          method: 'GET',
          headers: { 'CF-Connecting-IP': '10.0.0.3' },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.public_posthog_api_key).toBe('test-posthog-key')
    })
  })
})
