import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createOriginValidation, withOriginValidation } from './origin-validation'

describe('Origin validation middleware', () => {
  const allowedSettings = {
    corsOrigins: 'http://localhost:1420,https://app.example.com,tauri://localhost,http://tauri.localhost',
  }

  describe('createOriginValidation (Elysia plugin)', () => {
    const createTestApp = () =>
      new Elysia()
        .use(createOriginValidation(allowedSettings))
        .get('/test', () => ({ ok: true }))
        .delete('/test', () => ({ ok: true }))

    it('allows requests without Origin header (non-browser clients)', async () => {
      const app = createTestApp()
      const res = await app.handle(new Request('http://localhost/test'))
      expect(res.status).toBe(200)
    })

    it('allows requests from explicit allowed origins', async () => {
      const app = createTestApp()
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:1420' },
        }),
      )
      expect(res.status).toBe(200)
    })

    it('allows requests from Tauri origins', async () => {
      const app = createTestApp()
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'tauri://localhost' },
        }),
      )
      expect(res.status).toBe(200)
    })

    it('rejects requests from arbitrary localhost ports', async () => {
      const app = createTestApp()
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('ORIGIN_NOT_ALLOWED')
    })

    it('rejects requests from unknown external origins', async () => {
      const app = createTestApp()
      const res = await app.handle(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://evil.com' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('rejects DELETE requests from unauthorized origins', async () => {
      const app = createTestApp()
      const res = await app.handle(
        new Request('http://localhost/test', {
          method: 'DELETE',
          headers: { Origin: 'http://localhost:9999' },
        }),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('withOriginValidation (handler wrapper)', () => {
    const mockHandler = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

    it('allows requests without Origin header', async () => {
      const wrapped = withOriginValidation(mockHandler, allowedSettings)
      const res = await wrapped(new Request('http://localhost/test'))
      expect(res.status).toBe(200)
    })

    it('allows requests from allowed origins', async () => {
      const wrapped = withOriginValidation(mockHandler, allowedSettings)
      const res = await wrapped(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:1420' },
        }),
      )
      expect(res.status).toBe(200)
    })

    it('allows requests from tauri origins', async () => {
      const wrapped = withOriginValidation(mockHandler, allowedSettings)
      const res = await wrapped(
        new Request('http://localhost/test', {
          headers: { Origin: 'tauri://localhost' },
        }),
      )
      expect(res.status).toBe(200)
    })

    it('rejects requests from arbitrary localhost ports', async () => {
      const wrapped = withOriginValidation(mockHandler, allowedSettings)
      const res = await wrapped(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:9999' },
        }),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('ORIGIN_NOT_ALLOWED')
    })

    it('rejects requests from unknown origins', async () => {
      const wrapped = withOriginValidation(mockHandler, allowedSettings)
      const res = await wrapped(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://attacker.com' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('passes request through to handler when origin is valid', async () => {
      const handler = (req: Request) =>
        new Response(JSON.stringify({ received: req.headers.get('x-custom') }), { status: 200 })
      const wrapped = withOriginValidation(handler, allowedSettings)
      const res = await wrapped(
        new Request('http://localhost/test', {
          headers: { Origin: 'http://localhost:1420', 'X-Custom': 'test-value' },
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.received).toBe('test-value')
    })
  })
})
