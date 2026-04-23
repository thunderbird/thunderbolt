import { consumeWsTicket } from '@/auth/ws-ticket'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { Elysia, t } from 'elysia'

const proxyTimeoutMs = 30_000
const maxSseBufferChars = 10 * 1024 * 1024

/** Max messages queued while upstream WS is CONNECTING. Exceeding closes the client conn with 4005. */
export const maxPendingMessages = 64
/** Max total bytes queued while upstream WS is CONNECTING. Exceeding closes the client conn with 4005. */
export const maxPendingBytes = 256 * 1024

type ElysiaWS = {
  readonly id: string
  send: (data: string | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
  [key: string]: unknown
}

// ── Shared utilities ─────────────────────────────────────────────────────────

/** Parse apiKey from the agent's authMethod JSON column. */
export const parseApiKey = (authMethod: string | null): string | null => {
  if (!authMethod) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(authMethod)
  } catch {
    console.error('[agent-proxy] authMethod is not valid JSON — agent credentials will not be sent')
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[agent-proxy] authMethod JSON is not an object — credentials will not be sent')
    return null
  }
  const apiKey = (parsed as { apiKey?: unknown }).apiKey
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    console.warn('[agent-proxy] authMethod object has no string apiKey field')
    return null
  }
  return apiKey
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)

/**
 * Parses an incoming WS client message into a JSON-RPC object, or `null` if invalid.
 * Accepts strings (parsed as JSON), already-deserialized plain objects (passed through),
 * and rejects binary frames (Uint8Array/Buffer), arrays, primitives, and malformed JSON.
 */
export const parseClientMessage = (message: unknown): Record<string, unknown> | null => {
  if (isPlainObject(message)) return message
  if (typeof message !== 'string') return null
  try {
    const parsed = JSON.parse(message) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ── WebSocket relay ──────────────────────────────────────────────────────────

export type WsConnectionState = {
  type: 'websocket'
  upstream: WebSocket
  closed: boolean
  pendingMessages: string[]
  pendingBytes: number
}

type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocket

const defaultWebSocketFactory: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols)

/**
 * Opens an upstream WebSocket relay bound to the given downstream client `ws`.
 * Messages sent by the client while the upstream is still CONNECTING are queued
 * and flushed on `open`; the queue is bounded by {@link maxPendingMessages} and
 * {@link maxPendingBytes} to prevent unbounded memory growth.
 *
 * The `webSocketFactory` parameter allows tests to inject a fake upstream without
 * touching globals or making real network connections.
 */
export const openWsRelay = (
  ws: ElysiaWS,
  url: string,
  apiKey: string | null,
  webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
): WsConnectionState => {
  // WS auth via subprotocol header — avoids leaking credentials in URL query params
  const protocols = apiKey ? ['acp', `Bearer.${apiKey}`] : undefined
  // KNOWN LIMITATION: WebSocket upstream connections lack DNS-pinning.
  // validateSafeUrl provides synchronous hostname-only SSRF protection (blocks
  // private IPs and loopback), but a DNS rebinding attack where the hostname
  // first resolves public then changes to an internal IP between validation
  // and connection could bypass this. HTTP path uses safeFetch with resolveAndValidate
  // for full DNS pinning. TODO: implement createSafeWebSocket for parity.
  const upstream = webSocketFactory(url, protocols)
  const state: WsConnectionState = {
    type: 'websocket',
    upstream,
    closed: false,
    pendingMessages: [],
    pendingBytes: 0,
  }

  upstream.addEventListener('open', () => {
    if (state.closed) return
    for (const msg of state.pendingMessages) {
      if (state.closed) break
      upstream.send(msg)
    }
    state.pendingMessages.length = 0
    state.pendingBytes = 0
  })

  upstream.addEventListener('message', (event) => {
    if (state.closed) return
    ws.send(typeof event.data === 'string' ? event.data : String(event.data))
  })

  upstream.addEventListener('close', (event) => {
    if (state.closed) return
    state.closed = true
    connections.delete(ws.id)
    ws.close(event.code ?? 1000, event.reason ?? '')
    state.pendingMessages.length = 0
    state.pendingBytes = 0
  })

  upstream.addEventListener('error', (event) => {
    const detail = (event as ErrorEvent).message ?? 'unknown'
    console.error(`[agent-proxy] Upstream WS error for url=${url}: ${detail}`)
    if (state.closed) return
    state.closed = true
    connections.delete(ws.id)
    ws.close(4005, 'Upstream agent connection error')
    state.pendingMessages.length = 0
    state.pendingBytes = 0
  })

  return state
}

/**
 * Handles a client message destined for an upstream WebSocket relay.
 * If the upstream is OPEN, forwards immediately. If CONNECTING, queues the message
 * within {@link maxPendingMessages}/{@link maxPendingBytes} bounds; exceeding the
 * bounds closes the downstream client with code 4005. CLOSING/CLOSED is a silent drop.
 */
export const handleWsMessage = (ws: ElysiaWS, message: unknown, state: WsConnectionState): void => {
  const data = typeof message === 'string' ? message : JSON.stringify(message)
  if (state.upstream.readyState === WebSocket.OPEN) {
    state.upstream.send(data)
    return
  }
  if (state.upstream.readyState !== WebSocket.CONNECTING) {
    // CLOSING or CLOSED — message has no destination, drop silently
    return
  }
  // CONNECTING — queue with bounds
  const byteLen = Buffer.byteLength(data)
  if (state.pendingMessages.length >= maxPendingMessages || state.pendingBytes + byteLen > maxPendingBytes) {
    console.warn('[agent-proxy] Upstream connection backlog exceeded, closing')
    state.closed = true
    connections.delete(ws.id)
    state.pendingMessages.length = 0
    state.pendingBytes = 0
    // Close upstream BEFORE downstream to avoid leaking the in-flight handshake.
    // readyState is CONNECTING at this point (checked above); without closing, the
    // upstream WS continues connecting (and eventually opens) even though the relay
    // is torn down, burning a socket until the upstream peer's idle timeout.
    state.upstream.close()
    ws.close(4005, 'Upstream connection backlog exceeded')
    return
  }
  state.pendingMessages.push(data)
  state.pendingBytes += byteLen
}

// ── HTTP/SSE relay ───────────────────────────────────────────────────────────

export type HttpConnectionState = {
  type: 'http'
  agentUrl: string
  apiKey: string | null
  connectionId: string | null
  sessionId: string | null
  activeAborts: Set<AbortController>
  closed: boolean
  /**
   * Gate that serializes ACP session bootstrap. The first message with no sessionId
   * takes ownership (sets this to a pending promise); concurrent messages await it
   * so they see the `Acp-Session-Id` / `Acp-Connection-Id` headers returned by the
   * bootstrap response. Reset to null after a failed bootstrap so the next message
   * can retry. Stays null throughout the connection if no bootstrap is needed.
   */
  bootstrapPromise: Promise<void> | null
}

/**
 * Parses an SSE (Server-Sent Events) response body into a stream of JSON-decoded events.
 * Yields each successfully parsed event; drops non-JSON `data:` lines with a warning.
 * Throws if the buffer exceeds {@link maxSseBufferChars} characters to prevent unbounded memory growth.
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      if (buffer.length > maxSseBufferChars) {
        throw new Error('SSE buffer exceeded size limit')
      }

      const events = buffer.split('\n\n')
      buffer = events.pop() || ''

      for (const event of events) {
        const dataLines = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))

        if (dataLines.length > 0) {
          const data = dataLines.join('\n')
          try {
            yield JSON.parse(data)
          } catch {
            console.warn('[agent-proxy] Dropped non-JSON SSE event:', data.slice(0, 200))
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Classifies a JSON-RPC message by its shape:
 * - `request`: has both `method` and `id` (expects a response)
 * - `notification`: has `method` but no `id` (fire-and-forget)
 * - `response`: has neither (a reply to an earlier request)
 */
export const classifyMessage = (msg: Record<string, unknown>): 'request' | 'notification' | 'response' => {
  if ('method' in msg && 'id' in msg) return 'request'
  if ('method' in msg) return 'notification'
  return 'response'
}

const openHttpRelay = (url: string, apiKey: string | null): HttpConnectionState => ({
  type: 'http',
  agentUrl: url,
  apiKey,
  connectionId: null,
  sessionId: null,
  activeAborts: new Set(),
  closed: false,
  bootstrapPromise: null,
})

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const defaultSafeFetch: FetchImpl = createSafeFetch(globalThis.fetch)

/**
 * Handles a JSON-RPC message from the downstream WS client over an HTTP/SSE upstream.
 * The `fetchImpl` parameter allows tests to inject a fake fetch without touching globals.
 */
export const handleHttpMessage = async (
  ws: ElysiaWS,
  message: unknown,
  state: HttpConnectionState,
  fetchImpl: FetchImpl = defaultSafeFetch,
) => {
  const msg = parseClientMessage(message)
  if (msg === null) {
    console.warn('[agent-proxy] Dropped non-JSON client message:', String(message).slice(0, 200))
    ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
    return
  }
  const msgType = classifyMessage(msg)

  // ACP session bootstrap gate: serialize the first in-flight request so subsequent
  // messages see the `Acp-Session-Id` / `Acp-Connection-Id` headers returned by the
  // bootstrap response. Single-threaded JS makes the null-check + assignment atomic
  // (no `await` between them), so at most one message claims the bootstrap role.
  // Callers that arrive while bootstrap is in flight wait on the existing promise.
  const needsBootstrap = state.bootstrapPromise === null && state.sessionId === null
  const bootstrapResolvers = needsBootstrap ? Promise.withResolvers<void>() : null
  if (bootstrapResolvers) {
    state.bootstrapPromise = bootstrapResolvers.promise
  } else if (state.bootstrapPromise) {
    await state.bootstrapPromise
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (state.connectionId) headers['Acp-Connection-Id'] = state.connectionId
  if (state.sessionId) headers['Acp-Session-Id'] = state.sessionId
  if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`

  // Releases the bootstrap gate. If the bootstrap attempt failed to establish a session
  // (no sessionId populated), reset `bootstrapPromise` to null so the next caller can
  // retry the bootstrap itself. Safe to call multiple times: `Promise.resolve()` on an
  // already-resolved promise is a no-op, and the `sessionId === null` reset is idempotent.
  const releaseBootstrap = () => {
    if (!bootstrapResolvers) return
    if (state.sessionId === null) state.bootstrapPromise = null
    bootstrapResolvers.resolve()
  }

  if (msgType === 'notification' || msgType === 'response') {
    const ac = new AbortController()
    state.activeAborts.add(ac)
    const timeout = setTimeout(() => ac.abort(), proxyTimeoutMs)
    try {
      await fetchImpl(state.agentUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
        signal: ac.signal,
      })
    } catch (err) {
      console.warn('[agent-proxy] Fire-and-forget POST failed (session preserved):', err)
    } finally {
      clearTimeout(timeout)
      state.activeAborts.delete(ac)
      releaseBootstrap()
    }
    return
  }

  const ac = new AbortController()
  state.activeAborts.add(ac)

  const timeout = setTimeout(() => ac.abort(), proxyTimeoutMs)

  try {
    const response = await fetchImpl(state.agentUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: ac.signal,
    })
    // Headers have arrived — the initial timeout's job (bounding connect + headers time)
    // is done. Clearing here prevents a long-running SSE stream from being aborted mid-stream
    // at the 30s mark. Stream cancellation still works via `state.closed` checks in the loop
    // and via `activeAborts` iteration on WS close.
    clearTimeout(timeout)

    const connId = response.headers.get('Acp-Connection-Id')
    if (connId) state.connectionId = connId
    const sessId = response.headers.get('Acp-Session-Id')
    if (sessId) state.sessionId = sessId

    // Release the bootstrap gate as soon as session headers are captured — waiters
    // should not block on the SSE stream body of the bootstrap request.
    releaseBootstrap()

    const contentType = response.headers.get('Content-Type') || ''

    if (contentType.includes('text/event-stream') && response.body) {
      for await (const event of parseSSEStream(response.body)) {
        if (state.closed) break
        ws.send(JSON.stringify(event))
      }
    } else {
      const text = await response.text()
      if (state.closed) return
      try {
        const result = JSON.parse(text)
        ws.send(JSON.stringify(result))
      } catch {
        console.error(`[agent-proxy] Non-JSON response from upstream (status ${response.status}):`, text.slice(0, 500))
        if (state.closed) return
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Upstream returned non-JSON response' },
            id: (msg.id as string | number | null) ?? null,
          }),
        )
      }
    }
  } finally {
    clearTimeout(timeout)
    state.activeAborts.delete(ac)
    // No-op if already released after headers arrived; this covers the error path where
    // fetch threw before we could capture session headers (so waiters can retry bootstrap).
    releaseBootstrap()
  }
}

// ── Connection state ─────────────────────────────────────────────────────────

type ConnectionState = WsConnectionState | HttpConnectionState
const connections = new Map<string, ConnectionState>()

/** Clears the in-memory connection store. Used by tests to isolate state between test runs. */
export const clearConnections = (): void => {
  connections.clear()
}

// ── Routes ───────────────────────────────────────────────────────────────────

export const createAgentProxyRoutes = () => {
  return new Elysia({ prefix: '/agent-proxy' }).ws('/ws', {
    query: t.Object({ ticket: t.Optional(t.String()) }),

    open: (ws: ElysiaWS) => {
      try {
        const ticketId = (ws.data as { query?: { ticket?: string } }).query?.ticket
        if (!ticketId) {
          ws.close(4001, 'Unauthorized')
          return
        }

        const ticket = consumeWsTicket(ticketId)
        if (!ticket) {
          ws.close(4001, 'Unauthorized')
          return
        }

        const agentUrl = ticket.payload?.url as string | undefined
        const authMethod = ticket.payload?.authMethod as string | undefined

        if (!agentUrl) {
          ws.close(4004, 'Agent configuration missing')
          return
        }

        // SSRF protection — validateSafeUrl checks hostname synchronously;
        // safeFetch does DNS-pinned validation for the HTTP path.
        const validationUrl = agentUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        const validation = validateSafeUrl(validationUrl)
        if (!validation.valid) {
          ws.close(4003, 'Connection refused')
          return
        }

        const apiKey = parseApiKey(authMethod ?? null)
        const isWebSocket = agentUrl.startsWith('ws://') || agentUrl.startsWith('wss://')

        // Block API keys over unencrypted transports — ws:// leaks `Bearer.{apiKey}`
        // in the Sec-WebSocket-Protocol header, and http:// leaks the Authorization
        // header in cleartext. Require encrypted upstream (wss:// or https://).
        if (apiKey && (agentUrl.startsWith('ws://') || agentUrl.startsWith('http://'))) {
          ws.close(4003, 'API keys require encrypted upstream (wss:// or https://)')
          return
        }

        const state = isWebSocket ? openWsRelay(ws, agentUrl, apiKey) : openHttpRelay(agentUrl, apiKey)

        connections.set(ws.id, state)
      } catch (err) {
        console.error('[agent-proxy] Error in open handler:', err)
        ws.close(4005, 'Internal proxy error')
      }
    },

    message: (ws: ElysiaWS, message: unknown) => {
      const state = connections.get(ws.id)
      if (!state || state.closed) return

      if (state.type === 'websocket') {
        handleWsMessage(ws, message, state)
        return
      }

      handleHttpMessage(ws, message, state).catch((err) => {
        if (state.closed) {
          console.warn('[agent-proxy] HTTP relay error after close (suppressed):', err)
          return
        }
        console.error('[agent-proxy] HTTP relay error:', err)
        state.closed = true
        connections.delete(ws.id)
        ws.close(4005, 'Upstream agent error')
      })
    },

    close: (ws: ElysiaWS) => {
      const state = connections.get(ws.id)
      if (!state) return

      state.closed = true
      connections.delete(ws.id)

      if (state.type === 'websocket') {
        if (state.upstream.readyState === WebSocket.OPEN || state.upstream.readyState === WebSocket.CONNECTING) {
          state.upstream.close()
        }
      } else {
        for (const ac of state.activeAborts) ac.abort()
      }
    },
  })
}
