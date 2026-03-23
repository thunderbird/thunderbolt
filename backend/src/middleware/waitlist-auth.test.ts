import type { Settings } from '@/config/settings'
import type { Auth } from '@/auth/auth'
import { Elysia } from 'elysia'
import { describe, expect, it, mock } from 'bun:test'
import { createWaitlistAuthMiddleware } from './waitlist-auth'

const createMockSettings = (overrides: Partial<Settings> = {}): Settings => ({
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
  posthogApiKey: '',
  corsOrigins: 'http://localhost:1420',
  corsOriginRegex: '',
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
  ...overrides,
})

const createMockAuth = (hasSession: boolean): Auth =>
  ({
    api: {
      getSession: mock(() =>
        Promise.resolve(
          hasSession ? { user: { id: 'user-123', email: 'test@example.com' }, session: { id: 'session-123' } } : null,
        ),
      ),
    },
  }) as unknown as Auth

describe('Waitlist Auth Middleware', () => {
  describe('when WAITLIST_ENABLED=false', () => {
    it('should allow all requests without authentication', async () => {
      const settings = createMockSettings({ waitlistEnabled: false })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .get('/v1/inference/test', () => ({ data: 'protected' }))

      const response = await app.handle(new Request('http://localhost/v1/inference/test'))

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ data: 'protected' })
    })
  })

  describe('when WAITLIST_ENABLED=true', () => {
    it('should block unauthenticated requests to protected routes with 401', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .get('/v1/inference/test', () => ({ data: 'protected' }))

      const response = await app.handle(new Request('http://localhost/v1/inference/test'))

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body).toEqual({ error: 'Authentication required' })
    })

    it('should allow authenticated requests to protected routes', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(true) // Has session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .get('/v1/inference/test', () => ({ data: 'protected' }))

      const response = await app.handle(new Request('http://localhost/v1/inference/test'))

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ data: 'protected' })
    })

    it('should always allow /v1/waitlist endpoints without auth', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .post('/v1/waitlist/join', () => ({ success: true }))

      const response = await app.handle(
        new Request('http://localhost/v1/waitlist/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ success: true })
    })

    it('should always allow /v1/health endpoint without auth (exact match)', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .get('/v1/health', () => ({ status: 'ok' }))

      const response = await app.handle(new Request('http://localhost/v1/health'))

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ status: 'ok' })
    })

    it('should NOT allow /v1/health-admin (boundary check)', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .get('/v1/health-admin', () => ({ status: 'admin' }))

      const response = await app.handle(new Request('http://localhost/v1/health-admin'))

      expect(response.status).toBe(401)
    })

    it('should always allow /v1/api/auth endpoints without auth', async () => {
      const settings = createMockSettings({ waitlistEnabled: true })
      const auth = createMockAuth(false) // No session

      const app = new Elysia()
        .use(createWaitlistAuthMiddleware(settings, auth))
        .post('/v1/api/auth/sign-in', () => ({ success: true }))

      const response = await app.handle(
        new Request('http://localhost/v1/api/auth/sign-in', {
          method: 'POST',
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ success: true })
    })
  })
})
