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
import { Elysia } from 'elysia'
import { createCodingAgentProvider } from './provider'
import { provisionWorkspaceToken } from './provision'
import { CodingAgentProxy, type UpstreamFactory } from './proxy'

/** Carrier subprotocol echoed back so strict WS clients complete the upgrade. */
const wsCarrierSubprotocol = 'thunderbolt.v1'

/** Auth failed (missing/invalid/anonymous bearer). */
const wsCloseUnauthorized = 4001
/** The developer has not connected GitHub — the UI should prompt `github_connect`. */
const wsCloseGithubNotConnected = 4002
/** Server-side problem: broker/workspace misconfigured or provisioning failed. */
const wsCloseProvisionFailed = 4003

type ProxySlot = { __codingAgentProxy?: CodingAgentProxy }

export type CodingAgentDeps = {
  fetchFn?: typeof fetch
  /** Injectable upstream WS factory (tests); defaults to the global WebSocket. */
  createUpstream?: UpstreamFactory
}

/**
 * Mount the coding-agent managed-acp routes.
 *
 *  - Registers the provider into the discovery registry (idempotent on id).
 *  - Exposes `WS /v1/coding-agent/ws`: authenticate the developer, **provision
 *    their GitHub token via the broker**, then proxy ACP frames to the workspace
 *    shim. Auth + provisioning run in `open()` (Bun may call `beforeHandle` more
 *    than once per upgrade), exactly once per accepted socket.
 *
 * Provisioning is the multi-user crux: the broker mints a user-to-server token
 * for *this* developer (identified by Better-Auth `user.id`) and injects it into
 * their workspace Secret before the session starts, so Cline commits/opens PRs as
 * them. When the broker isn't configured, the proxy still runs (the agent works
 * for read-only / no-push flows); a 409 from the broker closes 4002 so the UI can
 * prompt the developer to connect GitHub first.
 */
export const createCodingAgentRoutes = (settings: Settings, auth: Auth, deps?: CodingAgentDeps) => {
  registerAgentProvider(createCodingAgentProvider())

  const fetchFn = deps?.fetchFn ?? globalThis.fetch

  return new Elysia({ name: 'coding-agent-routes', prefix: '/coding-agent' }).onError(safeErrorHandler).ws('/ws', {
    upgrade({ request, set }) {
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
      }
    },
    async open(ws) {
      const log = createStandaloneLogger(settings)
      const data = ws.data as unknown as { request?: Request }

      const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
      const user: User | null = await authorizeWsBearer(auth, subprotocolHeader)
      if (!user) {
        ws.close(wsCloseUnauthorized, 'unauthorized')
        return
      }

      const upstreamUrl = settings.codingAgentWorkspaceWsUrl.trim()
      if (upstreamUrl.length === 0) {
        ws.close(wsCloseProvisionFailed, 'coding agent not configured')
        return
      }

      // Provision this developer's GH_TOKEN before opening the session, so the
      // workspace can act as them. Skip only when the broker is unconfigured.
      if (settings.codingAgentBrokerUrl.trim().length > 0) {
        const result = await provisionWorkspaceToken(
          {
            brokerUrl: settings.codingAgentBrokerUrl,
            serviceToken: settings.codingAgentServiceToken,
            fetchFn,
          },
          user.id,
        )
        if (result.status === 'not_connected') {
          ws.close(wsCloseGithubNotConnected, 'github not connected')
          return
        }
        if (result.status === 'failed') {
          log.error({ userId: user.id, reason: result.reason }, 'coding-agent provisioning failed')
          ws.close(wsCloseProvisionFailed, 'provisioning failed')
          return
        }
      }

      const proxy = new CodingAgentProxy({
        send: (payload) => ws.send(payload),
        onUpstreamClose: (code, reason) => ws.close(code === 1000 ? 1000 : wsCloseProvisionFailed, reason),
        upstreamUrl,
        createUpstream: deps?.createUpstream,
      })
      ;(ws.data as unknown as ProxySlot).__codingAgentProxy = proxy
      log.debug({ userId: user.id }, 'coding-agent ws opened')
    },
    message(ws, message) {
      const proxy = (ws.data as unknown as ProxySlot).__codingAgentProxy
      if (!proxy) {
        return
      }
      proxy.handleClientMessage(typeof message === 'string' ? message : JSON.stringify(message))
    },
    close(ws) {
      const slot = ws.data as unknown as ProxySlot
      slot.__codingAgentProxy?.dispose()
      slot.__codingAgentProxy = undefined
    },
  })
}
