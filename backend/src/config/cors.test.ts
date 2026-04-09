import { describe, expect, it } from 'bun:test'
import { getCorsOriginsList } from '@/config/settings'
import { withOriginValidation } from '@/middleware/origin-validation'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Integration tests for CORS middleware behavior.
 * Verifies that the actual HTTP headers are set correctly for various origins.
 */
describe('CORS integration', () => {
  const createTestApp = (corsOrigins: (RegExp | string)[]) =>
    new Elysia()
      .use(
        cors({
          origin: corsOrigins,
          credentials: true,
          methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          allowedHeaders: 'Content-Type,Authorization',
        }),
      )
      .get('/test', () => ({ ok: true }))
      .delete('/test', () => ({ ok: true }))

  describe('with Tauri and explicit origins', () => {
    const origins = getCorsOriginsList({
      corsOrigins: 'https://app.example.com,tauri://localhost,http://tauri.localhost',
    })

    it('should allow the explicit origin', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow tauri://localhost', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'tauri://localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow http://tauri.localhost', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://tauri.localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should reject arbitrary localhost ports', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject unknown origins', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://evil.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject preflight from arbitrary localhost ports', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:9999',
            'Access-Control-Request-Method': 'DELETE',
          },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('with only explicit origins', () => {
    const origins = getCorsOriginsList({
      corsOrigins: 'https://app.example.com',
    })

    it('should allow the explicit origin', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    })

    it('should reject other origins', async () => {
      const app = createTestApp(origins)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })
})

/** Defense-in-depth: verify withOriginValidation blocks unauthorized origins at the handler level. */
describe('Defense-in-depth Origin validation on mounted handlers', () => {
  const settings = {
    corsOrigins: 'http://localhost:1420,tauri://localhost,http://tauri.localhost',
  }

  const mockSessionHandler = () =>
    new Response(
      JSON.stringify({ session: { token: 'secret-session-token', userId: 'user-1' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const createAppWithMountedHandler = () =>
    new Elysia().mount(withOriginValidation(mockSessionHandler, settings))

  it('blocks session token theft from arbitrary localhost ports', async () => {
    const app = createAppWithMountedHandler()
    const res = await app.handle(
      new Request('http://localhost/api/auth/get-session', {
        headers: { Origin: 'http://localhost:9999' },
      }),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('blocks requests from external malicious origins', async () => {
    const app = createAppWithMountedHandler()
    const res = await app.handle(
      new Request('http://localhost/api/auth/get-session', {
        headers: { Origin: 'https://evil.com' },
      }),
    )

    expect(res.status).toBe(403)
  })

  it('allows requests from the legitimate app origin', async () => {
    const app = createAppWithMountedHandler()
    const res = await app.handle(
      new Request('http://localhost/api/auth/get-session', {
        headers: { Origin: 'http://localhost:1420' },
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session.token).toBe('secret-session-token')
  })

  it('allows requests from Tauri app origins', async () => {
    const app = createAppWithMountedHandler()
    const res = await app.handle(
      new Request('http://localhost/api/auth/get-session', {
        headers: { Origin: 'tauri://localhost' },
      }),
    )

    expect(res.status).toBe(200)
  })

  it('allows requests without Origin header (non-browser clients)', async () => {
    const app = createAppWithMountedHandler()
    const res = await app.handle(new Request('http://localhost/api/auth/get-session'))

    expect(res.status).toBe(200)
  })
})
