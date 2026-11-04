/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import type { Auth } from '@/auth/elysia-plugin'
import { authorizeWsBearer, wsCloseUnauthorized } from '@/auth/ws-bearer-auth'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { overflowsPreConnectQueue, wsCloseCodes } from '@/proxy/ws'
import type { User } from '@shared/types/auth'
import { wsCarrierSubprotocol } from '@shared/ws-bearer'
import { Elysia, t } from 'elysia'
import { HaystackAcpServer, type HaystackAcpDeps } from './acp-server'
import { createHaystackProvider, parsePipelinesEnv } from './provider'

/** Per-socket state. */
type HaystackSocketState = {
  /** Set once the bearer check passes; until then frames wait in `pending`, under the proxy relay's caps. */
  server: HaystackAcpServer | null
  pending: string[]
  pendingBytes: number
  closing: boolean
}

/** Stashed on `ws.data`, the upgrade context, so the key is prefixed to stay clear of its fields. */
type HaystackSocketData = { __haystack?: HaystackSocketState }

const haystackSocketData = (ws: { data: unknown }): HaystackSocketData => ws.data as HaystackSocketData

/** Stop taking frames and drop the ones still waiting for the bearer check. */
const stopAccepting = (state: HaystackSocketState) => {
  state.closing = true
  state.pending = []
  state.pendingBytes = 0
}

const refuse = (
  ws: { close: (code?: number, reason?: string) => void },
  state: HaystackSocketState,
  code: number,
  reason: string,
) => {
  stopAccepting(state)
  ws.close(code, reason)
}

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
        const data = ws.data as unknown as { request?: Request }
        // Attached before the bearer check awaits: Bun can deliver frames together with the
        // upgrade, and `message()` must queue them rather than find no state and drop them.
        const state: HaystackSocketState = { server: null, pending: [], pendingBytes: 0, closing: false }
        haystackSocketData(ws).__haystack = state

        // Validate the bearer exactly once per accepted socket. Doing this in
        // `beforeHandle` instead is unsafe because Bun's adapter can call it
        // more than once per upgrade. The bearer rides a subprotocol entry
        // (browsers can't set `Authorization` on `new WebSocket()`); it is
        // verified via the same Better Auth path REST uses (HMAC + DB lookup).
        const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
        const user: User | null = await authorizeWsBearer(auth, subprotocolHeader)
        if (!user) {
          refuse(ws, state, wsCloseUnauthorized, 'unauthorized')
          return
        }

        const url = new URL(data.request?.url ?? 'http://localhost/haystack/ws')
        const pipelineSlug = url.searchParams.get('pipeline')
        if (!pipelineSlug) {
          refuse(ws, state, wsCloseUnauthorized, 'missing pipeline parameter')
          return
        }

        // Resolve the public slug back to its Deepset identifiers. A missing
        // descriptor here means a stale FE URL or a redeploy that dropped the
        // pipeline — we close instead of opening to keep error surface tight.
        const descriptor = parsePipelinesEnv(settings).find((p) => p.id === pipelineSlug)
        if (!descriptor) {
          refuse(ws, state, wsCloseUnauthorized, 'unknown pipeline')
          return
        }

        // The client closed, or overflowed the queue, while the bearer check ran.
        if (state.closing) {
          return
        }

        const server = new HaystackAcpServer({
          send: (payload) => {
            ws.send(payload)
          },
          pipelineId: descriptor.pipelineId,
          pipelineName: descriptor.pipelineName,
          supportsFiles: descriptor.supportedContent.files,
          settings,
          deps,
        })
        state.server = server
        log.debug({ pipelineSlug, pipelineName: descriptor.pipelineName, userId: user.id }, 'haystack ws opened')
        const queued = state.pending
        state.pending = []
        state.pendingBytes = 0
        // Started in arrival order, before any later frame, which now goes straight to the server.
        await Promise.all(queued.map((text) => server.handleMessage(text)))
      },
      async message(ws, message) {
        const state = haystackSocketData(ws).__haystack
        if (!state || state.closing) {
          return
        }
        const text = typeof message === 'string' ? message : JSON.stringify(message)
        if (state.server) {
          await state.server.handleMessage(text)
          return
        }
        const bytes = Buffer.byteLength(text, 'utf-8')
        if (overflowsPreConnectQueue(state, bytes)) {
          refuse(ws, state, wsCloseCodes.queueOverflow, 'pre-connect queue overflow')
          return
        }
        state.pending.push(text)
        state.pendingBytes += bytes
      },
      close(ws) {
        const state = haystackSocketData(ws).__haystack
        if (!state) {
          return
        }
        stopAccepting(state)
        state.server?.dispose()
      },
    })
}
