/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { createTinfoilKeepWarm } from './keep-warm'
import { createTinfoilRoutes, type TinfoilProxyLatencyLog, type TinfoilProxyLogger } from './routes'
import { createTinfoilUpstreamOriginStore, type TinfoilUpstreamOriginStore } from './upstream-origin'

const enclaveUrl = 'https://inference.tinfoil.sh'
const testApiKey = 'test-tinfoil-key'
const upstreamTimeoutMessage = 'tinfoil upstream timeout'
const upstreamIdleTimeoutMessage = 'tinfoil upstream idle timeout'
const realFetch = (globalThis as Record<string, unknown>).__originalFetch as typeof fetch

const makeOkResponse = (body = 'ok', extraHeaders: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...extraHeaders },
  })

/** Read the response body so capStream-style idle timers (if any) clear. */
const drain = async (res: Response): Promise<Response> => {
  if (res.body) {
    await res.arrayBuffer()
  }
  return res
}

/** Creates a fetch implementation whose pending request or response body follows its signal. */
const createAbortableFetch = (response?: Response) => {
  const started = Promise.withResolvers<AbortSignal>()
  const aborted = Promise.withResolvers<unknown>()
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    started.resolve(signal)

    if (!response) {
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => {
          aborted.resolve(signal.reason)
          reject(signal.reason)
        }
        signal.addEventListener('abort', rejectOnAbort, { once: true })
        if (signal.aborted) {
          rejectOnAbort()
        }
      })
    }

    const trackAbort = () => aborted.resolve(signal.reason)
    signal.addEventListener('abort', trackAbort, { once: true })
    if (signal.aborted) {
      trackAbort()
      return Promise.reject(signal.reason)
    }

    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) ?? null
    return Promise.resolve(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }) as unknown as typeof fetch

  return { fetchFn, started: started.promise, aborted: aborted.promise }
}

describe('createTinfoilRoutes', () => {
  let mockFetch: ReturnType<typeof mock>
  let consoleSpies: ConsoleSpies

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    mockFetch = mock(() => Promise.resolve(makeOkResponse()))
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve(makeOkResponse()))
    consoleSpies.error.mockClear()
  })

  const buildApp = (
    overrides: {
      apiKey?: string
      enclaveUrl?: string
      auth?: typeof mockAuth
      fetchFn?: typeof fetch
      logger?: TinfoilProxyLogger
      nowFn?: () => number
      upstreamHeadersTimeoutMs?: number
      upstreamIdleTimeoutMs?: number
      upstreamOriginStore?: TinfoilUpstreamOriginStore
    } = {},
  ) =>
    new Elysia().use(
      createTinfoilRoutes({
        auth: overrides.auth ?? mockAuth,
        fetchFn: overrides.fetchFn ?? (mockFetch as unknown as typeof fetch),
        logger: overrides.logger,
        nowFn: overrides.nowFn,
        apiKey: overrides.apiKey ?? testApiKey,
        enclaveUrl: overrides.enclaveUrl ?? enclaveUrl,
        upstreamHeadersTimeoutMs: overrides.upstreamHeadersTimeoutMs,
        upstreamIdleTimeoutMs: overrides.upstreamIdleTimeoutMs,
        upstreamOriginStore: overrides.upstreamOriginStore,
      }),
    )

  describe('configuration', () => {
    it('returns 503 when the Tinfoil API key is not configured', async () => {
      const app = buildApp({ apiKey: '' })
      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(res.status).toBe(503)
      expect(await res.text()).toBe('Tinfoil provider not configured')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('method allowlist', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])('returns 405 for disallowed method %s', async (method) => {
      const app = buildApp()
      const res = await app.handle(new Request('http://localhost/tinfoil/anything', { method, body: '' }))

      expect(res.status).toBe(405)
      expect(await res.text()).toBe('Method not allowed')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('header handling', () => {
    it('strips inbound Authorization and injects the server bearer key', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer client-supplied-secret',
              'content-type': 'application/octet-stream',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('authorization')).toBe(`Bearer ${testApiKey}`)
      expect(sent.get('authorization')).not.toBe('Bearer client-supplied-secret')
    })

    it('strips hop-by-hop headers (cookie, host, connection)', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              cookie: 'session=abc',
              connection: 'keep-alive',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('cookie')).toBeNull()
      expect(sent.get('connection')).toBeNull()
    })

    it('does not forward X-Tinfoil-Enclave-Url upstream', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': 'https://router.inf6.tinfoil.sh' },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('x-tinfoil-enclave-url')).toBeNull()
    })

    it('strips response hop-by-hop headers while preserving content encoding', async () => {
      mockFetch.mockResolvedValueOnce(
        makeOkResponse('opaque', {
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'content-encoding': 'br',
        }),
      )
      const app = buildApp()

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.headers.get('connection')).toBeNull()
      expect(res.headers.get('transfer-encoding')).toBeNull()
      expect(res.headers.get('content-encoding')).toBe('br')
      await res.arrayBuffer()
    })

    it('strips upstream CORS headers so only our own middleware sets them', async () => {
      // The enclave emits a duplicated `Access-Control-Allow-Credentials: true, true`
      // that browsers reject; relaying any upstream access-control-* would fight
      // our cors() middleware.
      mockFetch.mockResolvedValueOnce(
        makeOkResponse('opaque', {
          'access-control-allow-credentials': 'true, true',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-Upstream-Only',
          'ehbp-response-nonce': 'abc123',
        }),
      )
      const app = buildApp()

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('access-control-expose-headers')).toBeNull()
      expect(res.headers.get('ehbp-response-nonce')).toBe('abc123')
      await res.arrayBuffer()
    })
  })

  describe('body forwarding', () => {
    it('relays EHBP request and response bytes and headers unchanged', async () => {
      const requestPayload = new Uint8Array([0x00, 0xff, 0x01, 0x80])
      const responseChunks = [new Uint8Array([0xfe, 0x02]), new Uint8Array([0x00, 0x7f])]
      const requestBody = Promise.withResolvers<Uint8Array>()
      const requestEncapsulatedKey = Promise.withResolvers<string | null>()
      const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Headers
        const body = init?.body as ReadableStream<Uint8Array>
        requestEncapsulatedKey.resolve(headers.get('ehbp-encapsulated-key'))
        requestBody.resolve(new Uint8Array(await new Response(body).arrayBuffer()))

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of responseChunks) {
                controller.enqueue(chunk)
              }
              controller.close()
            },
          }),
          { headers: { 'Ehbp-Response-Nonce': 'response-nonce' } },
        )
      }) as unknown as typeof fetch
      const app = buildApp({ fetchFn })

      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          headers: { 'Ehbp-Encapsulated-Key': 'encapsulated-key' },
          body: requestPayload,
        }),
      )

      expect(await requestBody.promise).toEqual(requestPayload)
      expect(await requestEncapsulatedKey.promise).toBe('encapsulated-key')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xfe, 0x02, 0x00, 0x7f]))
      expect(res.headers.get('ehbp-response-nonce')).toBe('response-nonce')
    })

    it('forwards the request body for POST requests', async () => {
      const app = buildApp()
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04])

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: payload,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions`)
      expect(init.body).not.toBeNull()
      expect(init.method).toBe('POST')
      expect(init.redirect).toBe('manual')
      expect((init as RequestInit & { decompress: boolean }).decompress).toBeFalse()
      expect((init as RequestInit & { duplex: string }).duplex).toBe('half')
    })

    it('forwards JSON bodies untouched (parse: none keeps the stream intact)', async () => {
      const app = buildApp()
      const jsonBody = JSON.stringify({ model: 'glm-5-2', messages: [] })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).not.toBeNull()
    })

    it('does not forward a body for GET requests', async () => {
      const app = buildApp()
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).toBeNull()
    })
  })

  describe('upstream timeouts and aborts', () => {
    it('returns 504 and aborts upstream when response headers time out', async () => {
      const upstream = createAbortableFetch()
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamHeadersTimeoutMs: 0,
      })

      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(res.status).toBe(504)
      expect(res.headers.get('content-type')).toBe('text/plain')
      const body = await res.text()
      expect(body).toBe(upstreamTimeoutMessage)
      expect(await upstream.aborted).toBeInstanceOf(DOMException)
      expect(body).not.toContain(testApiKey)
    })

    it('errors a stalled response stream and aborts upstream', async () => {
      const firstChunk = new Uint8Array([0x01, 0xff])
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk)
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 0,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))
      const reader = res.body!.getReader()

      expect(await reader.read()).toEqual({ done: false, value: firstChunk })
      const stalledRead = reader.read()
      await expect(stalledRead).rejects.toThrow(upstreamIdleTimeoutMessage)
      await expect(stalledRead).rejects.not.toThrow(testApiKey)
      expect(await upstream.aborted).toBeInstanceOf(DOMException)
    })

    it('abruptly closes the socket when a relayed response stalls', async () => {
      const responseChunks = [new Uint8Array([0x01, 0x02]), new Uint8Array([0x03, 0x04])]
      const expectedBytes = new Uint8Array(responseChunks.flatMap((chunk) => [...chunk]))
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of responseChunks) {
                controller.enqueue(chunk)
              }
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 20,
      })
      // Real socket via Elysia's own listen so the route receives the genuine
      // `ctx.server` — hand-wiring `app.server` would bypass the seam under test.
      await new Promise<void>((resolve) => {
        app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
      })

      try {
        const res = await realFetch(new URL('/tinfoil/v1/models', app.server!.url))
        const reader = res.body!.getReader()
        const receivedBytes: number[] = []

        while (receivedBytes.length < expectedBytes.byteLength) {
          const result = await reader.read()
          if (result.done) {
            throw new Error('response ended before relaying both upstream chunks')
          }
          receivedBytes.push(...result.value)
        }

        expect(new Uint8Array(receivedBytes)).toEqual(expectedBytes)
        await expect(reader.read()).rejects.toThrow()
        expect(await upstream.aborted).toBeInstanceOf(DOMException)
      } finally {
        await app.stop(true)
      }
    })

    it('aborts upstream when the client request aborts', async () => {
      const upstream = createAbortableFetch()
      const clientController = new AbortController()
      const app = buildApp({ fetchFn: upstream.fetchFn })
      const response = app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
          signal: clientController.signal,
        }),
      )

      await upstream.started
      clientController.abort()

      expect(await upstream.aborted).toBe(clientController.signal.reason)
      expect(await (await response).text()).not.toContain(testApiKey)
    })

    it('keeps a steady response stream alive beyond the headers timeout', async () => {
      const chunks = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03]), new Uint8Array([0x04])]
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk)
                await new Promise((resolve) => setImmediate(resolve))
              }
              controller.close()
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamHeadersTimeoutMs: 0,
        upstreamIdleTimeoutMs: 50,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
      await new Promise((resolve) => setImmediate(resolve))
      expect((await upstream.started).aborted).toBeFalse()
    })
  })

  describe('latency instrumentation', () => {
    it('logs and exposes pre-handler, fetch, and upstream-header phases', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [90, 100, 112, 152]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const nowFn = () => {
        const timestamp = timestamps.shift()
        if (timestamp === undefined) {
          throw new Error('Unexpected timing read')
        }
        return timestamp
      }
      const app = buildApp({ logger, nowFn })

      const response = await drain(
        await app.handle(new Request('http://localhost/tinfoil/v1/models?request-secret=do-not-log')),
      )

      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 200,
            preHandlerMs: 10,
            handlerToUpstreamFetchMs: 12,
            upstreamFetchToHeadersMs: 40,
            handlerToOutcomeMs: 52,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
      expect(response.headers.get('x-proxy-timing')).toBe('pre=10;fetch=12;headers=40')
      expect(response.headers.get('server-timing')).toBe('pre;dur=10, fetch;dur=12, headers;dur=40')
      expect(JSON.stringify(entries)).not.toContain('request-secret')
      expect(JSON.stringify(entries)).not.toContain(testApiKey)
    })

    it('logs one structured line for a request rejected before upstream fetch', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 13]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        apiKey: '',
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })

      const response = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(response.status).toBe(503)
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 503,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: null,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 3,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })

    it('logs exactly one 504 line when upstream headers time out', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [90, 100, 105, 135]
      const upstream = createAbortableFetch()
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
        upstreamHeadersTimeoutMs: 0,
      })

      const response = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(504)
      expect(response.headers.get('x-proxy-timing')).toBe('pre=10;fetch=5;headers=na')
      expect(response.headers.get('server-timing')).toBe('pre;dur=10, fetch;dur=5')
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/chat/completions',
            status: 504,
            preHandlerMs: 10,
            handlerToUpstreamFetchMs: 5,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 35,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })

    it('logs exactly one 499 line when the client aborts before upstream headers', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 12, 20]
      const upstream = createAbortableFetch()
      const clientController = new AbortController()
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })
      const response = app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
          signal: clientController.signal,
        }),
      )

      await upstream.started
      clientController.abort()
      await response

      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/chat/completions',
            status: 499,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: 2,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 10,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
      expect(entries.some(({ context }) => context.status === 500)).toBeFalse()
    })

    it('logs exactly one 500 line when upstream fetch rejects', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 12, 20]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const fetchFn = (async () => {
        throw new Error('Upstream connection failed')
      }) as unknown as typeof fetch
      const app = buildApp({
        fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })

      const response = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(response.status).toBe(500)
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 500,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: 2,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 10,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })
  })

  describe('upstream URL derivation', () => {
    it('applies the configured API path prefix to the ATC-assigned enclave origin', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const upstreamOriginStore = createTinfoilUpstreamOriginStore()
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1', upstreamOriginStore })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions?stream=true', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/chat/completions?stream=true`)
      expect(upstreamOriginStore.get()).toBe(assignedEnclaveUrl)

      const keepWarmFetch = mock(() => Promise.resolve(makeOkResponse()))
      const keepWarm = createTinfoilKeepWarm(
        { tinfoilApiKey: testApiKey, tinfoilEnclaveUrl: 'https://inference.tinfoil.sh/v1' },
        {
          fetchFn: keepWarmFetch as unknown as typeof fetch,
          intervalMs: 100,
          logger: { debug: () => undefined },
          upstreamOriginStore,
        },
      )
      keepWarm.start()
      keepWarm.stop()

      expect(keepWarmFetch).toHaveBeenCalledWith(
        `${assignedEnclaveUrl}/v1/models`,
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('avoids a double slash when the assigned enclave origin has a trailing slash', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1' })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': `${assignedEnclaveUrl}/` },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/chat/completions`)
    })

    it('does not add a path prefix when the configured enclave URL has none', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh' })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/chat/completions`)
    })

    it.each(['https://sub.tinfoil.sh', 'https://tinfoil.sh'])(
      'accepts allowlisted assigned enclave URL %s',
      async (assignedEnclaveUrl) => {
        const app = buildApp()

        const response = await app.handle(
          new Request('http://localhost/tinfoil/v1/models', {
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
          }),
        )

        expect(response.status).toBe(200)
        await drain(response)
        const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
        expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/models`)
      },
    )

    it.each(['http://inference.tinfoil.sh', 'https://evil-tinfoil.sh', 'https://tinfoil.sh.evil.com'])(
      'rejects non-allowlisted assigned enclave URL %s',
      async (assignedEnclaveUrl) => {
        const app = buildApp()

        const response = await app.handle(
          new Request('http://localhost/tinfoil/v1/models', {
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
          }),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(response.headers.get('x-proxy-timing')).not.toBeNull()
        expect(await response.text()).toContain('Invalid X-Tinfoil-Enclave-Url')
        expect(mockFetch).not.toHaveBeenCalled()
      },
    )

    it('uses the configured enclave URL when no assignment header is provided', async () => {
      const fallbackEnclaveUrl = 'https://fallback.tinfoil.sh/v1'
      const app = buildApp({ enclaveUrl: fallbackEnclaveUrl })

      await drain(await app.handle(new Request('http://localhost/tinfoil/models')))

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${fallbackEnclaveUrl}/models`)
    })

    it('derives the upstream path from the wildcard, not the outer mount prefix', async () => {
      // Mount at a non-default outer prefix to prove the path comes from the wildcard.
      const app = new Elysia({ prefix: '/v2/alt' }).use(
        createTinfoilRoutes({
          auth: mockAuth,
          fetchFn: mockFetch as unknown as typeof fetch,
          apiKey: testApiKey,
          enclaveUrl,
        }),
      )

      await drain(
        await app.handle(
          new Request('http://localhost/v2/alt/tinfoil/v1/chat/completions?stream=true', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions?stream=true`)
    })

    it('strips trailing slash on the enclave URL before composing the upstream URL', async () => {
      const app = buildApp({ enclaveUrl: `${enclaveUrl}/` })
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/models`)
    })

    it('composes the upstream URL correctly when the enclave URL carries the /v1 API prefix', async () => {
      // Production wiring: TINFOIL_ENCLAVE_URL=https://inference.tinfoil.sh/v1,
      // and the SDK builds the request URL without an inner /v1 (its baseURL is
      // already <cloudUrl>/tinfoil, where cloudUrl ends in /v1).
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1' })
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe('https://inference.tinfoil.sh/v1/chat/completions')
    })
  })

  describe('authentication', () => {
    it('returns 401 when the session is null', async () => {
      const app = buildApp({ auth: mockAuthUnauthenticated })
      const res = await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      expect(res.status).toBe(401)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
