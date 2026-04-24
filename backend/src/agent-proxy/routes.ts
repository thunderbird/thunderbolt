import { consumeWsTicket } from '@/auth/ws-ticket'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { Elysia, t } from 'elysia'

const proxyTimeoutMs = 30_000
const maxSseBufferBytes = 10 * 1024 * 1024

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
  try {
    const parsed = JSON.parse(authMethod) as { apiKey?: string }
    return parsed.apiKey ?? null
  } catch {
    return null
  }
}

// ── WebSocket relay ──────────────────────────────────────────────────────────

type WsConnectionState = {
  type: 'websocket'
  upstream: WebSocket
  closed: boolean
}

const openWsRelay = (ws: ElysiaWS, url: string, apiKey: string | null): WsConnectionState => {
  // WS auth via subprotocol header — avoids leaking credentials in URL query params
  const protocols = apiKey ? ['acp', `Bearer.${apiKey}`] : undefined
  const upstream = new WebSocket(url, protocols)
  const state: WsConnectionState = { type: 'websocket', upstream, closed: false }

  upstream.addEventListener('message', (event) => {
    if (state.closed) return
    ws.send(typeof event.data === 'string' ? event.data : String(event.data))
  })

  upstream.addEventListener('close', (event) => {
    if (state.closed) return
    state.closed = true
    connections.delete(ws.id)
    ws.close(event.code ?? 1000, event.reason ?? '')
  })

  upstream.addEventListener('error', () => {
    console.error('[agent-proxy] Upstream WS error')
    if (state.closed) return
    state.closed = true
    connections.delete(ws.id)
    ws.close(4005, 'Upstream agent connection error')
  })

  return state
}

// ── HTTP/SSE relay ───────────────────────────────────────────────────────────

type HttpConnectionState = {
  type: 'http'
  agentUrl: string
  apiKey: string | null
  connectionId: string | null
  sessionId: string | null
  activeAbort: AbortController | null
  closed: boolean
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      if (buffer.length > maxSseBufferBytes) {
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
          const data = dataLines.join('')
          try {
            yield JSON.parse(data)
          } catch {
            // Skip non-JSON SSE events
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const classifyMessage = (msg: Record<string, unknown>): 'request' | 'notification' | 'response' => {
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
  activeAbort: null,
  closed: false,
})

const safeFetch = createSafeFetch(globalThis.fetch)

const handleHttpMessage = async (ws: ElysiaWS, message: unknown, state: HttpConnectionState) => {
  const msg = (typeof message === 'string' ? JSON.parse(message) : message) as Record<string, unknown>
  const msgType = classifyMessage(msg)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (state.connectionId) headers['Acp-Connection-Id'] = state.connectionId
  if (state.sessionId) headers['Acp-Session-Id'] = state.sessionId
  if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`

  if (msgType === 'notification' || msgType === 'response') {
    await safeFetch(state.agentUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(proxyTimeoutMs),
    })
    return
  }

  const ac = new AbortController()
  state.activeAbort = ac

  // Combine caller abort with timeout
  const timeout = setTimeout(() => ac.abort(), proxyTimeoutMs)

  try {
    const response = await safeFetch(state.agentUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: ac.signal,
    })

    const connId = response.headers.get('Acp-Connection-Id')
    if (connId) state.connectionId = connId
    const sessId = response.headers.get('Acp-Session-Id')
    if (sessId) state.sessionId = sessId

    const contentType = response.headers.get('Content-Type') || ''

    if (contentType.includes('text/event-stream') && response.body) {
      for await (const event of parseSSEStream(response.body)) {
        if (state.closed) break
        ws.send(JSON.stringify(event))
      }
    } else {
      const result = await response.json()
      ws.send(JSON.stringify(result))
    }
  } finally {
    clearTimeout(timeout)
    if (state.activeAbort === ac) {
      state.activeAbort = null
    }
  }
}

// ── Connection state ─────────────────────────────────────────────────────────

type ConnectionState = WsConnectionState | HttpConnectionState
const connections = new Map<string, ConnectionState>()

// ── Routes ───────────────────────────────────────────────────────────────────

export const createAgentProxyRoutes = () => {
  const router = new Elysia({ prefix: '/agent-proxy' })

  router.ws('/ws/:agentId', {
    query: t.Object({ ticket: t.Optional(t.String()) }),
    params: t.Object({ agentId: t.String() }),

    open: async (ws: ElysiaWS) => {
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
        // WS path lacks DNS pinning (no createSafeWebSocket equivalent).
        const validationUrl = agentUrl.replace(/^ws/, 'http')
        const validation = validateSafeUrl(validationUrl)
        if (!validation.valid) {
          ws.close(4003, 'Connection refused')
          return
        }

        const apiKey = parseApiKey(authMethod ?? null)
        const isWebSocket = agentUrl.startsWith('ws://') || agentUrl.startsWith('wss://')

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
        const data = typeof message === 'string' ? message : JSON.stringify(message)
        if (state.upstream.readyState === WebSocket.OPEN) {
          state.upstream.send(data)
        }
        return
      }

      handleHttpMessage(ws, message, state).catch((err) => {
        if (state.closed) return
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
        state.activeAbort?.abort()
      }
    },
  })

  return router
}
