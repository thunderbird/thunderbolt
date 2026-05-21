/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Note: this test deliberately does NOT use `mock.module()`. Mocks of shared
// modules like `@/lib/platform` or `@tauri-apps/plugin-http` would leak across
// test files (see docs/development/testing.md). Instead, both helpers accept
// `isStandalone` and a fetch override so tests can wire fakes via constructor
// arguments — pure dependency injection.

import { describe, expect, it, mock } from 'bun:test'
import { createProxyFetch, createProxyWebSocket } from './proxy-fetch'

describe('createProxyFetch — Hosted mode', () => {
  it('rewrites caller headers to X-Proxy-Passthrough-* and sets the target URL header', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      calls.push({
        url,
        method: input instanceof Request ? input.method : (init?.method ?? 'GET'),
        headers,
      })
      return new Response('ok', {
        status: 200,
        headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json', 'Content-Type': 'text/plain' },
      })
    }) as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
    })

    await proxyFetch('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' },
      body: JSON.stringify({ x: 1 }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8000/v1/proxy')
    expect(calls[0].headers.get('x-proxy-target-url')).toBe('https://example.com/api')
    expect(calls[0].headers.get('x-proxy-passthrough-content-type')).toBe('application/json')
    expect(calls[0].headers.get('x-proxy-passthrough-mcp-session-id')).toBe('sess-1')
  })

  it('unwraps X-Proxy-Passthrough-* response headers into normal-looking headers', async () => {
    const fakeFetch = (async () =>
      new Response('ok', {
        status: 200,
        headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json', 'Content-Type': 'text/plain' },
      })) as unknown as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
    })

    const res = await proxyFetch('https://example.com/api', { method: 'GET' })
    expect(res.headers.get('content-type')).toBe('application/json')
  })
})

describe('createProxyFetch — Standalone (Tauri) mode', () => {
  it('calls Tauri fetch directly without rewriting headers when toggle is off (default)', async () => {
    const tauriFetchMock = mock(async () => new Response('tauri-direct', { status: 200 }))

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      tauriFetch: tauriFetchMock as unknown as typeof fetch,
      getProxyEnabled: () => false,
    })

    await proxyFetch('https://example.com/api', {
      method: 'GET',
      headers: { Authorization: 'Bearer abc' },
    })

    expect(tauriFetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = tauriFetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe('https://example.com/api')
    const h = new Headers(calledInit.headers)
    expect(h.get('authorization')).toBe('Bearer abc')
  })
})

describe('createProxyFetch — proxy_enabled toggle', () => {
  it('Tauri + toggle on: routes through the hosted proxy (privacy mode)', async () => {
    const tauriFetchMock = mock(async () => new Response('should-not-be-called', { status: 500 }))
    const hostedFetchMock = mock(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      return new Response(`hosted:${url}`, { status: 200 })
    })

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      tauriFetch: tauriFetchMock as unknown as typeof fetch,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      getProxyEnabled: () => true,
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(tauriFetchMock).toHaveBeenCalledTimes(0)
    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
    expect(hostedReq.headers.get('x-proxy-target-url')).toBe('https://example.com/api')
  })

  it('Web (not standalone): always proxies, ignoring the toggle value', async () => {
    const hostedFetchMock = mock(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      return new Response(`hosted:${url}`, { status: 200 })
    })

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => false,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      // Even with the toggle "off", Web must still proxy — CORS forces it.
      getProxyEnabled: () => false,
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
  })

  it('defaults getProxyEnabled to true when not provided (preserves Web behaviour)', async () => {
    const hostedFetchMock = mock(async () => new Response('ok', { status: 200 }))

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => false,
      fetchImpl: hostedFetchMock as unknown as typeof fetch,
      // getProxyEnabled omitted on purpose.
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(hostedFetchMock).toHaveBeenCalledTimes(1)
    const [hostedReq] = hostedFetchMock.mock.calls[0] as unknown as [Request]
    expect(hostedReq.url).toBe('http://localhost:8000/v1/proxy')
  })
})

describe('createProxyFetch — getProxyAuthToken wiring', () => {
  it('attaches `Authorization: Bearer <token>` on the proxy Request when the getter returns a token', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const req = input as Request
      calls.push({ url: req.url, headers: new Headers(req.headers) })
      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const proxyFetch = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: fakeFetch,
      isStandalone: () => false,
      getProxyAuthToken: () => 'session-token-abc',
    })

    await proxyFetch('https://example.com/api', { method: 'GET' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8000/v1/proxy')
    expect(calls[0].headers.get('authorization')).toBe('Bearer session-token-abc')
  })

  it('omits the Authorization header when the getter is absent or returns null', async () => {
    const captureAuth = (input: RequestInfo | URL): string | null =>
      new Headers((input as Request).headers).get('authorization')

    const withoutGetterCalls: Array<string | null> = []
    const proxyFetchNoGetter = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async (input) => {
        withoutGetterCalls.push(captureAuth(input))
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
      isStandalone: () => false,
    })
    await proxyFetchNoGetter('https://example.com/api', { method: 'GET' })
    expect(withoutGetterCalls).toEqual([null])

    const withNullGetterCalls: Array<string | null> = []
    const proxyFetchNullGetter = createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async (input) => {
        withNullGetterCalls.push(captureAuth(input))
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
      isStandalone: () => false,
      getProxyAuthToken: () => null,
    })
    await proxyFetchNullGetter('https://example.com/api', { method: 'GET' })
    expect(withNullGetterCalls).toEqual([null])
  })
})

describe('createProxyWebSocket', () => {
  it('Hosted: encodes target as tbproxy.target.<base64url> and connects to /proxy/ws', () => {
    let capturedUrl = ''
    let capturedProtocols: string[] = []
    class FakeWS {
      constructor(u: string, p: string[]) {
        capturedUrl = u
        capturedProtocols = p
      }
    }
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
      })
      factory('wss://upstream.test/path', ['acp.v1'])
      expect(capturedUrl).toBe('ws://localhost:8000/v1/proxy/ws')
      expect(capturedProtocols[0].startsWith('tbproxy.target.')).toBe(true)
      expect(capturedProtocols[1]).toBe('acp.v1')
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Standalone: connects directly to the target URL', () => {
    let capturedUrl = ''
    class FakeWS {
      constructor(u: string) {
        capturedUrl = u
      }
    }
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => true,
      })
      factory('wss://upstream.test/path')
      expect(capturedUrl).toBe('wss://upstream.test/path')
    } finally {
      globalThis.WebSocket = originalWS
    }
  })
})
