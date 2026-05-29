/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import type { Auth } from '@/auth/elysia-plugin'
import { authorizeWsBearer } from '@/auth/ws-bearer-auth'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { Elysia, t } from 'elysia'
import { HaystackAcpServer, type HaystackAcpDeps } from './acp-server'
import { createHaystackProvider, parsePipelinesEnv } from './provider'

/**
 * Carrier subprotocol the client always advertises alongside the bearer. The
 * server echoes this back as `Sec-WebSocket-Protocol` so the upgrade
 * completes — RFC 6455 requires the server to pick one of the offered
 * subprotocols. The bearer subprotocol (`thunderbolt.bearer.<token>`) is
 * *never* echoed back so it doesn't surface to JS via `WebSocket.protocol`.
 */
const wsCarrierSubprotocol = 'thunderbolt.v1'

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
 * Auth: the signed bearer token carried as a `Sec-WebSocket-Protocol` entry of
 * the form `thunderbolt.bearer.<token>`. It is validated in `open()` (NOT
 * `beforeHandle`, which Elysia/Bun invokes more than once per upgrade) via the
 * same Better Auth path REST uses — HMAC signature check + DB session lookup.
 * Anonymous users are rejected. `open()` is called exactly once per accepted
 * socket by the Bun WS adapter.
 *
 * The carrier subprotocol echo happens in the `upgrade` hook, which Elysia
 * runs once per upgrade attempt before `server.upgrade()` and is purely
 * idempotent (sets a response header). The auth-bearing bearer subprotocol is
 * intentionally NOT echoed so it never lands on `WebSocket.protocol` or in
 * proxy response logs.
 */
export const createHaystackRoutes = (settings: Settings, auth: Auth, deps?: HaystackAcpDeps) => {
  registerAgentProvider(createHaystackProvider())

  const fetchFn = deps?.fetchFn ?? globalThis.fetch

  return new Elysia({ name: 'haystack-routes', prefix: '/haystack' })
    .onError(safeErrorHandler)
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      // Better Auth populates `session.user` with `additionalFields` (`isAnonymous`).
      const sessionUser = session?.user as User | undefined
      return { authedUser: sessionUser ?? null }
    })
    .get(
      '/files/:fileId',
      async ({ params, set, authedUser }) => {
        if (!authedUser) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        if (authedUser.isAnonymous) {
          set.status = 403
          return { error: 'Forbidden', code: 'ANONYMOUS_FILE_FORBIDDEN' }
        }

        const base = settings.haystackBaseUrl.replace(/\/$/, '')
        const url = `${base}/api/v1/workspaces/${settings.haystackWorkspace}/files/${encodeURIComponent(params.fileId)}`
        const upstream = await fetchFn(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${settings.haystackApiKey}`,
            accept: '*/*',
          },
        })

        if (!upstream.ok) {
          // Auth failures upstream indicate a misconfigured server-side key, not a
          // client problem — surface as 502 so the client doesn't try to re-login.
          if (upstream.status === 401 || upstream.status === 403) {
            const log = createStandaloneLogger(settings)
            log.error({ status: upstream.status, fileId: params.fileId }, 'haystack file upstream auth failed')
            set.status = 502
            return { error: 'upstream auth failed' }
          }
          set.status = upstream.status
          return { error: `upstream ${upstream.status} ${upstream.statusText}` }
        }

        // Stream the body straight back. We don't buffer — Deepset files can be
        // multi-MB and the Response constructor accepts a ReadableStream directly.
        const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' }
        const contentType = upstream.headers.get('content-type')
        if (contentType) {
          headers['content-type'] = contentType
        }
        const contentLength = upstream.headers.get('content-length')
        if (contentLength) {
          headers['content-length'] = contentLength
        }
        const contentDisposition = upstream.headers.get('content-disposition')
        if (contentDisposition) {
          headers['content-disposition'] = contentDisposition
        }
        return new Response(upstream.body, { status: 200, headers })
      },
      {
        // Restrict to a conservative charset — Deepset file ids are UUID-like
        // (`[\w-]+`). Anything else is rejected before we make the upstream call.
        params: t.Object({ fileId: t.String({ pattern: '^[\\w-]+$' }) }),
      },
    )
    .ws('/ws', {
      upgrade({ request, set }) {
        // Echo the carrier subprotocol so strict WS clients (Bun, browsers) see
        // the offer was accepted. The auth-bearing `thunderbolt.bearer.*`
        // subprotocol is intentionally NOT echoed — keeping it off the response
        // header means it never lands in `WebSocket.protocol` (page JS) or
        // proxy response logs. This hook is idempotent — setting a response
        // header has no observable side effect if called more than once.
        const subprotocolHeader = request.headers.get('sec-websocket-protocol')
        if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
          set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
        }
      },
      async open(ws) {
        const log = createStandaloneLogger(settings)
        const slot = ws.data as unknown as {
          request?: Request
          __haystackServer?: HaystackAcpServer
          __pendingMessages?: string[] | null
        }

        // Buffer any client message that arrives during `open()`'s async work.
        // The client's `onopen` fires as soon as the WS handshake completes,
        // and Bun delivers `message(ws, ...)` before this handler's `await`s
        // resolve. Without a queue, the message hits `__haystackServer` while
        // it's still undefined and gets dropped, leaving the client hanging
        // on the response. Set this synchronously, before any await.
        const queue: string[] = []
        slot.__pendingMessages = queue

        // Validate the bearer exactly once per accepted socket. Doing this in
        // `beforeHandle` instead is unsafe because Bun's adapter can call it
        // more than once per upgrade. The bearer rides a subprotocol entry
        // (browsers can't set `Authorization` on `new WebSocket()`); it is
        // verified via the same Better Auth path REST uses (HMAC + DB lookup).
        const subprotocolHeader = slot.request?.headers.get('sec-websocket-protocol') ?? null
        const user: User | null = await authorizeWsBearer(auth, subprotocolHeader)
        if (!user) {
          slot.__pendingMessages = null
          ws.close(wsCloseUnauthorized, 'unauthorized')
          return
        }

        const url = new URL(slot.request?.url ?? 'http://localhost/haystack/ws')
        const pipelineSlug = url.searchParams.get('pipeline')
        if (!pipelineSlug) {
          slot.__pendingMessages = null
          ws.close(wsCloseUnauthorized, 'missing pipeline parameter')
          return
        }

        // Resolve the public slug back to its Deepset identifiers. A missing
        // descriptor here means a stale FE URL or a redeploy that dropped the
        // pipeline — we close instead of opening to keep error surface tight.
        const descriptor = parsePipelinesEnv(settings).find((p) => p.id === pipelineSlug)
        if (!descriptor) {
          slot.__pendingMessages = null
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
        slot.__haystackServer = server
        // Hand the buffered frames over to the server in arrival order before
        // marking the queue closed; new frames go straight through after this.
        slot.__pendingMessages = null
        for (const buffered of queue) {
          await server.handleMessage(buffered)
        }
        log.debug({ pipelineSlug, pipelineName: descriptor.pipelineName, userId: user.id }, 'haystack ws opened')
      },
      async message(ws, message) {
        const slot = ws.data as unknown as {
          __haystackServer?: HaystackAcpServer
          __pendingMessages?: string[] | null
        }
        const text = typeof message === 'string' ? message : JSON.stringify(message)
        if (slot.__haystackServer) {
          await slot.__haystackServer.handleMessage(text)
          return
        }
        if (slot.__pendingMessages) {
          // `open()` is mid-flight; queue for drain. Order is preserved
          // because the drain runs synchronously to completion before the
          // server is exposed via `__haystackServer`.
          slot.__pendingMessages.push(text)
          return
        }
        // Auth rejected this socket (or it's torn down). The close frame
        // will arrive on its own — drop quietly.
      },
      close(ws) {
        const slot = ws.data as unknown as {
          __haystackServer?: HaystackAcpServer
          __pendingMessages?: string[] | null
        }
        slot.__haystackServer?.dispose()
        slot.__haystackServer = undefined
        slot.__pendingMessages = null
      },
    })
}
