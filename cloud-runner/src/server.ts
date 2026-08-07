/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WebSocket server exposing the runner over ACP.
 *
 * Framing matches the app's managed-ACP transport: one JSON-RPC object per
 * WebSocket message (`src/acp/transports/websocket.ts` on the client side).
 *
 * Auth mirrors the backend's managed-ACP endpoints: the signed bearer rides a
 * `thunderbolt.bearer.<base64url>` subprotocol entry and only the carrier
 * `thunderbolt.v1` is echoed, so the credential never lands on
 * `WebSocket.protocol` or in proxy logs. Because introspection is an async
 * round-trip to the backend, frames arriving before the verdict are buffered
 * and flushed after — a fast client's `initialize` is never dropped. The
 * bearer is then re-introspected on an interval so a revoked or expired
 * session loses its socket instead of surviving until the client closes it.
 *
 * Keepalive: the server pings every 25s. The runner sits behind CloudFront
 * (10-minute idle cap) and an ALB (60s default idle timeout) — pings keep
 * every hop from reaping quiet connections between turns.
 */

import { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import type { Server, ServerWebSocket } from 'bun'
import { wsCarrierSubprotocol, wsCloseUnauthorized } from '../../shared/ws-bearer.ts'
import { authorizeConnection, extractBearerHeader, introspectBearer, type AuthorizedConnection } from './auth.ts'
import { createRunnerAgent } from './runner-agent.ts'
import type { RunnerConfig } from './config.ts'
import type { SessionRegistry } from './session-runtime.ts'

export { wsCloseUnauthorized }

const keepaliveIntervalMs = 25_000

/** Bound on frames buffered while introspection is in flight. A legitimate
 *  client sends only `initialize` before the verdict; anything past the cap is
 *  a misbehaving peer pumping memory. */
const maxPendingFrames = 64

/** Shared decoder for the rare binary inbound frame. Safe as a module
 *  singleton — never used with `{ stream: true }`, so it holds no state. */
const frameDecoder = new TextDecoder()

type ConnectionState = {
  readonly subprotocolHeader: string | null
  /** Frames received before auth settled; flushed (or dropped) afterwards. */
  pending: string[]
  /** Set once the bearer verdict is in and the ACP connection is wired. */
  push: ((frame: string) => void) | null
  end: (() => void) | null
  rejected: boolean
  /** Set by the `close` handler; the async auth continuation checks it so a
   *  socket dropped mid-introspection never gets wired (leaking its timers
   *  and ACP connection onto a dead peer). */
  closed: boolean
  timers: ReturnType<typeof setInterval>[]
}

type Socket = ServerWebSocket<ConnectionState>

/** Bridge one accepted socket to an SDK {@link Stream}: incoming frames feed
 *  the readable side, SDK writes are serialized one JSON object per frame. */
const createSocketStream = (ws: Socket): { stream: Stream; push: (frame: string) => void; end: () => void } => {
  let controller: ReadableStreamDefaultController<AnyMessage> | null = null
  let closed = false
  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c
    },
  })
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      // A send on a closing socket is a no-op in Bun — correct here: the
      // runtime, not the transport, owns turn state.
      ws.send(JSON.stringify(message))
    },
  })
  return {
    stream: { readable, writable },
    push: (frame) => {
      if (closed) return
      try {
        controller?.enqueue(JSON.parse(frame) as AnyMessage)
      } catch {
        ws.close(1003, 'invalid JSON frame')
      }
    },
    end: () => {
      if (closed) return
      closed = true
      controller?.close()
    },
  }
}

const openConnection = (
  ws: Socket,
  config: RunnerConfig,
  registry: SessionRegistry,
  connection: AuthorizedConnection,
): void => {
  const { stream, push, end } = createSocketStream(ws)
  new AgentSideConnection((conn) => createRunnerAgent(conn, registry, connection), stream)
  ws.data.push = push
  ws.data.end = end
  for (const frame of ws.data.pending) {
    push(frame)
  }
  ws.data.pending = []

  const revalidate = async (): Promise<void> => {
    // Fail closed: a backend that is unreachable, or that now refuses this
    // bearer, both end the socket. The client reconnects and re-authenticates,
    // which succeeds only if the session is genuinely still valid.
    const user = await introspectBearer(config.backendUrl, connection.bearer).catch(() => null)
    if (!user) ws.close(wsCloseUnauthorized, 'unauthorized')
  }

  ws.data.timers = [
    setInterval(() => ws.ping(), keepaliveIntervalMs),
    setInterval(() => void revalidate(), config.revalidateIntervalMs),
  ]
}

/** Account deletion: erase every trace of the caller from the runner. Hard
 *  delete is the point — this is the privacy-erasure path the backend invokes.
 *  An unreachable backend (introspection timeout) is a 503, not a 401: the
 *  caller retries, and "try again" is the honest verdict. */
const handlePurge = async (request: Request, config: RunnerConfig, registry: SessionRegistry): Promise<Response> => {
  const bearer = extractBearerHeader(request.headers.get('authorization'))
  if (!bearer) return new Response('unauthorized\n', { status: 401 })
  let user: Awaited<ReturnType<typeof introspectBearer>>
  try {
    user = await introspectBearer(config.backendUrl, bearer)
  } catch {
    return new Response('introspection unavailable\n', { status: 503 })
  }
  if (!user) return new Response('unauthorized\n', { status: 401 })
  await registry.purgeUser(user.id)
  return new Response(null, { status: 204 })
}

export type RunnerServer = { server: Server<ConnectionState>; stop: () => void }

/**
 * Start the runner's HTTP/WebSocket server.
 *
 * Routes: `GET /healthz` (load-balancer target health), `POST /purge`
 * (bearer-authenticated account erasure), and a WebSocket upgrade on `/` for
 * the ACP wire.
 */
export const startServer = (config: RunnerConfig, registry: SessionRegistry): RunnerServer => {
  const server = Bun.serve<ConnectionState>({
    port: config.port,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') {
        return new Response('ok\n')
      }
      if (url.pathname === '/purge' && request.method === 'POST') {
        return handlePurge(request, config, registry)
      }
      if (url.pathname !== '/') {
        return new Response('not found\n', { status: 404 })
      }
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      const offersCarrier = subprotocolHeader
        ?.split(',')
        .some((entry) => entry.trim() === wsCarrierSubprotocol)
      const upgraded = srv.upgrade(request, {
        data: {
          subprotocolHeader,
          pending: [],
          push: null,
          end: null,
          rejected: false,
          closed: false,
          timers: [],
        } satisfies ConnectionState,
        // Echo only the carrier — never the bearer-bearing entry.
        headers: offersCarrier ? { 'sec-websocket-protocol': wsCarrierSubprotocol } : undefined,
      })
      if (upgraded) return undefined
      return new Response('WebSocket endpoint only\n', { status: 426 })
    },
    websocket: {
      open(ws) {
        void (async () => {
          const connection = await authorizeConnection(config.backendUrl, ws.data.subprotocolHeader).catch(() => null)
          // The peer may have vanished while introspection was in flight —
          // wiring the connection then would leak its timers onto a dead socket.
          if (ws.data.closed) return
          if (!connection) {
            ws.data.rejected = true
            ws.data.pending = []
            ws.close(wsCloseUnauthorized, 'unauthorized')
            return
          }
          openConnection(ws, config, registry, connection)
        })()
      },
      message(ws, message) {
        if (ws.data.rejected) return
        const frame = typeof message === 'string' ? message : frameDecoder.decode(message)
        if (ws.data.push) {
          ws.data.push(frame)
          return
        }
        if (ws.data.pending.length >= maxPendingFrames) {
          ws.data.rejected = true
          ws.data.pending = []
          ws.close(1013, 'too many frames before authentication')
          return
        }
        ws.data.pending.push(frame)
      },
      close(ws) {
        ws.data.closed = true
        for (const timer of ws.data.timers) {
          clearInterval(timer)
        }
        ws.data.end?.()
      },
    },
  })
  return { server, stop: () => server.stop(true) }
}
