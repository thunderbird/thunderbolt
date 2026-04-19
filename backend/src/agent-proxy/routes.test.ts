import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  classifyMessage,
  clearConnections,
  createAgentProxyRoutes,
  handleHttpMessage,
  handleWsMessage,
  type HttpConnectionState,
  maxPendingBytes,
  maxPendingMessages,
  openWsRelay,
  parseApiKey,
  parseClientMessage,
  parseSSEStream,
  type WsConnectionState,
} from './routes'
import { clearTickets, consumeWsTicket, createWsTicket } from '@/auth/ws-ticket'

let consoleSpies: ConsoleSpies
beforeAll(() => {
  consoleSpies = setupConsoleSpy()
})
afterAll(() => {
  consoleSpies.restore()
})

beforeEach(() => {
  clearTickets()
  clearConnections()
})

describe('parseApiKey', () => {
  it('extracts apiKey from valid JSON', () => {
    expect(parseApiKey('{"apiKey":"sk-abc123"}')).toBe('sk-abc123')
  })

  it('returns null for null input', () => {
    expect(parseApiKey(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseApiKey('')).toBeNull()
  })

  it('returns null when apiKey field is missing', () => {
    expect(parseApiKey('{"other":"value"}')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseApiKey('not json')).toBeNull()
  })

  it('returns null for JSON without object shape', () => {
    expect(parseApiKey('"just a string"')).toBeNull()
  })

  it('returns null cleanly for JSON "null" without throwing', () => {
    consoleSpies.warn.mockClear()
    expect(parseApiKey('null')).toBeNull()
    expect(consoleSpies.warn).toHaveBeenCalledWith(
      '[agent-proxy] authMethod JSON is not an object — credentials will not be sent',
    )
  })

  it('returns null for JSON array', () => {
    expect(parseApiKey('[]')).toBeNull()
  })

  it('returns null for empty string apiKey', () => {
    expect(parseApiKey('{"apiKey":""}')).toBeNull()
  })

  it('returns null when apiKey is non-string', () => {
    expect(parseApiKey('{"apiKey":123}')).toBeNull()
  })
})

describe('parseClientMessage', () => {
  it('parses valid JSON strings', () => {
    expect(parseClientMessage('{"method":"ping","id":1}')).toEqual({ method: 'ping', id: 1 })
  })

  it('returns null for non-JSON strings', () => {
    expect(parseClientMessage('not json')).toBeNull()
  })

  it('passes through non-string objects as-is', () => {
    const obj = { method: 'ping', id: 1 }
    expect(parseClientMessage(obj)).toBe(obj)
  })

  it('returns null for Uint8Array (binary frame)', () => {
    expect(parseClientMessage(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('returns null for Buffer (binary frame)', () => {
    expect(parseClientMessage(Buffer.from([1, 2, 3]))).toBeNull()
  })

  it('returns null for null', () => {
    expect(parseClientMessage(null)).toBeNull()
  })

  it('returns null for arrays', () => {
    expect(parseClientMessage([1, 2, 3])).toBeNull()
  })

  it('returns null for primitives', () => {
    expect(parseClientMessage(42)).toBeNull()
    expect(parseClientMessage(true)).toBeNull()
  })

  it('returns null for JSON primitive string', () => {
    expect(parseClientMessage('"hello"')).toBeNull()
  })

  it('returns null for JSON primitive number', () => {
    expect(parseClientMessage('42')).toBeNull()
  })

  it('returns null for JSON primitive boolean', () => {
    expect(parseClientMessage('true')).toBeNull()
  })

  it('returns null for JSON null', () => {
    expect(parseClientMessage('null')).toBeNull()
  })

  it('returns null for JSON array string', () => {
    expect(parseClientMessage('[1,2,3]')).toBeNull()
  })
})

describe('WS ticket integration', () => {
  it('creates and consumes a ticket with agent payload', () => {
    const payload = { url: 'wss://agent.example.com/ws', authMethod: '{"apiKey":"test-key"}' }
    const ticketId = createWsTicket('user-test', payload)

    const result = consumeWsTicket(ticketId)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe('user-test')
    expect(result!.payload).toEqual(payload)

    const apiKey = parseApiKey(result!.payload!.authMethod as string)
    expect(apiKey).toBe('test-key')
  })

  it('prevents ticket reuse', () => {
    const ticketId = createWsTicket('user-test')
    expect(consumeWsTicket(ticketId)).not.toBeNull()
    expect(consumeWsTicket(ticketId)).toBeNull()
  })
})

// ── parseSSEStream tests ────────────────────────────────────────────────────

const encode = (text: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

const collect = async (stream: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const items: unknown[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

describe('parseSSEStream', () => {
  it('parses a single JSON SSE event', async () => {
    const body = encode('data: {"id":1}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ id: 1 }])
  })

  it('parses multiple JSON SSE events', async () => {
    const body = encode('data: {"a":1}\n\ndata: {"b":2}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('skips and logs non-JSON SSE events', async () => {
    const body = encode('data: not json\n\ndata: {"ok":true}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ ok: true }])
  })

  it('returns empty array for empty stream', async () => {
    const body = encode('')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([])
  })

  it('handles data: without space prefix', async () => {
    const body = encode('data:{"no":"space"}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ no: 'space' }])
  })

  it('handles data: with space prefix', async () => {
    const body = encode('data: {"with":"space"}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ with: 'space' }])
  })

  it('joins multi-line data fields', async () => {
    const body = encode('data: {"multi":\ndata: "line"}\n\n')
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ multi: 'line' }])
  })

  it('throws on buffer overflow (>10M chars)', async () => {
    const huge = 'data: ' + 'x'.repeat(11 * 1024 * 1024) + '\n\n'
    const body = encode(huge)
    await expect(collect(parseSSEStream(body))).rejects.toThrow('SSE buffer exceeded size limit')
  })

  it('handles multi-chunk streams where frames span multiple reads', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n'))
        controller.enqueue(encoder.encode('\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })
    const events = await collect(parseSSEStream(body))
    expect(events).toEqual([{ a: 1 }, { b: 2 }])
  })
})

// ── classifyMessage tests ───────────────────────────────────────────────────

describe('classifyMessage', () => {
  it('classifies request (has method and id)', () => {
    expect(classifyMessage({ method: 'tools/call', id: 1 })).toBe('request')
  })

  it('classifies notification (has method only)', () => {
    expect(classifyMessage({ method: 'notifications/progress' })).toBe('notification')
  })

  it('classifies response (has neither method)', () => {
    expect(classifyMessage({ result: {}, id: 1 })).toBe('response')
  })
})

// ── Route-level open-handler tests ──────────────────────────────────────────
//
// Elysia's ws() handler cannot easily be invoked end-to-end through app.handle()
// (which is HTTP-only). Instead we reach into the router's recorded hooks and
// invoke the `open` handler directly with a mock ws object. This covers the
// authentication and SSRF-validation branches of the open handler.

type MockWs = {
  id: string
  data: { query: { ticket?: string } }
  closeCalls: Array<{ code?: number; reason?: string }>
  sentMessages: string[]
  send: (data: string | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const createMockWs = (ticket?: string): MockWs => {
  const ws: MockWs = {
    id: `mock-ws-${Math.random().toString(36).slice(2)}`,
    data: { query: ticket !== undefined ? { ticket } : {} },
    closeCalls: [],
    sentMessages: [],
    send(data) {
      this.sentMessages.push(typeof data === 'string' ? data : String(data))
    },
    close(code, reason) {
      this.closeCalls.push({ code, reason })
    },
  }
  return ws
}

type WsRoute = {
  method: string
  path: string
  hooks: { open: (ws: MockWs) => void | Promise<void> }
}

const getOpenHandler = () => {
  const app = createAgentProxyRoutes()
  const route = (app.router.history as WsRoute[]).find((r) => r.method === 'WS' && r.path === '/agent-proxy/ws')
  if (!route) throw new Error('WS route not registered')
  return route.hooks.open
}

describe('createAgentProxyRoutes (open handler)', () => {
  it('registers the agent-proxy ws route', () => {
    const app = createAgentProxyRoutes()
    const route = (app.router.history as WsRoute[]).find((r) => r.method === 'WS' && r.path === '/agent-proxy/ws')
    expect(route).toBeDefined()
  })

  it('closes with 4001 when ticket query param is missing', async () => {
    const open = getOpenHandler()
    const ws = createMockWs()
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4001)
  })

  it('closes with 4001 when ticket is invalid or already consumed', async () => {
    const open = getOpenHandler()
    const ws = createMockWs('bogus-ticket-id-that-does-not-exist')
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4001)
  })

  it('closes with 4003 when ticket payload has a private-IP URL (SSRF)', async () => {
    const open = getOpenHandler()
    const ticketId = createWsTicket('user-ssrf', { url: 'http://127.0.0.1/ws' })
    const ws = createMockWs(ticketId)
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4003)
  })

  it('closes with 4004 when ticket has no url in payload', async () => {
    const open = getOpenHandler()
    const ticketId = createWsTicket('user-no-url')
    const ws = createMockWs(ticketId)
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4004)
  })

  it('closes with 4003 when ws:// is paired with an apiKey (cleartext credential)', async () => {
    const open = getOpenHandler()
    const ticketId = createWsTicket('user-ws-apikey', {
      url: 'ws://agent.example.com/ws',
      authMethod: '{"apiKey":"test-key"}',
    })
    const ws = createMockWs(ticketId)
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4003)
  })

  it('closes with 4003 when http:// is paired with an apiKey (cleartext credential)', async () => {
    const open = getOpenHandler()
    const ticketId = createWsTicket('user-http-apikey', {
      url: 'http://agent.example.com/acp',
      authMethod: '{"apiKey":"test-key"}',
    })
    const ws = createMockWs(ticketId)
    await open(ws)
    expect(ws.closeCalls).toHaveLength(1)
    expect(ws.closeCalls[0]!.code).toBe(4003)
  })

  it('consumes a valid ticket and opens an upstream connection (http scheme)', async () => {
    const open = getOpenHandler()
    // Use a public-looking hostname so SSRF validation passes. The handler will
    // create an HttpConnectionState without issuing any network request until a
    // message arrives, so this is safe to invoke in unit tests.
    const ticketId = createWsTicket('user-valid', { url: 'https://agent.example.com/acp' })
    const ws = createMockWs(ticketId)
    await open(ws)

    // No close should have happened — connection is considered open.
    expect(ws.closeCalls).toEqual([])
    // Ticket must have been consumed (one-time use).
    expect(consumeWsTicket(ticketId)).toBeNull()
  })
})

// ── handleHttpMessage tests ─────────────────────────────────────────────────

const createHttpState = (): HttpConnectionState => ({
  type: 'http',
  agentUrl: 'https://agent.example.com/acp',
  apiKey: null,
  connectionId: null,
  sessionId: null,
  activeAborts: new Set(),
  closed: false,
  bootstrapPromise: null,
})

describe('handleHttpMessage', () => {
  it('preserves the JSON-RPC request id in the error response when upstream returns non-JSON', async () => {
    const ws = createMockWs()
    const state = createHttpState()
    const fakeFetch = async () =>
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })

    await handleHttpMessage(ws, JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 42 }), state, fakeFetch)

    expect(ws.sentMessages).toHaveLength(1)
    const payload = JSON.parse(ws.sentMessages[0]!) as { id: unknown; error: { code: number } }
    expect(payload.id).toBe(42)
    expect(payload.error.code).toBe(-32603)
  })

  it('preserves a string request id in the error response', async () => {
    const ws = createMockWs()
    const state = createHttpState()
    const fakeFetch = async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })

    await handleHttpMessage(ws, JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 'abc-123' }), state, fakeFetch)

    const payload = JSON.parse(ws.sentMessages[0]!) as { id: unknown }
    expect(payload.id).toBe('abc-123')
  })

  it('clears the initial connect timeout once response headers arrive (long SSE streams not aborted)', async () => {
    const ws = createFakeDownstream()
    const state = createHttpState()

    // Build a ReadableStream that emits SSE events across multiple turns of the
    // microtask queue. Without FIX 1, the 30s initial connect timeout would still
    // be armed during streaming and fire on slow upstreams; after FIX 1 it is
    // cleared the moment fetchImpl resolves (headers received).
    const encoder = new TextEncoder()
    let enqueuedDuringStreaming = false
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"chunk":1}\n\n'))
        await new Promise((resolve) => queueMicrotask(() => resolve(undefined)))
        enqueuedDuringStreaming = true
        controller.enqueue(encoder.encode('data: {"chunk":2}\n\n'))
        controller.close()
      },
    })

    let capturedSignal: AbortSignal | undefined
    const fakeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      capturedSignal = init?.signal as AbortSignal
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    // Spy on clearTimeout to confirm FIX 1: the initial timer is cleared as
    // soon as fetchImpl resolves, not only in the `finally` block.
    const clearSpy = spyOn(globalThis, 'clearTimeout')
    const before = clearSpy.mock.calls.length

    await handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/prompt', id: 1 }),
      state,
      fakeFetch,
    )

    const clearCalls = clearSpy.mock.calls.length - before
    clearSpy.mockRestore()

    // Both chunks streamed through without an AbortError surfacing from the loop.
    const messages = ws.sentMessages.map((m) => JSON.parse(m))
    expect(messages).toEqual([{ chunk: 1 }, { chunk: 2 }])
    expect(enqueuedDuringStreaming).toBe(true)
    // The signal was never aborted — the initial timeout did not fire.
    expect(capturedSignal?.aborted).toBe(false)
    // clearTimeout fires twice: once after fetchImpl resolves (the FIX 1 call)
    // and once in the finally block. If FIX 1 regressed, we'd see only 1 call.
    expect(clearCalls).toBe(2)
    // activeAborts was cleaned up.
    expect(state.activeAborts.size).toBe(0)
  })

  it('aborts in-flight notification POSTs when close aborts activeAborts', async () => {
    const ws = createMockWs()
    const state = createHttpState()
    let capturedSignal: AbortSignal | undefined
    const fakeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = (_url, init) => {
      capturedSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }

    const promise = handleHttpMessage(
      ws,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' }),
      state,
      fakeFetch,
    )

    // Simulate close: abort all active controllers (mirrors the close handler).
    for (const ac of state.activeAborts) ac.abort()

    await promise

    expect(capturedSignal?.aborted).toBe(true)
    expect(state.activeAborts.size).toBe(0)
  })

  it('pipelines subsequent messages with Acp-Session-Id from bootstrap response', async () => {
    const ws = createFakeDownstream()
    const state = createHttpState()

    // Control when the first (bootstrap) fetch resolves so we can enqueue a second message
    // while bootstrap is still in flight.
    let resolveFirst: ((response: Response) => void) | null = null
    const capturedHeaders: Array<Record<string, string>> = []
    let call = 0

    const fakeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (_url, init) => {
      const headers = init?.headers as Record<string, string>
      capturedHeaders.push({ ...headers })
      call += 1
      if (call === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
        })
      }
      return new Response(JSON.stringify({ result: 'second', id: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Fire both messages in quick succession. Single-threaded JS means both synchronous
    // entries run before any `await` can yield, so both enter handleHttpMessage before
    // the second can observe the first's state changes across an await.
    const p1 = handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 1 }),
      state,
      fakeFetch,
    )
    const p2 = handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/prompt', id: 2 }),
      state,
      fakeFetch,
    )

    // Wait for the first fetch to be called.
    while (call < 1) await new Promise((r) => queueMicrotask(() => r(undefined)))

    // Resolve the bootstrap with session headers populated.
    resolveFirst!(
      new Response(JSON.stringify({ result: 'first', id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Acp-Session-Id': 'sess-123' },
      }),
    )

    await Promise.all([p1, p2])

    // First call had no session header (bootstrap); second call must carry the Acp-Session-Id
    // returned by the bootstrap response.
    expect(capturedHeaders).toHaveLength(2)
    expect(capturedHeaders[0]!['Acp-Session-Id']).toBeUndefined()
    expect(capturedHeaders[1]!['Acp-Session-Id']).toBe('sess-123')
    expect(state.sessionId).toBe('sess-123')
  })

  it('allows bootstrap retry after the first bootstrap attempt fails', async () => {
    const ws = createFakeDownstream()
    const state = createHttpState()

    let call = 0
    const fakeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      call += 1
      if (call === 1) throw new Error('network down')
      return new Response(JSON.stringify({ result: 'ok', id: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Acp-Session-Id': 'sess-retry' },
      })
    }

    // First call: bootstrap fails. Must not leave bootstrapPromise set so the next caller retries.
    await handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 1 }),
      state,
      fakeFetch,
    ).catch(() => {
      // handleHttpMessage surfaces the error on the request path — swallow here.
    })

    expect(state.bootstrapPromise).toBeNull()
    expect(state.sessionId).toBeNull()

    // Second call: must be able to bootstrap (not deadlock) and populate the session.
    await handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 2 }),
      state,
      fakeFetch,
    )

    expect(state.sessionId).toBe('sess-retry')
    expect(call).toBe(2)
  })

  it('resets bootstrapPromise when upstream returns success but no Acp-Session-Id header', async () => {
    const ws = createFakeDownstream()
    const state = createHttpState()

    const fakeFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => {
      // Success response with no session header — upstream protocol violation / degraded mode.
      return new Response(JSON.stringify({ result: 'ok', id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await handleHttpMessage(
      asElysiaWs(ws),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 1 }),
      state,
      fakeFetch,
    )

    // sessionId was never populated → releaseBootstrap must have reset bootstrapPromise
    // to null so the next arriving message can claim the bootstrap role and retry.
    expect(state.sessionId).toBeNull()
    expect(state.bootstrapPromise).toBeNull()
  })
})

// ── WS relay queue/flush tests ──────────────────────────────────────────────

type FakeUpstreamListeners = {
  open: Array<() => void>
  message: Array<(event: { data: string | ArrayBuffer }) => void>
  close: Array<(event: { code?: number; reason?: string }) => void>
  error: Array<(event: ErrorEvent) => void>
}

type FakeUpstreamWs = {
  readyState: number
  sentMessages: string[]
  closeCalls: number
  listeners: FakeUpstreamListeners
  addEventListener: (type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void) => void
  send: (data: string) => void
  close: () => void
  fireOpen: () => void
  fireClose: (code?: number, reason?: string) => void
  fireError: (message?: string) => void
}

const createFakeUpstream = (): FakeUpstreamWs => {
  const listeners: FakeUpstreamListeners = { open: [], message: [], close: [], error: [] }
  const fake: FakeUpstreamWs = {
    readyState: WebSocket.CONNECTING,
    sentMessages: [],
    closeCalls: 0,
    listeners,
    addEventListener(type, listener) {
      // Narrow to the right listener list by event type.
      if (type === 'open') listeners.open.push(listener as () => void)
      else if (type === 'message') listeners.message.push(listener as (event: { data: string | ArrayBuffer }) => void)
      else if (type === 'close') listeners.close.push(listener as (event: { code?: number; reason?: string }) => void)
      else if (type === 'error') listeners.error.push(listener as (event: ErrorEvent) => void)
    },
    send(data) {
      this.sentMessages.push(data)
    },
    close() {
      this.closeCalls += 1
      this.readyState = WebSocket.CLOSED
    },
    fireOpen() {
      this.readyState = WebSocket.OPEN
      for (const l of listeners.open) l()
    },
    fireClose(code, reason) {
      this.readyState = WebSocket.CLOSED
      for (const l of listeners.close) l({ code, reason })
    },
    fireError(message) {
      for (const l of listeners.error) l({ message: message ?? 'upstream error' } as ErrorEvent)
    },
  }
  return fake
}

type FakeDownstreamWs = {
  id: string
  sentMessages: string[]
  closeCalls: Array<{ code?: number; reason?: string }>
  send: (data: string | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const createFakeDownstream = (): FakeDownstreamWs => ({
  id: `ds-${Math.random().toString(36).slice(2)}`,
  sentMessages: [],
  closeCalls: [],
  send(data) {
    this.sentMessages.push(typeof data === 'string' ? data : String(data))
  },
  close(code, reason) {
    this.closeCalls.push({ code, reason })
  },
})

const createWsState = (upstream: FakeUpstreamWs): WsConnectionState => ({
  type: 'websocket',
  upstream: upstream as unknown as WebSocket,
  closed: false,
  pendingMessages: [],
  pendingBytes: 0,
})

type WsFactory = Parameters<typeof openWsRelay>[3]
type ElysiaWsArg = Parameters<typeof openWsRelay>[0]

const asElysiaWs = (ws: FakeDownstreamWs): ElysiaWsArg => ws as unknown as ElysiaWsArg
const asWebSocketFactory = (fake: FakeUpstreamWs): WsFactory => (() => fake as unknown as WebSocket) as WsFactory

describe('handleWsMessage (queue and flush)', () => {
  it('forwards immediately when upstream is OPEN', () => {
    const upstream = createFakeUpstream()
    upstream.readyState = WebSocket.OPEN
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    handleWsMessage(asElysiaWs(ws), '{"method":"ping"}', state)

    expect(upstream.sentMessages).toEqual(['{"method":"ping"}'])
    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
  })

  it('queues messages while upstream is CONNECTING', () => {
    const upstream = createFakeUpstream()
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    handleWsMessage(asElysiaWs(ws), '{"id":1}', state)
    handleWsMessage(asElysiaWs(ws), '{"id":2}', state)

    expect(upstream.sentMessages).toEqual([])
    expect(state.pendingMessages).toEqual(['{"id":1}', '{"id":2}'])
    expect(state.pendingBytes).toBe(Buffer.byteLength('{"id":1}') + Buffer.byteLength('{"id":2}'))
    expect(ws.closeCalls).toEqual([])
  })

  it('stringifies non-string messages before queueing', () => {
    const upstream = createFakeUpstream()
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    handleWsMessage(asElysiaWs(ws), { method: 'init', id: 7 }, state)

    expect(state.pendingMessages).toEqual(['{"method":"init","id":7}'])
  })

  it('silently drops messages when upstream is CLOSING or CLOSED', () => {
    const upstream = createFakeUpstream()
    upstream.readyState = WebSocket.CLOSED
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    handleWsMessage(asElysiaWs(ws), '{"id":1}', state)

    expect(upstream.sentMessages).toEqual([])
    expect(state.pendingMessages).toEqual([])
    expect(ws.closeCalls).toEqual([])
  })

  it('closes the downstream with 4005 when pending message count exceeds bound', () => {
    const upstream = createFakeUpstream()
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    // Fill to the bound. Each msg is tiny so byte bound is not hit.
    for (let i = 0; i < maxPendingMessages; i++) {
      handleWsMessage(asElysiaWs(ws), `{"i":${i}}`, state)
    }
    expect(state.pendingMessages).toHaveLength(maxPendingMessages)
    expect(ws.closeCalls).toEqual([])

    // One more — should overflow and close.
    handleWsMessage(asElysiaWs(ws), '{"overflow":true}', state)

    expect(ws.closeCalls).toEqual([{ code: 4005, reason: 'Upstream connection backlog exceeded' }])
    expect(state.closed).toBe(true)
    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
    // Upstream handshake must be cancelled to avoid leaking a connecting socket.
    expect(upstream.closeCalls).toBe(1)
  })

  it('closes the downstream with 4005 when pending bytes exceed bound', () => {
    const upstream = createFakeUpstream()
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    // One payload that alone exceeds the byte bound.
    const big = 'x'.repeat(maxPendingBytes + 1)
    handleWsMessage(asElysiaWs(ws), big, state)

    expect(ws.closeCalls).toEqual([{ code: 4005, reason: 'Upstream connection backlog exceeded' }])
    expect(state.closed).toBe(true)
    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
  })

  it('closes the upstream WS when backlog overflow tears down the relay', () => {
    const upstream = createFakeUpstream()
    // Upstream is CONNECTING — without closing it, the handshake would continue after teardown.
    const ws = createFakeDownstream()
    const state = createWsState(upstream)

    const big = 'x'.repeat(maxPendingBytes + 1)
    handleWsMessage(asElysiaWs(ws), big, state)

    expect(upstream.closeCalls).toBe(1)
    expect(ws.closeCalls).toEqual([{ code: 4005, reason: 'Upstream connection backlog exceeded' }])
  })
})

describe('openWsRelay (lifecycle)', () => {
  it('flushes queued messages in order when upstream fires open', () => {
    const fake = createFakeUpstream()
    const ws = createFakeDownstream()

    const state = openWsRelay(asElysiaWs(ws), 'wss://agent.example.com/ws', null, asWebSocketFactory(fake))

    handleWsMessage(asElysiaWs(ws), '{"id":1}', state)
    handleWsMessage(asElysiaWs(ws), '{"id":2}', state)
    expect(fake.sentMessages).toEqual([])

    fake.fireOpen()

    expect(fake.sentMessages).toEqual(['{"id":1}', '{"id":2}'])
    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
  })

  it('drains pending queue when upstream closes before opening', () => {
    const fake = createFakeUpstream()
    const ws = createFakeDownstream()

    const state = openWsRelay(asElysiaWs(ws), 'wss://agent.example.com/ws', null, asWebSocketFactory(fake))

    handleWsMessage(asElysiaWs(ws), '{"id":1}', state)
    handleWsMessage(asElysiaWs(ws), '{"id":2}', state)
    expect(state.pendingMessages).toHaveLength(2)

    fake.fireClose(1006, 'upstream gone')

    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
    expect(state.closed).toBe(true)
    expect(ws.closeCalls).toEqual([{ code: 1006, reason: 'upstream gone' }])
  })

  it('drains pending queue when upstream errors before opening', () => {
    const fake = createFakeUpstream()
    const ws = createFakeDownstream()

    const state = openWsRelay(asElysiaWs(ws), 'wss://agent.example.com/ws', null, asWebSocketFactory(fake))

    handleWsMessage(asElysiaWs(ws), '{"id":1}', state)
    expect(state.pendingMessages).toHaveLength(1)

    fake.fireError('handshake failed')

    expect(state.pendingMessages).toEqual([])
    expect(state.pendingBytes).toBe(0)
    expect(state.closed).toBe(true)
    expect(ws.closeCalls).toEqual([{ code: 4005, reason: 'Upstream agent connection error' }])
  })
})
