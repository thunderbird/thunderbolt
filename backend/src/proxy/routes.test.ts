import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createUniversalProxyRoutes } from './routes'

// Mock DNS + net — external Node APIs
const mockDnsLookup = mock(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

/** Fake auth that always returns a resolved session. */
const fakeAuth = {
  api: {
    getSession: async () => ({
      user: { id: 'user-1', email: 'test@example.com' },
      session: { id: 'sess-1' },
    }),
  },
} as never

/** Converts a URL to its IP-pinned equivalent (as validateAndPin would produce). */
const pinnedUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.hostname = '93.184.216.34'
  return parsed.toString()
}

const makeOkResponse = (body = 'ok', extraHeaders: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...extraHeaders },
  })

describe('createUniversalProxyRoutes', () => {
  let app: { handle: Elysia['handle'] }
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    mockFetch = mock(() => Promise.resolve(makeOkResponse()))
    app = new Elysia().use(createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve(makeOkResponse()))
    mockDnsLookup.mockReset()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
    consoleSpies.error.mockClear()
  })

  // ---------------------------------------------------------------------------
  // Per-method happy paths
  // ---------------------------------------------------------------------------

  it('GET — proxies correctly and strips hop-by-hop headers', async () => {
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer secret', Cookie: 'session=abc' },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(pinnedUrl(target))
    const h = init.headers as Headers
    expect(h.get('authorization')).toBeNull()
    expect(h.get('cookie')).toBeNull()
    expect(h.get('Host')).toBe('example.com')
  })

  it('POST — proxies with body', async () => {
    const target = 'https://example.com/api'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'POST',
        body: JSON.stringify({ x: 1 }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    const bodyText = await new Response(init.body as ArrayBuffer).text()
    expect(bodyText).toBe('{"x":1}')
  })

  it('PUT — proxies correctly', async () => {
    const target = 'https://example.com/update'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'PUT',
        body: 'data',
      }),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
  })

  it('DELETE — proxies correctly', async () => {
    const target = 'https://example.com/item/1'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  it('PATCH — proxies correctly', async () => {
    const target = 'https://example.com/item/1'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'PATCH',
        body: '{"name":"new"}',
      }),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PATCH')
  })

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it('returns 400 for malformed percent-encoding (%ZZ)', async () => {
    const res = await app.handle(
      new Request('http://localhost/proxy/https%3A%2F%2Fexample.com%2F%ZZ', { method: 'GET' }),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignores proxy-level query string and uses only the decoded target URL', async () => {
    const target = 'https://example.com/api?name=ana'
    const encoded = encodeURIComponent(target)
    // The proxy request itself adds ?debug=1 — handler should ignore that and forward only the decoded target
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encoded}?debug=1`, { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
    // The upstream URL must contain exactly one '?' and not be corrupted with debug=1
    expect(calledUrl).toBe(pinnedUrl(target))
    expect(calledUrl).not.toContain('debug=1')
    expect((calledUrl.match(/\?/g) || []).length).toBe(1)
  })

  it('returns 400 for http:// target (HTTPS only)', async () => {
    const target = 'http://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 405 for TRACE method', async () => {
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'TRACE' }),
    )
    expect(res.status).toBe(405)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // SSRF
  // ---------------------------------------------------------------------------

  it('returns 400 for direct SSRF to 127.0.0.1', async () => {
    const target = 'https://127.0.0.1/secret'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 502 when redirect points to private address (SSRF chain)', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil-internal.example.com/secret' },
        }),
      ),
    )
    // First DNS lookup (example.com) resolves fine, second (evil-internal.example.com) returns private IP
    mockDnsLookup
      .mockImplementationOnce(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
      .mockImplementationOnce(() => Promise.resolve([{ address: '192.168.1.1', family: 4 }]))
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(502)
  })

  it('returns 400 when DNS times out on initial hop', async () => {
    // DNS never resolves
    mockDnsLookup.mockImplementation(() => new Promise(() => {}))
    const target = 'https://slow-dns.example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  }, 10_000)

  // ---------------------------------------------------------------------------
  // Redirect behavior
  // ---------------------------------------------------------------------------

  it('GET follows redirects by default', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('final')))

    const target = 'https://example.com/start'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('POST does NOT follow redirects by default (returns 302 as-is)', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://example.com/final' } }),
      ),
    )
    const target = 'https://example.com/submit'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'POST', body: 'payload' }),
    )
    expect(res.status).toBe(302)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('GET with X-Proxy-Follow-Redirects: false returns 302 as-is', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
    )
    const target = 'https://example.com/start'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { 'x-proxy-follow-redirects': 'false' },
      }),
    )
    expect(res.status).toBe(302)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('POST with X-Proxy-Follow-Redirects: true follows the redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(null, { status: 303, headers: { location: 'https://example.com/result' } }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('result')))

    const target = 'https://example.com/submit'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'POST',
        body: 'payload',
        headers: { 'x-proxy-follow-redirects': 'true' },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // 303 → GET, body dropped
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(secondInit.method).toBe('GET')
    expect(secondInit.body).toBeNull()
  })

  // Added in QA pass — covers I7: 307 preserves method and body on redirect
  it('307 redirect preserves POST method and body', async () => {
    const bodyPayload = new TextEncoder().encode('{"key":"value"}')
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(null, { status: 307, headers: { location: 'https://example.com/v2/submit' } }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('done')))

    const target = 'https://example.com/submit'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'POST',
        body: bodyPayload,
        headers: { 'content-type': 'application/json', 'x-proxy-follow-redirects': 'true' },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    // 307 must NOT change the method
    expect(secondInit.method).toBe('POST')
    // 307 must replay the same body bytes (not just any ArrayBuffer)
    const replayedBody = new Uint8Array(secondInit.body as ArrayBuffer)
    expect(Array.from(replayedBody)).toEqual(Array.from(bodyPayload))
  })

  it('returns 502 after 5 redirect hops', async () => {
    // Always respond with a redirect
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://example.com/redirect' } }),
      ),
    )
    const target = 'https://example.com/start'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(502)
    // 1 initial fetch + 5 redirect-follows = 6 total (off-by-one fix asserted)
    expect(mockFetch).toHaveBeenCalledTimes(6)
  })

  it('returns 502 when redirect downgrades to HTTP', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://evil.com/steal' } }),
      ),
    )
    const target = 'https://example.com/start'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(502)
    // Only the initial fetch is made; redirect is rejected before following
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('strips userinfo from target URL before forwarding', async () => {
    const target = 'https://user:pass@example.com/path'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(200)
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).not.toContain('@')
    expect(calledUrl).not.toContain('user')
    expect(calledUrl).not.toContain('pass')
  })

  // ---------------------------------------------------------------------------
  // Auth header forwarding
  // ---------------------------------------------------------------------------

  it('drops X-Upstream-Authorization on cross-origin redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://evil.com/steal' } }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse()))

    const target = 'https://api.foo.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { 'x-upstream-authorization': 'Bearer token123' },
      }),
    )
    expect(res.status).toBe(200)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const h = secondInit.headers as Headers
    expect(h.get('authorization')).toBeNull()
  })

  it('preserves X-Upstream-Authorization on same-origin redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://api.foo.com/v2/resource' } }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse()))

    const target = 'https://api.foo.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { 'x-upstream-authorization': 'Bearer token123' },
      }),
    )
    expect(res.status).toBe(200)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const h = secondInit.headers as Headers
    expect(h.get('authorization')).toBe('Bearer token123')
  })

  it('treats empty X-Upstream-Authorization as absent (no 400)', async () => {
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { 'x-upstream-authorization': '' },
      }),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBeNull()
  })

  it('returns 400 for non-printable char in X-Upstream-Authorization', async () => {
    // Use a non-printable character (DEL = 0x7F) that passes the Headers constructor
    // but fails our isPrintableAscii guard (which requires 0x20–0x7E only).
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'GET',
        headers: { 'x-upstream-authorization': 'Bearer abc\x7Fevil' },
      }),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Response headers
  // ---------------------------------------------------------------------------

  it('sets all 4 security headers on response', async () => {
    const target = 'https://example.com/page'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })

  it('strips set-cookie, set-cookie2, and trailer from response', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('body', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'session=abc',
            'set-cookie2': 'old=cookie',
            trailer: 'Expires',
          },
        }),
      ),
    )
    const target = 'https://example.com/resource'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('set-cookie2')).toBeNull()
    expect(res.headers.get('trailer')).toBeNull()
  })

  it('preserves content-encoding from upstream response', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(new Uint8Array([0x1f, 0x8b]), {
          status: 200,
          headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
        }),
      ),
    )
    const target = 'https://example.com/compressed'
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  // ---------------------------------------------------------------------------
  // Rate limit (429)
  // ---------------------------------------------------------------------------

  it('returns 429 when rate limit is exceeded', async () => {
    const rateLimitPlugin = new Elysia()
      .onBeforeHandle(({ set }) => {
        set.status = 429
        set.headers['Retry-After'] = '60'
        return { error: 'Too many requests' }
      })
      .as('scoped')
    const rateLimitedApp = new Elysia().use(
      createUniversalProxyRoutes(fakeAuth, mockFetch as unknown as typeof fetch, rateLimitPlugin),
    )
    const target = 'https://example.com/resource'
    const res = await rateLimitedApp.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    // Rate limit must short-circuit before any upstream connection is opened
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Body size limit
  // ---------------------------------------------------------------------------

  it('returns 413 for request body over 10 MB', async () => {
    const target = 'https://example.com/upload'
    const bigBody = new Uint8Array(11 * 1024 * 1024)
    const res = await app.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, {
        method: 'POST',
        body: bigBody,
        headers: { 'content-length': String(bigBody.byteLength) },
      }),
    )
    expect(res.status).toBe(413)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Auth gate
  // ---------------------------------------------------------------------------

  it('returns 401 when session is null and never opens an upstream connection', async () => {
    const noAuth = { api: { getSession: async () => null } } as never
    const noAuthApp = new Elysia().use(
      createUniversalProxyRoutes(noAuth, mockFetch as unknown as typeof fetch),
    )
    const target = 'https://example.com/resource'
    const res = await noAuthApp.handle(
      new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { method: 'GET' }),
    )
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
