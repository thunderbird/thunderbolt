/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { registerAgentProvider } from '@/agents'
import type { Auth } from '@/auth/elysia-plugin'
import { authorizeWsBearer, wsCloseUnauthorized } from '@/auth/ws-bearer-auth'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { User } from '@shared/types/auth'
import { wsCarrierSubprotocol } from '@shared/ws-bearer'
import { Elysia } from 'elysia'
import { resolveOpenclawSandboxForUser, type OpenclawE2bDeps } from './e2b'
import { createOpenclawProvider, parseSandboxRef } from './provider'
import { createSandboxRelay, type SandboxRelay } from './relay'

/**
 * Per-connection state on `ws.data`. `relay` is created once the async `open()`
 * resolves; `pending` buffers frames that arrive during that window so the FE's
 * eager `initialize` isn't dropped (same fix as `haystack/routes.ts`). `request`
 * is Bun's original upgrade request.
 */
type WsSlot = { request?: Request; relay?: SandboxRelay; pending?: string[] }

/**
 * Mount the OpenClaw ACP relay.
 *
 *  - Registers the OpenClaw provider into the agent registry on construction so
 *    its deploy/catalog/status verbs flow through the shared `/v1/agents/*`
 *    endpoints (idempotent — `registerAgentProvider` dedupes on `id`).
 *  - Exposes `WS /v1/openclaw/ws?instance=<ref>` — the managed-acp wire. Unlike
 *    Haystack (which translates ACP↔SSE in-backend), this is a dumb pipe: the
 *    sandbox already speaks ACP, so we just relay frames both ways.
 *
 * Auth mirrors Haystack exactly: the signed bearer rides a `Sec-WebSocket-Protocol`
 * entry and is validated once in `open()`. The `ref` (`e2b:<sandboxId>`) is
 * resolved owner-gated against the sandbox's own metadata — a forged/foreign
 * instance closes the socket without ever dialing the sandbox. `deps` injects a
 * fake E2B client in tests.
 */
export const createOpenclawRoutes = (settings: Settings, auth: Auth, deps: OpenclawE2bDeps = {}) => {
  registerAgentProvider(createOpenclawProvider(deps))

  return new Elysia({ name: 'openclaw-routes', prefix: '/openclaw' }).onError(safeErrorHandler).ws('/ws', {
    upgrade({ request, set }) {
      // Echo the carrier subprotocol (RFC 6455) so strict clients accept the
      // upgrade; the auth-bearing bearer entry is intentionally NOT echoed.
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
      }
    },
    async open(ws) {
      const log = createStandaloneLogger(settings)
      const slot = ws.data as unknown as WsSlot
      // Bun delivers `message` frames without awaiting this async handler, so the
      // FE's first ACP frame can arrive while auth + the live sandbox lookup are
      // still in flight. Buffer anything that lands and drain it once the relay
      // exists (that dropped `initialize` was the whole hang on Haystack).
      slot.pending = []

      const subprotocolHeader = slot.request?.headers.get('sec-websocket-protocol') ?? null
      const user: User | null = await authorizeWsBearer(auth, subprotocolHeader)
      if (!user) {
        ws.close(wsCloseUnauthorized, 'unauthorized')
        return
      }

      const url = new URL(slot.request?.url ?? 'http://localhost/openclaw/ws')
      const ref = url.searchParams.get('instance')
      const sandboxId = ref ? parseSandboxRef(ref) : null
      if (!sandboxId) {
        ws.close(wsCloseUnauthorized, 'missing or invalid instance')
        return
      }

      // Owner-gated: reads the sandbox's own metadata (E2B is the source of truth).
      // A forged or foreign `?instance=` resolves to null → close without dialing.
      const sandbox = await resolveOpenclawSandboxForUser(sandboxId, user.id, settings.e2bApiKey, deps)
      if (!sandbox) {
        log.warn({ sandboxId, userId: user.id }, 'openclaw ws: instance not found or not owned')
        ws.close(wsCloseUnauthorized, 'unknown instance')
        return
      }

      const relay = createSandboxRelay(
        sandbox.wsUrl,
        (payload) => ws.send(payload),
        () => ws.close(),
      )
      slot.relay = relay
      // Drain buffered frames in arrival order; frames arriving mid-drain append
      // to the same queue (see `message`), so ordering is preserved.
      while (slot.pending.length > 0) {
        relay.fromBrowser(slot.pending.shift()!)
      }
      slot.pending = undefined
      log.debug({ sandboxId, userId: user.id }, 'openclaw ws opened')
    },
    message(ws, message) {
      const slot = ws.data as unknown as WsSlot
      const frame = typeof message === 'string' ? message : JSON.stringify(message)
      // Still inside (or draining after) open() — queue to preserve order.
      if (slot.pending) {
        slot.pending.push(frame)
        return
      }
      slot.relay?.fromBrowser(frame)
    },
    close(ws) {
      const slot = ws.data as unknown as WsSlot
      slot.relay?.close()
      slot.relay = undefined
      slot.pending = undefined
    },
  })
}
