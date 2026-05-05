/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'

// Mock DNS so any test hostname resolves to a public-looking IP. This lets the
// proxy's SSRF + DNS-pin pipeline run unchanged while traffic stays in-process.
const mockDnsLookup = mock((host: string) => {
  if (host === 'private.test') return Promise.resolve([{ address: '192.168.1.1', family: 4 }])
  return Promise.resolve([{ address: '1.2.3.4', family: 4 }])
})
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))

import {
  authHeaders,
  createTestApp,
  createTestUpstream,
  createUpstreamRouter,
  type TestAppHandle,
  type TestUpstream,
} from '@/test-utils/e2e'

const proxyRequest = (
  app: TestAppHandle['app'],
  bearerToken: string,
  target: string,
  init: RequestInit & { passthrough?: Record<string, string> } = {},
) => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${bearerToken}`)
  headers.set('X-Proxy-Target-Url', target)
  if (init.passthrough) {
    for (const [k, v] of Object.entries(init.passthrough)) {
      headers.set(`X-Proxy-Passthrough-${k}`, v)
    }
  }
  return app.handle(new Request('http://localhost/v1/proxy', { ...init, headers }))
}

const setUpstreams = async (upstreams: Record<string, TestUpstream>): Promise<TestAppHandle> => {
  const router = createUpstreamRouter(upstreams)
  return createTestApp({ fetchFn: router })
}

describe('Universal proxy /v1/proxy — e2e', () => {
  let handle: TestAppHandle

  afterEach(async () => {
    if (handle) await handle.cleanup()
  })

  beforeAll(() => {
    mockDnsLookup.mockClear()
  })

  // --- happy paths ---------------------------------------------------------

  it('GET — returns upstream body byte-for-byte and surfaces status', async () => {
    const upstream = createTestUpstream(
      'upstream.test',
      () => new Response('hello world', { status: 201, headers: { 'content-type': 'text/plain' } }),
    )
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/hello')
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('hello world')
    expect(upstream.requests[0].method).toBe('GET')
    expect(res.headers.get('x-proxy-final-url')).toBe('https://upstream.test/hello')
  })

  it('POST — streamed JSON body reaches upstream verbatim', async () => {
    let upstreamBody = ''
    const upstream = createTestUpstream('upstream.test', async (req) => {
      upstreamBody = await req.text()
      return new Response('ok', { status: 200 })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const payload = JSON.stringify({ name: 'ana', count: 42 })
    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api', {
      method: 'POST',
      body: payload,
      passthrough: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(upstreamBody).toBe(payload)
  })

  // --- header passthrough --------------------------------------------------

  it('X-Proxy-Passthrough-Content-Type reaches upstream as Content-Type', async () => {
    const upstream = createTestUpstream('upstream.test', (req) => {
      expect(req.headers.get('content-type')).toBe('application/json')
      return new Response('ok', { status: 200 })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api', {
      method: 'POST',
      body: '{}',
      passthrough: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
  })

  it('X-Proxy-Passthrough-Authorization reaches upstream as Authorization', async () => {
    const upstream = createTestUpstream('upstream.test', (req) => {
      expect(req.headers.get('authorization')).toBe('Bearer upstream-key')
      return new Response('ok', { status: 200 })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api', {
      passthrough: { Authorization: 'Bearer upstream-key' },
    })
    expect(res.status).toBe(200)
  })

  it('inbound Authorization (proxy auth) is NEVER forwarded to upstream', async () => {
    const upstream = createTestUpstream('upstream.test', (req) => {
      // Proxy auth must not leak — the upstream sees no authorization unless explicitly passed.
      expect(req.headers.get('authorization')).toBeNull()
      return new Response('ok', { status: 200 })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api')
    expect(res.status).toBe(200)
  })

  it('upstream response headers are returned to caller with passthrough prefix', async () => {
    const upstream = createTestUpstream(
      'upstream.test',
      () =>
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-xyz' },
        }),
    )
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api')
    expect(res.headers.get('x-proxy-passthrough-content-type')).toBe('application/json')
    expect(res.headers.get('x-proxy-passthrough-mcp-session-id')).toBe('sess-xyz')
  })

  it('upstream Set-Cookie is dropped (cookie isolation)', async () => {
    const upstream = createTestUpstream(
      'upstream.test',
      () =>
        new Response('ok', {
          status: 200,
          headers: { 'set-cookie': 'session=evil; HttpOnly' },
        }),
    )
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/api')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-proxy-passthrough-set-cookie')).toBeNull()
  })

  // --- streaming -----------------------------------------------------------

  it('SSE response streams chunk-by-chunk (not buffered)', async () => {
    const events = ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']
    const upstream = createTestUpstream('upstream.test', () => {
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of events) {
            controller.enqueue(new TextEncoder().encode(chunk))
            await new Promise((r) => setTimeout(r, 20))
          }
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/sse')
    expect(res.headers.get('x-proxy-passthrough-content-type')).toBe('text/event-stream')

    // Read chunks as they arrive — assert we get the first event before the stream closes.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const received: string[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received.push(decoder.decode(value))
    }
    expect(received.join('')).toBe(events.join(''))
  })

  // --- redirects -----------------------------------------------------------

  it('GET — follows redirect; X-Proxy-Final-Url updates', async () => {
    const upstream = createTestUpstream('upstream.test', (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://upstream.test/final' },
        })
      }
      return new Response('arrived', { status: 200 })
    })
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/start')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('arrived')
    expect(res.headers.get('x-proxy-final-url')).toBe('https://upstream.test/final')
  })

  it('GET — cross-origin redirect strips X-Proxy-Passthrough-Authorization', async () => {
    const start = createTestUpstream(
      'start.test',
      () => new Response(null, { status: 302, headers: { location: 'https://other.test/secret' } }),
    )
    const other = createTestUpstream('other.test', (req) => {
      // After cross-origin redirect, upstream Authorization must be absent.
      expect(req.headers.get('authorization')).toBeNull()
      return new Response('ok', { status: 200 })
    })
    handle = await setUpstreams({ 'start.test': start, 'other.test': other })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://start.test/begin', {
      passthrough: { Authorization: 'Bearer leak-me' },
    })
    expect(res.status).toBe(200)
  })

  it('POST — does NOT follow redirects by default; surfaces 302 with prefixed Location', async () => {
    const upstream = createTestUpstream(
      'upstream.test',
      () => new Response(null, { status: 302, headers: { location: 'https://upstream.test/final' } }),
    )
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://upstream.test/submit', {
      method: 'POST',
      body: 'payload',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('x-proxy-passthrough-location')).toBe('https://upstream.test/final')
    expect(upstream.requests).toHaveLength(1)
  })

  // --- URL handling --------------------------------------------------------

  it('http:// target is auto-upgraded to https://', async () => {
    const upstream = createTestUpstream('upstream.test', () => new Response('ok', { status: 200 }))
    handle = await setUpstreams({ 'upstream.test': upstream })

    const res = await proxyRequest(handle.app, handle.bearerToken, 'http://upstream.test/page')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-proxy-final-url')).toBe('https://upstream.test/page')
  })

  it('rejects ftp:// and other non-http(s) schemes with 400', async () => {
    handle = await setUpstreams({})
    const res = await proxyRequest(handle.app, handle.bearerToken, 'ftp://upstream.test/file')
    expect(res.status).toBe(400)
  })

  it('rejects missing X-Proxy-Target-Url with 400', async () => {
    handle = await setUpstreams({})
    const res = await handle.app.handle(
      new Request('http://localhost/v1/proxy', {
        method: 'GET',
        headers: authHeaders(handle.bearerToken),
      }),
    )
    expect(res.status).toBe(400)
  })

  // --- SSRF ----------------------------------------------------------------

  it('rejects target resolving to a private address with 400 (DNS pin)', async () => {
    handle = await setUpstreams({})
    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://private.test/secret')
    expect(res.status).toBe(400)
  })

  it('rejects direct private-IP target with 400', async () => {
    handle = await setUpstreams({})
    const res = await proxyRequest(handle.app, handle.bearerToken, 'https://127.0.0.1/secret')
    expect(res.status).toBe(400)
  })

  // --- auth ----------------------------------------------------------------

  it('returns 401 for an unauthenticated request', async () => {
    handle = await setUpstreams({})
    const res = await handle.app.handle(
      new Request('http://localhost/v1/proxy', {
        method: 'GET',
        headers: { 'X-Proxy-Target-Url': 'https://upstream.test/api' },
      }),
    )
    expect(res.status).toBe(401)
  })
})
