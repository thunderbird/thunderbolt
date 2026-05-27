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
  /** Minimal FakeWebSocket sufficient for the deferred wrapper's plumbing. */
  class FakeWS {
    static instances: Array<FakeWS> = []
    readyState = 0 // CONNECTING — the wrapper only flushes sends after `open`
    url: string
    protocols: string[]
    listeners: Array<{ type: string; listener: (e: Event) => void }> = []
    closed: { code?: number; reason?: string } | null = null
    sent: string[] = []
    constructor(u: string, p?: string[]) {
      this.url = u
      this.protocols = p ?? []
      FakeWS.instances.push(this)
    }
    addEventListener(type: string, listener: (e: Event) => void) {
      this.listeners.push({ type, listener })
    }
    removeEventListener(type: string, listener: (e: Event) => void) {
      const idx = this.listeners.findIndex((l) => l.type === type && l.listener === listener)
      if (idx >= 0) {
        this.listeners.splice(idx, 1)
      }
    }
    send(data: string) {
      this.sent.push(data)
    }
    close(code?: number, reason?: string) {
      this.closed = { code, reason }
    }
  }

  /** Hand-rolled fake HttpClient — only the `.post(...).json()` chain is used. */
  const fakeHttpClient = (ticket: string) =>
    ({
      post: () => ({
        json: async () => ({ ticket, expiresAt: Date.now() + 30_000 }),
      }),
    }) as unknown as import('./http').HttpClient

  it('Hosted: fetches a ticket and includes carrier + ticket + target subprotocols on /proxy/ws', async () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      let ticketCalls = 0
      const fetchTicket = async () => {
        ticketCalls += 1
        return 'fake-ticket-abc'
      }
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        httpClient: fakeHttpClient('fake-ticket-abc'),
        fetchTicket,
      })
      factory('wss://upstream.test/path', ['acp.v1'])
      // The deferred wrapper kicks the opener on the next microtask; flush it.
      // Flush microtasks so the deferred wrapper's opener resolves. We don't
      // use `setTimeout(0)` here — fake timers are installed globally in this
      // codebase (src/testing-library.ts) and 0ms timers never fire on their
      // own. A bare `await Promise.resolve()` followed by another microtask
      // round is enough: opener().then(...) is the only chain we need to drain.
      await Promise.resolve()
      await Promise.resolve()
      expect(ticketCalls).toBe(1)
      expect(FakeWS.instances).toHaveLength(1)
      const real = FakeWS.instances[0]
      expect(real.url).toBe('ws://localhost:8000/v1/proxy/ws')
      expect(real.protocols[0]).toBe('thunderbolt.v1')
      expect(real.protocols[1]).toBe('thunderbolt.ticket.fake-ticket-abc')
      expect(real.protocols[2]?.startsWith('tbproxy.target.')).toBe(true)
      expect(real.protocols[3]).toBe('acp.v1')
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Hosted: queued listeners + sends are replayed once the real socket exists', async () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        httpClient: fakeHttpClient('ticket-1'),
        fetchTicket: async () => 'ticket-1',
      })
      const wrapper = factory('wss://upstream.test/path') as unknown as {
        addEventListener: (t: string, l: () => void) => void
        send: (d: string) => void
      }
      const onOpen = () => {}
      wrapper.addEventListener('open', onOpen)
      wrapper.send('queued-1')
      // Drain microtasks so the opener resolves and queued listeners replay.
      for (let i = 0; i < 4; i++) {
        await Promise.resolve()
      }
      const real = FakeWS.instances[0]
      // The user 'open' listener should have been replayed onto the real socket.
      expect(real.listeners.some((l) => l.type === 'open' && l.listener === onOpen)).toBe(true)
      // Fire every 'open' listener — the wrapper installs an internal flush
      // listener too, which is what actually pushes the buffered send through.
      real.readyState = 1
      for (const l of [...real.listeners].filter((entry) => entry.type === 'open')) {
        l.listener({ type: 'open' } as Event)
      }
      expect(real.sent).toContain('queued-1')
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Hosted: ticket fetch failure surfaces as an error event on the wrapper', async () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        httpClient: fakeHttpClient('ignored'),
        fetchTicket: async () => {
          throw new Error('ticket fetch failed')
        },
      })
      const wrapper = factory('wss://upstream.test/path') as unknown as {
        addEventListener: (t: string, l: (e: { message?: string }) => void) => void
      }
      const errors: Array<{ message?: string }> = []
      wrapper.addEventListener('error', (e) => errors.push(e))
      // Drain a few microtask rounds — opener rejection schedules a
      // queueMicrotask which schedules another microtask. Four awaits is
      // overkill but stable across Bun versions. `setTimeout(0)` is avoided
      // because fake timers are installed globally (src/testing-library.ts).
      for (let i = 0; i < 4; i++) {
        await Promise.resolve()
      }
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe('ticket fetch failed')
      // No real WebSocket should have been constructed.
      expect(FakeWS.instances).toHaveLength(0)
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Hosted: throws synchronously when httpClient is not provided', () => {
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => false,
        // no httpClient
      })
      expect(() => factory('wss://upstream.test/path')).toThrow(/httpClient is required/)
    } finally {
      globalThis.WebSocket = originalWS
    }
  })

  it('Standalone: connects directly to the target URL with no ticket fetch', () => {
    FakeWS.instances = []
    const originalWS = globalThis.WebSocket
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
    try {
      let ticketCalls = 0
      const factory = createProxyWebSocket({
        cloudUrl: 'http://localhost:8000/v1',
        isStandalone: () => true,
        fetchTicket: async () => {
          ticketCalls += 1
          return 'never-fetched'
        },
      })
      factory('wss://upstream.test/path')
      expect(FakeWS.instances).toHaveLength(1)
      expect(FakeWS.instances[0].url).toBe('wss://upstream.test/path')
      expect(ticketCalls).toBe(0)
    } finally {
      globalThis.WebSocket = originalWS
    }
  })
})
