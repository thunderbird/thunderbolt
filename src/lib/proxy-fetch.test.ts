/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Note: this test deliberately does NOT use `mock.module()`. Mocks of shared
// modules like `@/lib/platform` or `@tauri-apps/plugin-http` would leak across
// test files (see docs/internals/development/testing.md). Instead, both helpers accept
// `isStandalone` and a fetch override so tests can wire fakes via constructor
// arguments — pure dependency injection.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { encodeWsBearer } from '@shared/ws-bearer'
import { encodeBase64Url } from '@shared/base64url'
import { wsTargetPrefix } from '@shared/proxy-protocol'
import { createProxyFetch, createProxyWebSocket } from './proxy-fetch'
import { appVersionUnsupported, isAppVersionBlocked, resetAppVersionBlockedForTesting } from './app-version-unsupported'
import { setAuthToken } from './auth-token'

let originalStorage: Array<[string, string | null]>

beforeEach(() => {
  originalStorage = ['proxy_enabled', 'thunderbolt_auth_token'].map((key) => [key, localStorage.getItem(key)])
  localStorage.removeItem('proxy_enabled')
})

afterEach(() => {
  for (const [key, value] of originalStorage) {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  }
})

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

  it('preserves a Request signal on the hosted hop unless explicitly overridden', async () => {
    for (const override of [false, true]) {
      const inherited = new AbortController()
      const explicit = new AbortController()
      const sent: Request[] = []
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => false,
        fetchImpl: Object.assign(
          async (input: RequestInfo | URL) => {
            sent.push(input as Request)
            return new Response('ok')
          },
          { preconnect: fetch.preconnect },
        ),
      })

      await proxyFetch(
        new Request('https://provider.example', { signal: inherited.signal }),
        override ? { signal: explicit.signal } : undefined,
      )
      inherited.abort()
      expect(sent[0].signal.aborted).toBe(!override)
      explicit.abort()
      expect(sent[0].signal.aborted).toBe(true)
    }
  })

  it('honors signal: null on an already aborted Request on the hosted hop', async () => {
    const caller = new AbortController()
    caller.abort()
    const requests: Request[] = []
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => false,
      fetchImpl: Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(input as Request)
          return new Response('ok')
        },
        { preconnect: fetch.preconnect },
      ),
    })
    await proxyFetch(new Request('https://provider.example', { signal: caller.signal }), { signal: null })
    expect(requests[0].signal.aborted).toBe(false)
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

  it('sends backend credentials even when the caller passes a same-origin Request', async () => {
    const outer: Request[] = []
    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        outer.push(new Request(input))
        return new Response('ok')
      },
      { preconnect: fetch.preconnect },
    )
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://api.thunderbolt.example/v1',
      fetchImpl,
      isStandalone: () => false,
    })

    // `same-origin` is the browser's default for `new Request(...)`, which is what `http` hands over.
    await proxyFetch(new Request('https://example.com/models', { credentials: 'same-origin' }))

    expect(outer[0].credentials).toBe('include')
  })
})

describe('createProxyFetch — app-version gate', () => {
  const upgradeEnvelope = {
    success: false,
    data: null,
    error: 'Upgrade Required',
    code: 'APP_VERSION_UNSUPPORTED',
    minAppVersion: '99.0.0',
  }

  /** Collect `appVersionUnsupported` events for the duration of one test. */
  const captureBlockEvents = (): { events: CustomEvent[]; dispose: () => void } => {
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(appVersionUnsupported, listener)
    return { events, dispose: () => window.removeEventListener(appVersionUnsupported, listener) }
  }

  const proxyFetchReturning = (response: () => Response) =>
    createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      isStandalone: () => false,
    })

  // Both ends: start clean regardless of what ran before, and leave clean.
  beforeEach(() => {
    resetAppVersionBlockedForTesting()
  })

  afterEach(() => {
    resetAppVersionBlockedForTesting()
  })

  it('raises the upgrade blocker when our gate rejects the outer hop', async () => {
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(
      () => new Response(JSON.stringify(upgradeEnvelope), { status: 426, headers: { 'Content-Type': 'text/plain' } }),
    )

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({ minAppVersion: '99.0.0' })
    expect(isAppVersionBlocked()).toBe(true)
    dispose()
  })

  it('ignores a 426 relayed from the external upstream', async () => {
    // The proxy copies upstream status codes verbatim, so a provider answering
    // 426 must never blank the app — only our `APP_VERSION_UNSUPPORTED` envelope
    // means "this build is too old".
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(
      () =>
        new Response(JSON.stringify({ error: 'upstream wants a protocol upgrade' }), {
          status: 426,
          headers: { 'X-Proxy-Passthrough-Content-Type': 'application/json' },
        }),
    )

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(0)
    expect(isAppVersionBlocked()).toBe(false)
    dispose()
  })

  it('leaves the response body readable by the caller', async () => {
    const proxyFetch = proxyFetchReturning(() => new Response(JSON.stringify(upgradeEnvelope), { status: 426 }))

    const res = await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(res.status).toBe(426)
    expect(await res.json()).toEqual(upgradeEnvelope)
  })

  it('does not raise the blocker on a successful proxy response', async () => {
    const { events, dispose } = captureBlockEvents()
    const proxyFetch = proxyFetchReturning(() => new Response('ok', { status: 200 }))

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(events).toHaveLength(0)
    dispose()
  })
})

describe('createProxyFetch — Standalone (Tauri) mode', () => {
  it('calls Tauri fetch directly without rewriting headers when the toggle is off', async () => {
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

describe('createProxyFetch — native request boundaries', () => {
  afterEach(() => {
    resetAppVersionBlockedForTesting()
  })

  it.each(['inherited', 'explicit', 'null'] as const)(
    'disables native redirects and relays the Request signal (signal: %s)',
    async (override) => {
      const native = mock(
        async (_input: RequestInfo | URL, _init?: RequestInit & { maxRedirections?: number }) => new Response('ok'),
      )
      const inherited = new AbortController()
      const explicit = new AbortController()
      const request = new Request('https://provider.example/v1/messages', { signal: inherited.signal })
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        tauriFetch: native,
        fetchImpl: Object.assign(async () => new Response('unexpected backend'), { preconnect: fetch.preconnect }),
      })

      const response = await proxyFetch(
        request,
        override === 'inherited' ? undefined : { signal: override === 'null' ? null : explicit.signal },
      )

      expect(native.mock.calls[0][0]).toBe(request)
      const childSignal = native.mock.calls[0][1]?.signal
      expect(childSignal).toBeInstanceOf(AbortSignal)
      expect(childSignal).not.toBe(request.signal)
      expect(childSignal).not.toBe(explicit.signal)
      expect(native.mock.calls[0][1]?.maxRedirections).toBe(0)
      inherited.abort()
      expect(childSignal?.aborted).toBe(override === 'inherited')
      explicit.abort()
      expect(childSignal?.aborted).toBe(override !== 'null')
      await response.body!.cancel()
    },
  )

  it.each(['before', 'during'] as const)('reports AbortError when cancelled %s the native request', async (when) => {
    const controller = new AbortController()
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      tauriFetch: async () => {
        controller.abort()
        throw new Error('Request cancelled')
      },
    })
    if (when === 'before') {
      controller.abort()
    }

    const pending = proxyFetch('https://provider.example', { signal: controller.signal })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending).rejects.toBe(controller.signal.reason)
  })

  it("normalizes native body failures and preserves the caller's abort reason", async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController()
      let bodyController!: ReadableStreamDefaultController<Uint8Array>
      const upstream = new ReadableStream<Uint8Array>({
        start(stream) {
          bodyController = stream
          stream.enqueue(new TextEncoder().encode('chunk'))
        },
      })
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        tauriFetch: async () => new Response(upstream, { status: 201, headers: { 'x-provider': 'value' } }),
      })
      const response = await proxyFetch('https://provider.example', { signal: controller.signal })

      expect(response.status).toBe(201)
      expect(response.headers.get('x-provider')).toBe('value')
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk')
      if (aborted) {
        controller.abort()
      }
      bodyController.error('Request cancelled')
      if (aborted) {
        await expect(reader.read()).rejects.toBe(controller.signal.reason)
      } else {
        await expect(reader.read()).rejects.toMatchObject({
          name: 'TypeError',
          message: 'Failed to fetch',
          cause: 'Request cancelled',
        })
      }
    }
  })

  it('propagates native failures without retrying through the backend', async () => {
    const failure = new TypeError('native connection failed')
    const hosted = mock(async () => new Response('hosted'))
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      tauriFetch: async () => {
        throw failure
      },
      fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
    })

    await expect(proxyFetch('https://provider.example')).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Failed to fetch',
      cause: failure,
    })
    expect(hosted).not.toHaveBeenCalled()
  })

  it.each([
    [401, { code: 'UNAUTHENTICATED' }],
    [426, { code: 'APP_VERSION_UNSUPPORTED', minAppVersion: '99.0.0' }],
  ] as const)('does not treat a native provider %s as a backend rejection', async (status, body) => {
    setAuthToken('backend-token')
    const events: Event[] = []
    const listener = (event: Event) => events.push(event)
    window.addEventListener('powersync_credentials_invalid', listener)
    window.addEventListener(appVersionUnsupported, listener)
    const response = new Response(JSON.stringify(body), { status })
    const proxyFetch = createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      tauriFetch: async () => response,
      fetchImpl: Object.assign(async () => new Response('unexpected backend'), { preconnect: fetch.preconnect }),
    })
    try {
      const result = await proxyFetch('https://provider.example')
      expect(result.status).toBe(response.status)
      expect(await result.json()).toEqual(body)
      expect(events).toHaveLength(0)
      expect(isAppVersionBlocked()).toBe(false)
    } finally {
      window.removeEventListener('powersync_credentials_invalid', listener)
      window.removeEventListener(appVersionUnsupported, listener)
    }
  })
})

describe('createProxyFetch — proxy_enabled toggle', () => {
  it.each([
    ['string', 'http://localhost:3000/mcp'],
    ['URL', 'http://localhost:3000/mcp'],
    ['Request', 'http://localhost:3000/mcp'],
    ['string', 'http://127.0.0.1:8080/x'],
    ['URL', 'http://127.0.0.1:8080/x'],
    ['Request', 'http://127.0.0.1:8080/x'],
    ['string', 'http://[::1]:9000/'],
    ['URL', 'http://[::1]:9000/'],
    ['Request', 'http://[::1]:9000/'],
  ] as const)('%s input: keeps %s direct on Tauri and proxied on web with the toggle on', async (kind, url) => {
    const input = kind === 'Request' ? new Request(url) : kind === 'URL' ? new URL(url) : url
    const native = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('direct'))
    const hosted = mock(async (_input: RequestInfo | URL) => new Response('hosted'))
    const options = {
      cloudUrl: 'https://backend.example/v1',
      tauriFetch: native,
      fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
      getProxyEnabled: () => true,
    }
    const tauriFetch = createProxyFetch({ ...options, isStandalone: () => true })

    const response = await tauriFetch(input)

    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0][0]).toBe(input)
    expect(hosted).not.toHaveBeenCalled()
    expect(await response.text()).toBe('direct')

    const webFetch = createProxyFetch({ ...options, isStandalone: () => false })
    await webFetch(input)

    expect(native).toHaveBeenCalledTimes(1)
    expect(hosted).toHaveBeenCalledTimes(1)
    const hostedRequest = new Request(hosted.mock.calls[0][0])
    expect(hostedRequest.url).toBe('https://backend.example/v1/proxy')
    expect(hostedRequest.headers.get('x-proxy-target-url')).toBe(url)
  })

  it.each([null, 'false'])(
    'Tauri with stored %s defaults to native HTTP and switches to the backend when the proxy is enabled',
    async (stored) => {
      localStorage.removeItem('proxy_enabled')
      if (stored !== null) {
        localStorage.setItem('proxy_enabled', stored)
      }
      const native = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('direct'))
      const hosted = mock(async (_input: RequestInfo | URL) => new Response('hosted'))
      const auth = mock(() => 'backend-token')
      const proxyFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => true,
        tauriFetch: native,
        fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
        getProxyAuthToken: auth,
      })

      await proxyFetch('https://provider.example/v1/messages', { headers: { 'x-api-key': 'provider-key' } })

      expect(native).toHaveBeenCalledTimes(1)
      expect(hosted).not.toHaveBeenCalled()
      expect(auth).not.toHaveBeenCalled()
      const [, init] = native.mock.calls[0]
      expect(new Headers(init?.headers).get('x-api-key')).toBe('provider-key')
      expect(new Headers(init?.headers).has('x-app-version')).toBe(false)
      expect(new Headers(init?.headers).has('authorization')).toBe(false)

      localStorage.setItem('proxy_enabled', 'true')
      await proxyFetch('https://provider.example/v1/messages')
      expect(hosted).toHaveBeenCalledTimes(1)
      expect(native).toHaveBeenCalledTimes(1)
      const hostedRequest = new Request(hosted.mock.calls[0][0])
      expect(hostedRequest.url).toBe('https://backend.example/v1/proxy')

      localStorage.setItem('proxy_enabled', 'false')
      const webFetch = createProxyFetch({
        cloudUrl: 'https://backend.example/v1',
        isStandalone: () => false,
        fetchImpl: Object.assign(hosted, { preconnect: fetch.preconnect }),
      })
      await webFetch('https://provider.example/v1/messages')
      expect(hosted).toHaveBeenCalledTimes(2)
    },
  )

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

  it('defaults to hosted routing on web when getProxyEnabled is omitted', async () => {
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
  /** Minimal FakeWebSocket capturing the url + offered subprotocols. */
  class FakeWS {
    static instances: Array<FakeWS> = []
    readyState = 0
    url: string
    protocols: string[]
    constructor(u: string, p?: string[]) {
      this.url = u
      this.protocols = p ?? []
      FakeWS.instances.push(this)
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }

  let originalWS: typeof WebSocket

  beforeEach(() => {
    originalWS = globalThis.WebSocket
    FakeWS.instances = []
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWS
  })

  it.each([
    [false, 'wss://upstream.test/path'],
    [true, 'wss://upstream.test/path'],
    [false, 'ws://localhost:8839/'],
    [true, 'ws://upstream.test/path'],
    [true, 'ws://192.168.1.10:8839/'],
    [true, 'wss://192.168.1.10:8839/'],
  ] as const)(
    'proxy enabled (Tauri=%s): tunnels %s with carrier + bearer + target + caller protocols',
    (standalone, url) => {
      localStorage.setItem('proxy_enabled', 'true')
      const factory = createProxyWebSocket({
        cloudUrl: 'https://backend.test/v1/',
        isStandalone: () => standalone,
        getAuthToken: () => 'bearer-abc',
      })
      factory(url, ['acp.v1'])
      expect(FakeWS.instances).toHaveLength(1)
      const real = FakeWS.instances[0]
      expect(real.url).toBe('wss://backend.test/v1/proxy/ws')
      expect(real.protocols).toEqual([
        'thunderbolt.v1',
        `thunderbolt.bearer.${encodeWsBearer('bearer-abc')}`,
        `${wsTargetPrefix}${encodeBase64Url(url)}`,
        'acp.v1',
      ])
    },
  )

  it('Hosted: omits the bearer entry when no token is available (still offers carrier + target)', () => {
    const url = 'wss://upstream.test/path'
    const factory = createProxyWebSocket({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => false,
      getAuthToken: () => null,
    })
    factory(url)
    expect(FakeWS.instances).toHaveLength(1)
    expect(FakeWS.instances[0].protocols).toEqual(['thunderbolt.v1', `${wsTargetPrefix}${encodeBase64Url(url)}`])
  })

  it.each([
    [null, 'wss://upstream.test/path'],
    ['false', 'wss://upstream.test/path'],
    ['true', 'ws://127.0.0.1:8839/?token=bridge-token'],
    ['true', 'wss://127.42.0.1/acp'],
    ['true', 'ws://[::1]:8839/acp'],
    ['true', 'ws://localhost:8839/acp'],
    ['true', 'wss://agent.localhost/acp'],
  ])('Tauri proxy %s: connects directly to %s without reading or attaching the app bearer', (stored, url) => {
    if (stored !== null) {
      localStorage.setItem('proxy_enabled', stored)
    }
    const auth = mock(() => 'backend-only-token')
    const factory = createProxyWebSocket({
      cloudUrl: 'http://localhost:8000/v1',
      isStandalone: () => true,
      getAuthToken: auth,
    })
    factory(url, ['acp.v1'])
    expect(FakeWS.instances).toHaveLength(1)
    expect(FakeWS.instances[0].url).toBe(url)
    expect(FakeWS.instances[0].protocols).toEqual(['acp.v1'])
    expect(auth).not.toHaveBeenCalled()
  })

  it('reads Use Cloud Proxy for each new connection from the same factory', () => {
    const url = 'wss://upstream.test/path'
    const factory = createProxyWebSocket({
      cloudUrl: 'https://backend.test/v1',
      isStandalone: () => true,
      getAuthToken: () => 'backend-only-token',
    })
    factory(url)
    localStorage.setItem('proxy_enabled', 'true')
    factory(url)
    localStorage.setItem('proxy_enabled', 'false')
    factory(url)
    expect(FakeWS.instances.map((socket) => socket.url)).toEqual([url, 'wss://backend.test/v1/proxy/ws', url])
  })
})

describe('createProxyFetch — session rejected', () => {
  const unauthenticated = JSON.stringify({ code: 'UNAUTHENTICATED' })
  const originalDispatch = window.dispatchEvent
  let dispatchSpy: ReturnType<typeof mock>

  const proxyFetchReturning = (response: () => Response) =>
    createProxyFetch({
      cloudUrl: 'http://localhost:8000/v1',
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      isStandalone: () => false,
    })

  beforeEach(() => {
    setAuthToken('app-token')
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
  })

  it('treats our own auth gate rejecting the outer hop as a lost session', async () => {
    const proxyFetch = proxyFetchReturning(() => new Response(unauthenticated, { status: 401 }))

    await proxyFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect((dispatchSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: 'session_expired' })
  })

  it('ignores the same body when an upstream relays it, so a hostile server cannot sign the user out', async () => {
    const proxyFetch = proxyFetchReturning(
      () =>
        new Response(unauthenticated, { status: 401, headers: { 'X-Proxy-Final-Url': 'https://mcp.example.com/' } }),
    )

    await proxyFetch('https://mcp.example.com/', { method: 'POST' })

    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})

describe('createProxyFetch — native plugin failures and lifecycle', () => {
  const directFetch = (tauriFetch: NonNullable<Parameters<typeof createProxyFetch>[0]['tauriFetch']>) =>
    createProxyFetch({
      cloudUrl: 'https://backend.example/v1',
      isStandalone: () => true,
      getProxyEnabled: () => false,
      tauriFetch,
    })

  it('normalizes plugin-string request failures to network errors', async () => {
    const native = directFetch(async () => {
      throw 'connection refused'
    })
    await expect(native('https://provider.example')).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Failed to fetch',
      cause: 'connection refused',
    })
  })

  it('normalizes plugin-string body failures even without a caller signal', async () => {
    const native = directFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error('body read failed')
            },
          }),
        ),
    )
    const response = await native('https://provider.example')
    await expect(response.body!.getReader().read()).rejects.toMatchObject({
      name: 'TypeError',
      message: 'Failed to fetch',
      cause: 'body read failed',
    })
  })

  it.each(['null', 'eof', 'rejection', 'stream error', 'cancel'] as const)(
    'detaches the session-signal relay after %s across repeated requests',
    async (outcome) => {
      const caller = new AbortController()
      const added = spyOn(caller.signal, 'addEventListener')
      const removed = spyOn(caller.signal, 'removeEventListener')
      const native = directFetch(async (_input, init) => {
        // Model the plugin's anonymous listeners, which it never removes.
        init?.signal?.addEventListener('abort', () => {})
        if (outcome === 'rejection') {
          throw 'connection refused'
        }
        if (outcome === 'null') {
          return new Response(null, { status: 204 })
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (outcome === 'stream error') {
                controller.error('read failed')
                return
              }
              controller.enqueue(new TextEncoder().encode('chunk'))
              if (outcome === 'eof') {
                controller.close()
              }
            },
          }),
          { status: 201, statusText: 'Created', headers: { 'x-provider': 'value' } },
        )
      })
      try {
        for (const _ of [1, 2, 3]) {
          if (outcome === 'rejection') {
            await expect(native('https://provider.example', { signal: caller.signal })).rejects.toBeDefined()
            continue
          }
          const response = await native('https://provider.example', { signal: caller.signal })
          if (outcome === 'cancel') {
            await response.body!.cancel()
            continue
          }
          if (outcome === 'stream error') {
            await expect(response.text()).rejects.toBeDefined()
            continue
          }
          expect(await response.text()).toBe(outcome === 'eof' ? 'chunk' : '')
          if (outcome === 'eof') {
            expect(response.status).toBe(201)
            expect(response.statusText).toBe('Created')
            expect(response.headers.get('x-provider')).toBe('value')
          }
        }
        expect(added.mock.calls.length - removed.mock.calls.length).toBe(0)
        for (const [index, call] of added.mock.calls.entries()) {
          expect(removed.mock.calls[index]?.[1]).toBe(call[1])
        }
      } finally {
        added.mockRestore()
        removed.mockRestore()
      }
    },
  )

  it('rejects with the abort reason and cancels a body returned after abort', async () => {
    const caller = new AbortController()
    const pending = Promise.withResolvers<Response>()
    const cancel = mock(() => {})
    const entered = Promise.withResolvers<void>()
    const native = directFetch(async () => {
      entered.resolve()
      return pending.promise
    })
    const response = new Response(new ReadableStream({ cancel }))
    const result = native('https://provider.example', { signal: caller.signal })
    await entered.promise
    const reason = new Error('session closed')
    caller.abort(reason)
    pending.resolve(response)
    await expect(result).rejects.toBe(reason)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('preserves the native response URL with a wrapped streaming body', async () => {
    const upstream = new Response('chunks')
    Object.defineProperty(upstream, 'url', { value: 'https://provider.example/final' })
    const response = await directFetch(async () => upstream)('https://provider.example')
    expect(response.url).toBe('https://provider.example/final')
    expect(await response.text()).toBe('chunks')
  })
})
