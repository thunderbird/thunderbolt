/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import type { Auth } from '@/auth/elysia-plugin'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { Elysia } from 'elysia'
import { HaystackAcpServer, type HaystackAcpDeps } from './acp-server'
import { createHaystackProvider } from './provider'

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
 * Auth: same-origin session cookie via `auth.api.getSession`. The dispatch
 * happens in `open()` rather than `beforeHandle()` because (a) close codes
 * are only meaningful after the upgrade lands, and (b) the FE wants to
 * distinguish 4001 from a generic HTTP 401 (different toasts).
 */
export const createHaystackRoutes = (auth: Auth, settings: Settings, deps?: HaystackAcpDeps) => {
  registerAgentProvider(createHaystackProvider())

  return new Elysia({ name: 'haystack-routes', prefix: '/haystack' })
    .onError(safeErrorHandler)
    .derive(({ request }) => ({ request, sessionUser: null as User | null }))
    .ws('/ws', {
      async beforeHandle({ request, store }) {
        // Resolve the session up-front so `open` can decide whether to close
        // 4001 without re-running getSession inside the ws context. Stash the
        // result on the per-connection `data` via `derive`-side store cast.
        const session = await auth.api.getSession({ headers: request.headers })
        const user = (session?.user as User | undefined) ?? null
        // The cast is the documented escape hatch — Elysia's ws context type
        // doesn't surface custom data, but the per-call object is the same.
        ;(store as unknown as { __haystackUser?: User | null }).__haystackUser = user
      },
      open(ws) {
        const log = createStandaloneLogger(settings)
        const data = ws.data as unknown as { store?: { __haystackUser?: User | null }; request?: Request }
        const user = data.store?.__haystackUser ?? null
        if (!user || user.isAnonymous) {
          ws.close(wsCloseUnauthorized, 'unauthorized')
          return
        }

        const url = new URL(data.request?.url ?? 'http://localhost/haystack/ws')
        const pipelineId = url.searchParams.get('pipeline')
        if (!pipelineId) {
          ws.close(wsCloseUnauthorized, 'missing pipeline parameter')
          return
        }

        const server = new HaystackAcpServer({
          send: (payload) => {
            ws.send(payload)
          },
          pipelineId,
          settings,
          deps,
        })
        ;(ws.data as unknown as { __haystackServer?: HaystackAcpServer }).__haystackServer = server
        log.debug({ pipelineId, userId: user.id }, 'haystack ws opened')
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
