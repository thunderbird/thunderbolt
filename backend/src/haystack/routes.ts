/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import { getWsTicketStore, type WsTicketStore } from '@/auth/ws-ticket-store'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { Elysia } from 'elysia'
import { HaystackAcpServer, type HaystackAcpDeps } from './acp-server'
import { createHaystackProvider, parsePipelinesEnv } from './provider'

/**
 * Carrier subprotocol the client always advertises alongside the ticket. The
 * server echoes this back as `Sec-WebSocket-Protocol` so the upgrade
 * completes — RFC 6455 requires the server to pick one of the offered
 * subprotocols. The ticket subprotocol (`thunderbolt.ticket.<nonce>`) is
 * *never* echoed back so it doesn't surface to JS via `WebSocket.protocol`.
 */
const wsCarrierSubprotocol = 'thunderbolt.v1'

/** Ticket subprotocol entries start with this prefix; the rest is the opaque nonce. */
const wsTicketSubprotocolPrefix = 'thunderbolt.ticket.'

/**
 * Extract the ticket nonce from a comma-separated `Sec-WebSocket-Protocol`
 * value. Returns `null` if no ticket entry is present.
 */
const extractTicket = (header: string | null): string | null => {
  if (!header) {
    return null
  }
  for (const raw of header.split(',')) {
    const entry = raw.trim()
    if (entry.startsWith(wsTicketSubprotocolPrefix)) {
      const nonce = entry.slice(wsTicketSubprotocolPrefix.length)
      return nonce.length > 0 ? nonce : null
    }
  }
  return null
}

/**
 * Close code emitted when the WebSocket upgrade succeeds but auth fails. We
 * deliberately open the socket and then close with `4001` (in the
 * application-defined range 4000–4999) so the client distinguishes "the
 * server refused me" from "I never reached the server" — the former triggers
 * a re-login flow, the latter triggers a network-error toast.
 */
const wsCloseUnauthorized = 4001

/**
 * Mount the Haystack ACP adapter routes.
 *
 *  - Registers the Haystack provider into the agent discovery registry on
 *    construction (idempotent — `registerAgentProvider` dedupes on `id`, so
 *    HMR / repeated test setup is safe).
 *  - Exposes `WS /v1/haystack/ws?pipeline={pipelineId}` for the ACP wire.
 *
 * Auth: single-use ticket carried as a `Sec-WebSocket-Protocol` entry of the
 * form `thunderbolt.ticket.<nonce>`. The ticket is consumed in `open()` (NOT
 * `beforeHandle`) because Elysia/Bun invokes `beforeHandle` more than once per
 * upgrade in some paths, and single-use semantics turn the second invocation
 * into a spurious 4001. `open()` is called exactly once per accepted socket by
 * the Bun WS adapter, mirroring the pattern in `agent-proxy/routes.ts`.
 *
 * The carrier subprotocol echo happens in the `upgrade` hook, which Elysia
 * runs once per upgrade attempt before `server.upgrade()` and is purely
 * idempotent (sets a response header). The auth-bearing ticket subprotocol is
 * intentionally NOT echoed so it never lands on `WebSocket.protocol` or in
 * proxy response logs.
 */
export const createHaystackRoutes = (
  settings: Settings,
  deps?: HaystackAcpDeps,
  ticketStore: WsTicketStore = getWsTicketStore(),
) => {
  registerAgentProvider(createHaystackProvider())

  return new Elysia({ name: 'haystack-routes', prefix: '/haystack' }).onError(safeErrorHandler).ws('/ws', {
    upgrade({ request, set }) {
      // Echo the carrier subprotocol so strict WS clients (Bun, browsers) see
      // the offer was accepted. The auth-bearing `thunderbolt.ticket.*`
      // subprotocol is intentionally NOT echoed — keeping it off the response
      // header means it never lands in `WebSocket.protocol` (page JS) or
      // proxy response logs. This hook is idempotent — setting a response
      // header has no observable side effect if called more than once.
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
      }
    },
    open(ws) {
      const log = createStandaloneLogger(settings)
      const data = ws.data as unknown as { request?: Request }

      // Consume the single-use ticket exactly once per accepted socket. Doing
      // this in `beforeHandle` instead would burn the ticket on the first
      // invocation and reject the second (Bun's adapter can call beforeHandle
      // twice on the same upgrade, e.g. during query/header validation).
      const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
      const nonce = extractTicket(subprotocolHeader)
      const consumed = nonce ? ticketStore.consumeTicket(nonce, 'haystack') : null
      if (!consumed) {
        ws.close(wsCloseUnauthorized, 'unauthorized')
        return
      }
      // Synthesize a minimal user shape — only `id` and `isAnonymous` are
      // read downstream. Anonymous users can't mint tickets (the ticket
      // route returns 403 for them), so this is always a regular user.
      const user: User = { id: consumed.userId, isAnonymous: false } as User

      const url = new URL(data.request?.url ?? 'http://localhost/haystack/ws')
      const pipelineSlug = url.searchParams.get('pipeline')
      if (!pipelineSlug) {
        ws.close(wsCloseUnauthorized, 'missing pipeline parameter')
        return
      }

      // Resolve the public slug back to its Deepset identifiers. A missing
      // descriptor here means a stale FE URL or a redeploy that dropped the
      // pipeline — we close instead of opening to keep error surface tight.
      const descriptor = parsePipelinesEnv(settings).find((p) => p.id === pipelineSlug)
      if (!descriptor) {
        ws.close(wsCloseUnauthorized, 'unknown pipeline')
        return
      }

      const server = new HaystackAcpServer({
        send: (payload) => {
          ws.send(payload)
        },
        pipelineId: descriptor.pipelineId,
        pipelineName: descriptor.pipelineName,
        settings,
        deps,
      })
      ;(ws.data as unknown as { __haystackServer?: HaystackAcpServer }).__haystackServer = server
      log.debug({ pipelineSlug, pipelineName: descriptor.pipelineName, userId: user.id }, 'haystack ws opened')
    },
    async message(ws, message) {
      const server = (ws.data as unknown as { __haystackServer?: HaystackAcpServer }).__haystackServer
      if (!server) {
        // Auth already rejected this socket; the client may still race a
        // first frame before the close lands. Drop quietly.
        return
      }
      const text = typeof message === 'string' ? message : JSON.stringify(message)
      await server.handleMessage(text)
    },
    close(ws) {
      const slot = ws.data as unknown as { __haystackServer?: HaystackAcpServer }
      slot.__haystackServer?.dispose()
      slot.__haystackServer = undefined
    },
  })
}
