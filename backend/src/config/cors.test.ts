import { describe, expect, it } from 'bun:test'
import { isOriginAllowed } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Integration tests for CORS middleware behavior.
 * Verifies that the actual HTTP headers are set correctly for various origins.
 */
describe('CORS integration', () => {
  const createTestApp = (settings: { corsOrigins: string; appUrl?: string; allowPrivateNetworkOrigins?: boolean }) =>
    new Elysia()
      .use(
        cors({
          origin: (request) => {
            const origin = request.headers.get('origin')
            return origin ? isOriginAllowed(origin, settings) : false
          },
          credentials: true,
          methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          allowedHeaders: 'Content-Type,Authorization',
        }),
      )
      .get('/test', () => ({ ok: true }))
      .delete('/test', () => ({ ok: true }))

  describe('with Tauri and explicit origins', () => {
    const settings = {
      corsOrigins: 'https://app.example.com,tauri://localhost,http://tauri.localhost',
      appUrl: 'http://localhost:1420',
    }

    it('should allow the explicit origin', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow tauri://localhost', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'tauri://localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should allow http://tauri.localhost', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://tauri.localhost' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('should reject arbitrary localhost ports', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject unknown origins', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://evil.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should reject preflight from arbitrary localhost ports', async () => {
      const app = createTestApp(settings)
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

    it('should allow local-network app origins on the app port', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://192.168.1.25:1420' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('http://192.168.1.25:1420')
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    })
  })

  describe('with only explicit origins', () => {
    const settings = {
      corsOrigins: 'https://app.example.com',
      appUrl: 'http://localhost:1420',
    }

    it('should allow the explicit origin', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://app.example.com' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    })

    it('should reject other origins', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('should allow Tailscale origins on the app port when private-network origins are enabled', async () => {
      const app = createTestApp(settings)
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://thunderbolt.ts.net:1420' },
        }),
      )

      expect(res.headers.get('access-control-allow-origin')).toBe('http://thunderbolt.ts.net:1420')
    })
  })
})
