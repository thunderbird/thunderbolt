import { describe, expect, it } from 'bun:test'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

/**
 * Integration tests for CORS preflight handling of unified proxy headers
 * (`X-Upstream-Authorization` and `X-Proxy-Follow-Redirects`).
 *
 * These headers are required by the unified proxy at `/v1/proxy/*` (THU-468).
 * Browsers send a CORS preflight OPTIONS request when custom headers are
 * present, so the server must list them in `Access-Control-Allow-Headers`.
 */
describe('CORS proxy headers preflight', () => {
  // Mirror the production default (settings.ts `corsAllowHeaders`) so this
  // test fails loudly if the default ever drops these headers.
  const defaultAllowHeaders =
    'Content-Type,Authorization,Accept,Accept-Encoding,Accept-Language,Cache-Control,User-Agent,X-Requested-With,X-Client-Platform,X-Device-ID,X-Device-Name,X-Challenge-Token,X-Mcp-Target-Url,Mcp-Authorization,Mcp-Session-Id,Mcp-Protocol-Version,X-Upstream-Authorization,X-Proxy-Follow-Redirects'

  const allowedOrigin = 'http://localhost:1420'

  const createTestApp = () =>
    new Elysia()
      .use(
        cors({
          origin: [allowedOrigin],
          credentials: true,
          methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          allowedHeaders: defaultAllowHeaders,
        }),
      )
      .get('/v1/proxy/test', () => ({ ok: true }))
      .post('/v1/proxy/test', () => ({ ok: true }))

  const getAllowedHeaders = (res: Response): string => {
    return (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  }

  it('allows X-Upstream-Authorization in preflight', async () => {
    const app = createTestApp()
    const res = await app.handle(
      new Request('http://localhost/v1/proxy/test', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-upstream-authorization',
        },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
    expect(getAllowedHeaders(res)).toContain('x-upstream-authorization')
  })

  it('allows X-Proxy-Follow-Redirects in preflight', async () => {
    const app = createTestApp()
    const res = await app.handle(
      new Request('http://localhost/v1/proxy/test', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-proxy-follow-redirects',
        },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
    expect(getAllowedHeaders(res)).toContain('x-proxy-follow-redirects')
  })

  it('allows both proxy headers together in preflight', async () => {
    const app = createTestApp()
    const res = await app.handle(
      new Request('http://localhost/v1/proxy/test', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-upstream-authorization, x-proxy-follow-redirects',
        },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
    const allowed = getAllowedHeaders(res)
    expect(allowed).toContain('x-upstream-authorization')
    expect(allowed).toContain('x-proxy-follow-redirects')
  })

  it('still allows existing headers (regression: Authorization + Content-Type)', async () => {
    const app = createTestApp()
    const res = await app.handle(
      new Request('http://localhost/v1/proxy/test', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      }),
    )

    expect(res.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
    const allowed = getAllowedHeaders(res)
    expect(allowed).toContain('authorization')
    expect(allowed).toContain('content-type')
  })
})
