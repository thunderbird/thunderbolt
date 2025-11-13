import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createGoogleAuthRoutes } from './google'
import { createMicrosoftAuthRoutes } from './microsoft'

describe('Authentication Routes', () => {
  let app: Elysia
  let mockFetch: ReturnType<typeof mock>

  const createMockOAuthResponse = (status = 200, body: any = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  beforeAll(async () => {
    // Mock console methods to reduce test noise
    spyOn(console, 'log').mockImplementation(() => {})
    spyOn(console, 'info').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockOAuthResponse()))

    // Inject mock fetch into routes
    app = new Elysia()
      .use(createGoogleAuthRoutes(mockFetch as unknown as typeof fetch))
      .use(createMicrosoftAuthRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(async () => {
    // Cleanup if needed
  })

  describe('Google OAuth', () => {
    it('should return Google OAuth config', async () => {
      const response = await app.handle(new Request('http://localhost/auth/google/config'))
      expect(response.status).toBe(200)
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })
  })

  describe('Microsoft OAuth', () => {
    it('should return Microsoft OAuth config', async () => {
      const response = await app.handle(new Request('http://localhost/auth/microsoft/config'))
      expect(response.status).toBe(200)
    })

    it('should require valid body for token exchange', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('should require valid body for token refresh', async () => {
      const response = await app.handle(
        new Request('http://localhost/auth/microsoft/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
      expect(response.status).toBe(422)
    })
  })
})
