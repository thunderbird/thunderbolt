/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createUniversalProxyRoutes } from './routes'

// Deterministic DNS resolver injected as a `createUniversalProxyRoutes` dep —
// no `mock.module('node:dns')`, which would leak across files (see
// docs/development/testing.md). 1.1.1.1 is a public IP (passes SSRF) and
// stable for `pinnedUrl` assertions below.
const mockDnsLookup = mock(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))

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
  parsed.hostname = '1.1.1.1'
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

const makeOkResponse = (body = 'ok', extraHeaders: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...extraHeaders },
  })

/** Build a request to /proxy with `target` carried in X-Proxy-Target-Url. */
const proxyRequest = (target: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('x-proxy-target-url', target)
  return new Request('http://localhost/proxy', { ...init, headers })
}

/** Drain the response body so the proxy's `capStream` idle timer clears.
 *  Production Bun does this automatically when writing to the wire; tests
 *  that just inspect `Response` must drain explicitly or leak 30s timers
 *  that flood subsequent tests under `--rerun-each` and starve their
 *  `beforeEach` hooks. */
const drain = async (res: Response): Promise<Response> => {
  if (res.body) {
    await res.arrayBuffer()
  }
  return res
}

describe('createUniversalProxyRoutes', () => {
  let app: { handle: Elysia['handle'] }
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    mockFetch = mock(() => Promise.resolve(makeOkResponse()))
    app = new Elysia().use(
      createUniversalProxyRoutes({
        auth: fakeAuth,
        fetchFn: mockFetch as unknown as typeof fetch,
        dnsLookup: mockDnsLookup,
      }),
    )
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve(makeOkResponse()))
    mockDnsLookup.mockReset()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
    consoleSpies.error.mockClear()
  })

  // ---------------------------------------------------------------------------
  // Per-method happy paths — target now in X-Proxy-Target-Url header
  // ---------------------------------------------------------------------------

  it('GET — proxies correctly and does not forward inbound Authorization', async () => {
    const target = 'https://example.com/resource'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { Authorization: 'Bearer secret', Cookie: 'session=abc' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(pinnedUrl(target))
    const h = init.headers as Headers
    expect(h.get('authorization')).toBeNull()
    expect(h.get('cookie')).toBeNull()
    expect(h.get('host')).toBe('example.com')
  })

  it('POST — proxies with body', async () => {
    const target = 'https://example.com/api'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'POST',
          body: JSON.stringify({ x: 1 }),
          headers: { 'x-proxy-passthrough-content-type': 'application/json' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    const headers = init.headers as Headers
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('PUT — proxies correctly', async () => {
    const target = 'https://example.com/update'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'PUT', body: 'data' })))
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PUT')
  })

  it('DELETE — proxies correctly', async () => {
    const target = 'https://example.com/item/1'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'DELETE' })))
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  it('PATCH — proxies correctly', async () => {
    const target = 'https://example.com/item/1'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'PATCH', body: '{"name":"new"}' })))
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('PATCH')
  })

  it('HEAD — proxies method and returns no body', async () => {
    const target = 'https://example.com/resource'
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } })),
    )
    const res = await drain(await app.handle(proxyRequest(target, { method: 'HEAD' })))
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('HEAD')
    expect(await res.text()).toBe('')
  })

  it('OPTIONS — proxies method (CORS preflight forwarded)', async () => {
    const target = 'https://example.com/api'
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, {
          status: 204,
          headers: {
            allow: 'GET, POST, OPTIONS',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
          },
        }),
      ),
    )
    const res = await drain(await app.handle(proxyRequest(target, { method: 'OPTIONS' })))
    expect(res.status).toBe(204)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('OPTIONS')
    expect(init.body).toBeFalsy()
  })

  // ---------------------------------------------------------------------------
  // Passthrough header convention (symmetric, prefix-based)
  // ---------------------------------------------------------------------------

  it('forwards X-Proxy-Passthrough-* headers stripped of prefix to upstream', async () => {
    const target = 'https://example.com/api'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: {
            'x-proxy-passthrough-content-type': 'application/json',
            'x-proxy-passthrough-accept': 'text/event-stream',
            'x-proxy-passthrough-mcp-session-id': 'session-abc',
            'user-agent': 'should-not-be-forwarded',
          },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const h = init.headers as Headers
    expect(h.get('content-type')).toBe('application/json')
    expect(h.get('accept')).toBe('text/event-stream')
    expect(h.get('mcp-session-id')).toBe('session-abc')
    // Anything not prefixed (including User-Agent, Origin, etc.) is dropped.
    expect(h.get('user-agent')).toBeNull()
  })

  it('X-Proxy-Passthrough-Authorization is forwarded as Authorization', async () => {
    const target = 'https://example.com/api'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { 'x-proxy-passthrough-authorization': 'Bearer upstream-key' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const h = init.headers as Headers
    expect(h.get('authorization')).toBe('Bearer upstream-key')
  })

  it('inbound Authorization (proxy auth) is NEVER forwarded', async () => {
    const target = 'https://example.com/api'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { Authorization: 'Bearer proxy-session-token' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const h = init.headers as Headers
    expect(h.get('authorization')).toBeNull()
  })

  it('upstream response headers are returned X-Proxy-Passthrough- prefixed', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-xyz',
          },
        }),
      ),
    )
    const target = 'https://example.com/api'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-proxy-passthrough-content-type')).toBe('application/json')
    expect(res.headers.get('x-proxy-passthrough-mcp-session-id')).toBe('sess-xyz')
  })

  it('rejects passthrough header values with control characters (CRLF)', async () => {
    const target = 'https://example.com/api'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { 'x-proxy-passthrough-authorization': 'Bearer abc\x7Fevil' },
        }),
      ),
    )
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Final URL exposure
  // ---------------------------------------------------------------------------

  it('exposes X-Proxy-Final-Url matching the target on a non-redirected request', async () => {
    const target = 'https://example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.headers.get('x-proxy-final-url')).toBe(target)
  })

  it('updates X-Proxy-Final-Url after a redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('final')))
    const target = 'https://example.com/start'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-proxy-final-url')).toBe('https://example.com/final')
  })

  // ---------------------------------------------------------------------------
  // URL handling
  // ---------------------------------------------------------------------------

  it('auto-upgrades http:// target to https://', async () => {
    const target = 'http://example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(pinnedUrl('https://example.com/resource'))
  })

  it('returns 400 for missing X-Proxy-Target-Url header', async () => {
    const res = await drain(await app.handle(new Request('http://localhost/proxy', { method: 'GET' })))
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid URL', async () => {
    const res = await drain(await app.handle(proxyRequest('not a url', { method: 'GET' })))
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for non-http(s) scheme (ftp://)', async () => {
    const res = await drain(await app.handle(proxyRequest('ftp://example.com/resource', { method: 'GET' })))
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 405 for TRACE method', async () => {
    const target = 'https://example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'TRACE' })))
    expect(res.status).toBe(405)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // SSRF
  // ---------------------------------------------------------------------------

  it('returns 400 for direct SSRF to 127.0.0.1', async () => {
    const target = 'https://127.0.0.1/secret'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 502 when redirect points to a private address (SSRF chain)', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil-internal.example.com/secret' },
        }),
      ),
    )
    mockDnsLookup
      .mockImplementationOnce(() => Promise.resolve([{ address: '1.1.1.1', family: 4 }]))
      .mockImplementationOnce(() => Promise.resolve([{ address: '192.168.1.1', family: 4 }]))
    const target = 'https://example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(502)
  })

  it('returns 400 when DNS times out on the initial hop', async () => {
    mockDnsLookup.mockImplementation(() => new Promise(() => {}))
    const target = 'https://slow-dns.example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  }, 10_000)

  // ---------------------------------------------------------------------------
  // Redirect behaviour
  // ---------------------------------------------------------------------------

  it('GET follows redirects by default', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('final')))
    const target = 'https://example.com/start'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('POST does NOT follow redirects by default (returns 302 as-is)', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
    )
    const target = 'https://example.com/submit'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'POST', body: 'payload' })))
    expect(res.status).toBe(302)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Location header is exposed prefixed for the caller to read.
    expect(res.headers.get('x-proxy-passthrough-location')).toBe('https://example.com/final')
  })

  it('GET with X-Proxy-Follow-Redirects: false returns 302 as-is', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })),
    )
    const target = 'https://example.com/start'
    const res = await drain(
      await app.handle(proxyRequest(target, { method: 'GET', headers: { 'x-proxy-follow-redirects': 'false' } })),
    )
    expect(res.status).toBe(302)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('POST with X-Proxy-Follow-Redirects: true follows the redirect (303 → GET, body dropped)', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 303, headers: { location: 'https://example.com/result' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('result')))
    const target = 'https://example.com/submit'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'POST',
          body: 'payload',
          headers: { 'x-proxy-follow-redirects': 'true' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(secondInit.method).toBe('GET')
    expect(secondInit.body).toBeFalsy()
  })

  it('307 redirect preserves POST method and body', async () => {
    const bodyPayload = new TextEncoder().encode('{"key":"value"}')
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 307, headers: { location: 'https://example.com/v2/submit' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('done')))

    const target = 'https://example.com/submit'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'POST',
          body: bodyPayload,
          headers: { 'content-type': 'application/json', 'x-proxy-follow-redirects': 'true' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    // 307 must NOT change the method
    expect(secondInit.method).toBe('POST')
    // 307 must replay the same body bytes
    const replayedBody = new Uint8Array(secondInit.body as ArrayBuffer)
    expect(Array.from(replayedBody)).toEqual(Array.from(bodyPayload))
  })

  it('returns 502 after 5 redirect hops', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/redirect' } })),
    )
    const target = 'https://example.com/start'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(502)
    expect(mockFetch).toHaveBeenCalledTimes(6)
  })

  it('auto-upgrades http:// in a redirect Location header', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://example.com/final' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse('final')))
    const target = 'https://example.com/start'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    const [secondUrl] = mockFetch.mock.calls[1] as [string, RequestInit]
    expect(secondUrl).toBe(pinnedUrl('https://example.com/final'))
  })

  it('strips userinfo from the target URL before forwarding', async () => {
    const target = 'https://user:pass@example.com/path'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(200)
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).not.toContain('@')
    expect(calledUrl).not.toContain('user')
    expect(calledUrl).not.toContain('pass')
  })

  it('drops X-Proxy-Passthrough-Authorization on cross-origin redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.com/steal' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse()))

    const target = 'https://api.foo.com/resource'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { 'x-proxy-passthrough-authorization': 'Bearer token123' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const h = secondInit.headers as Headers
    expect(h.get('authorization')).toBeNull()
  })

  it('preserves X-Proxy-Passthrough-Authorization on same-origin redirect', async () => {
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://api.foo.com/v2/resource' } })),
      )
      .mockImplementationOnce(() => Promise.resolve(makeOkResponse()))

    const target = 'https://api.foo.com/resource'
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'GET',
          headers: { 'x-proxy-passthrough-authorization': 'Bearer token123' },
        }),
      ),
    )
    expect(res.status).toBe(200)
    const [, secondInit] = mockFetch.mock.calls[1] as [string, RequestInit]
    const h = secondInit.headers as Headers
    expect(h.get('authorization')).toBe('Bearer token123')
  })

  // ---------------------------------------------------------------------------
  // Response headers
  // ---------------------------------------------------------------------------

  it('sets all 4 forced security headers on response', async () => {
    const target = 'https://example.com/page'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })

  it('drops upstream Set-Cookie / Set-Cookie2 / Trailer / wire headers from the response', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('body', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'session=abc',
            'set-cookie2': 'old=cookie',
            trailer: 'Expires',
            'transfer-encoding': 'chunked',
          },
        }),
      ),
    )
    const target = 'https://example.com/resource'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('set-cookie2')).toBeNull()
    expect(res.headers.get('x-proxy-passthrough-set-cookie')).toBeNull()
    expect(res.headers.get('x-proxy-passthrough-trailer')).toBeNull()
    expect(res.headers.get('x-proxy-passthrough-transfer-encoding')).toBeNull()
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
      createUniversalProxyRoutes({
        auth: fakeAuth,
        fetchFn: mockFetch as unknown as typeof fetch,
        rateLimit: rateLimitPlugin,
        dnsLookup: mockDnsLookup,
      }),
    )
    const target = 'https://example.com/resource'
    const res = await drain(await rateLimitedApp.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Body size limit
  // ---------------------------------------------------------------------------

  it('returns 413 for request body over 10 MB (Content-Length pre-check)', async () => {
    const target = 'https://example.com/upload'
    const bigBody = new Uint8Array(11 * 1024 * 1024)
    const res = await drain(
      await app.handle(
        proxyRequest(target, {
          method: 'POST',
          body: bigBody,
          headers: { 'content-length': String(bigBody.byteLength) },
        }),
      ),
    )
    expect(res.status).toBe(413)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 413 for streaming chunked body over 10 MB with NO Content-Length (DoS guard)', async () => {
    // Regression: without bounded streaming, `await response.arrayBuffer()` would
    // materialise the entire upload before the cap fires. We expose this by sending
    // a streamed body (Transfer-Encoding: chunked equivalent) that pushes chunks
    // until we exceed the cap. The proxy must early-terminate without OOMing.
    const target = 'https://example.com/upload'
    const chunkSize = 256 * 1024 // 256 KB
    const totalChunks = 48 // 12 MB total — exceeds 10 MB cap
    let chunksProduced = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksProduced >= totalChunks) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(chunkSize))
        chunksProduced++
      },
    })
    const res = await drain(
      await app.handle(
        // Critically: NO content-length header. needsBodyBuffer=true via follow-redirects.
        new Request('http://localhost/proxy', {
          method: 'POST',
          body: stream,
          headers: {
            'x-proxy-target-url': target,
            'x-proxy-follow-redirects': 'true',
          },
          // @ts-expect-error — duplex is not in the standard RequestInit type
          duplex: 'half',
        }),
      ),
    )
    expect(res.status).toBe(413)
    expect(mockFetch).not.toHaveBeenCalled()
    // Early-termination proof: we exited the loop before draining the whole stream.
    expect(chunksProduced).toBeLessThan(totalChunks)
  })

  // ---------------------------------------------------------------------------
  // Auth gate
  // ---------------------------------------------------------------------------

  it('returns 401 when session is null and never opens an upstream connection', async () => {
    const noAuth = { api: { getSession: async () => null } } as never
    const noAuthApp = new Elysia().use(
      createUniversalProxyRoutes({
        auth: noAuth,
        fetchFn: mockFetch as unknown as typeof fetch,
        dnsLookup: mockDnsLookup,
      }),
    )
    const target = 'https://example.com/resource'
    const res = await drain(await noAuthApp.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // content-encoding passthrough — `decompress: false` on the upstream call
  // (Italo review item, perf-only — preserves gzip/br bytes for the browser).
  // ---------------------------------------------------------------------------

  it('passes `decompress: false` to the upstream fetch so encoded bodies stream through', async () => {
    const target = 'https://example.com/resource'
    await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit & { decompress?: boolean }]
    expect(init.decompress).toBe(false)
  })

  it('forwards upstream `content-encoding` response header to the caller (no longer dropped)', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response('compressed-bytes', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        }),
      ),
    )
    const target = 'https://example.com/api'
    const res = await drain(await app.handle(proxyRequest(target, { method: 'GET' })))
    expect(res.headers.get('x-proxy-passthrough-content-encoding')).toBe('gzip')
  })

  // ---------------------------------------------------------------------------
  // Observability wiring — fixes the bot MEDIUM findings (hardcoded status,
  // hardcoded duration/bytes) by routing every emission through a recorder DI.
  // ---------------------------------------------------------------------------

  describe('observability wiring', () => {
    type ProxyRequestEvent = {
      method: string
      target_url: string
      status: number
      duration_ms: number
      bytes_in: number
      bytes_out: number
      user_id: string
      request_id: string
      error_type?: string
    }

    const buildApp = () => {
      const events: ProxyRequestEvent[] = []
      const recorder = {
        proxyRequest: (e: ProxyRequestEvent) => events.push(e),
        proxyWsRelay: () => {},
      }
      const app = new Elysia().use(
        createUniversalProxyRoutes({
          auth: fakeAuth,
          fetchFn: mockFetch as unknown as typeof fetch,
          dnsLookup: mockDnsLookup,
          observability: recorder,
        }),
      )
      return { app, events }
    }

    /** Drain the response body so capStream.onComplete fires and observability emits. */
    const drain = async (res: Response) => {
      if (res.body) {
        await res.arrayBuffer()
      }
    }

    it('records the real upstream status (not hardcoded 200) — bot MEDIUM fix', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('teapot', { status: 418 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(res.status).toBe(418)
      expect(events).toHaveLength(1)
      expect(events[0].status).toBe(418)
    })

    it('records non-zero duration_ms (not hardcoded 0) — bot MEDIUM fix', async () => {
      mockFetch.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response('ok', { status: 200 })), 15)),
      )
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      // Generous lower bound — CI clocks vary; we just need to prove it isn't 0.
      expect(events[0].duration_ms).toBeGreaterThanOrEqual(5)
    })

    it('records non-zero bytes_out from the streamed response body — bot MEDIUM fix', async () => {
      const payload = 'x'.repeat(1024)
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response(payload, { status: 200 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(events[0].bytes_out).toBe(payload.length)
    })

    it('records bytes_in from a buffered request body (POST with follow-redirects)', async () => {
      const body = new TextEncoder().encode('a'.repeat(512))
      mockFetch
        .mockImplementationOnce(() =>
          Promise.resolve(new Response(null, { status: 303, headers: { location: 'https://example.com/done' } })),
        )
        .mockImplementationOnce(() => Promise.resolve(new Response('ok', { status: 200 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(
        proxyRequest('https://example.com/submit', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/octet-stream', 'x-proxy-follow-redirects': 'true' },
        }),
      )
      await drain(res)
      // 303 forces GET, body dropped — but `bytes_in` reports the buffered upload size of the final hop's body.
      // The final hop is a GET with `null` body → 0 bytes_in. The proxy reports the final hop's bytes_in, not aggregate.
      expect(events).toHaveLength(1)
      expect(events[0].bytes_in).toBe(0)
    })

    it('records bytes_in from a streaming POST body (no redirect-follow) — bytesIn deferred-getter regression', async () => {
      // Exercises the validator-fixed path (commit 7d5ddada): a streaming POST that
      // does not follow redirects uses capStream on the request body and exposes
      // bytesIn as a `() => number` getter so the emission (which fires from the
      // RESPONSE stream's onComplete) sees the final upload size after the body
      // has fully drained. Pre-fix, the value was captured at the moment fetch
      // resolved response headers and could be under-reported. We exercise this
      // by reading the entire request body inside the mock fetch (forces drain
      // before the response is constructed).
      const payload = new TextEncoder().encode('z'.repeat(4096))
      mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        // Drain the request body before responding — this is the exact scenario
        // the deferred getter exists for. The capStream wrapping the request
        // body increments its byte counter as we read.
        if (init.body instanceof ReadableStream) {
          const reader = init.body.getReader()
          while (true) {
            const { done } = await reader.read()
            if (done) {
              break
            }
          }
        }
        return new Response('ok', { status: 200 })
      })
      const { app: a, events } = buildApp()
      const res = await a.handle(
        proxyRequest('https://example.com/upload', {
          method: 'POST',
          body: payload,
          headers: { 'x-proxy-passthrough-content-type': 'application/octet-stream' },
        }),
      )
      await drain(res)
      expect(events).toHaveLength(1)
      // bytes_in is reported AFTER the request stream has drained, so it
      // reflects the full upload size — not 0 from a pre-drain read.
      expect(events[0].bytes_in).toBe(payload.byteLength)
      expect(events[0].bytes_out).toBe(2) // 'ok'
    })

    it('tags error_type="ssrf" when target resolves to a private address', async () => {
      mockDnsLookup.mockImplementationOnce(() => Promise.resolve([{ address: '192.168.1.1', family: 4 }]))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://blocked.example.com/x', { method: 'GET' }))
      expect(res.status).toBe(400)
      expect(events).toHaveLength(1)
      expect(events[0].error_type).toBe('ssrf')
    })

    it('tags error_type="invalid_target" for a missing X-Proxy-Target-Url header', async () => {
      const { app: a, events } = buildApp()
      const res = await a.handle(new Request('http://localhost/proxy', { method: 'GET' }))
      expect(res.status).toBe(400)
      expect(events[0].error_type).toBe('invalid_target')
    })

    it('tags error_type="upstream_5xx" when upstream returns 503', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('down', { status: 503 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(events[0].error_type).toBe('upstream_5xx')
    })

    it('tags error_type="upstream_4xx" when upstream returns 404', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('gone', { status: 404 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(events[0].error_type).toBe('upstream_4xx')
    })

    it('omits error_type on 2xx and 3xx responses', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('ok', { status: 200 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(events[0].error_type).toBeUndefined()
    })

    it('records the authenticated user_id, not "unknown"', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(new Response('ok', { status: 200 })))
      const { app: a, events } = buildApp()
      const res = await a.handle(proxyRequest('https://example.com/r', { method: 'GET' }))
      await drain(res)
      expect(events[0].user_id).toBe('user-1')
    })
  })
})
