import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { Elysia } from 'elysia'
import { describe, expect, it } from 'bun:test'
import { createRequireAuthMiddleware } from './require-auth'

describe('Require Auth Middleware', () => {
  it('should block unauthenticated requests to protected routes with 401', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .get('/v1/units', () => ({ data: 'protected' }))

    const response = await app.handle(new Request('http://localhost/v1/units'))

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body).toEqual({ error: 'Authentication required' })
  })

  it('should allow authenticated requests to protected routes', async () => {
    const app = new Elysia().use(createRequireAuthMiddleware(mockAuth)).get('/v1/units', () => ({ data: 'protected' }))

    const response = await app.handle(new Request('http://localhost/v1/units'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ data: 'protected' })
  })

  it('should always allow /v1/health without auth (exact match)', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .get('/v1/health', () => ({ status: 'ok' }))

    const response = await app.handle(new Request('http://localhost/v1/health'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ status: 'ok' })
  })

  it('should NOT allow /v1/health-admin (boundary check)', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .get('/v1/health-admin', () => ({ status: 'admin' }))

    const response = await app.handle(new Request('http://localhost/v1/health-admin'))

    expect(response.status).toBe(401)
  })

  it('should always allow /v1/api/auth endpoints without auth', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .post('/v1/api/auth/sign-in', () => ({ success: true }))

    const response = await app.handle(new Request('http://localhost/v1/api/auth/sign-in', { method: 'POST' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true })
  })

  it('should always allow /v1/auth/google endpoints without auth', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .get('/v1/auth/google/config', () => ({ client_id: 'test' }))

    const response = await app.handle(new Request('http://localhost/v1/auth/google/config'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ client_id: 'test' })
  })

  it('should always allow /v1/auth/microsoft endpoints without auth', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .post('/v1/auth/microsoft/exchange', () => ({ success: true }))

    const response = await app.handle(new Request('http://localhost/v1/auth/microsoft/exchange', { method: 'POST' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true })
  })

  it('should always allow /v1/waitlist endpoints without auth', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
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

  it('should block unauthenticated requests to /v1/posthog endpoints', async () => {
    const app = new Elysia()
      .use(createRequireAuthMiddleware(mockAuthUnauthenticated))
      .get('/v1/posthog/config', () => ({ key: 'test' }))

    const response = await app.handle(new Request('http://localhost/v1/posthog/config'))

    expect(response.status).toBe(401)
  })

  it('should block unauthenticated requests to /v1/locations', async () => {
    const app = new Elysia().use(createRequireAuthMiddleware(mockAuthUnauthenticated)).get('/v1/locations', () => [])

    const response = await app.handle(new Request('http://localhost/v1/locations?query=test'))

    expect(response.status).toBe(401)
  })
})
