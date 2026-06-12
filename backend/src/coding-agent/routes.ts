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
import { provisionWorkspaceToken, type ProvisionOptions, type ProvisionResult } from './provision'
import { CodingAgentProxy, type UpstreamFactory } from './proxy'

/** Carrier subprotocol echoed back so strict WS clients complete the upgrade. */
const wsCarrierSubprotocol = 'thunderbolt.v1'

/** Auth failed (missing/invalid/anonymous bearer). */
const wsCloseUnauthorized = 4001
/** The developer has not connected GitHub — the UI should prompt `github_connect`. */
const wsCloseGithubNotConnected = 4002
/** Provisioning failed (broker/workspace misconfigured, or the broker could not mint a token). */
const wsCloseProvisionFailed = 4003

/** Per-connection state stashed on `ws.data`; Elysia's WS context doesn't surface these. */
type WsData = { request?: Request; proxy?: CodingAgentProxy; clientClosed?: boolean }
const wsData = (ws: { data: unknown }): WsData => ws.data as WsData

/** Minimal WS surface the handlers use — structural, so they're unit-testable with a fake. */
type CodingAgentWs = { data: unknown; send: (payload: string) => void; close: (code?: number, reason?: string) => void }

/** Injected dependencies for the WS handlers (closure-captured by the route, overridable in tests). */
export type CodingAgentOpenCtx = {
  auth: Auth
  settings: Settings
  fetchFn: typeof fetch
  log: ReturnType<typeof createStandaloneLogger>
  /** Injectable upstream WS factory; defaults to the global WebSocket inside the proxy. */
  createUpstream?: UpstreamFactory
  /** Injectable provisioning seam; defaults to the real broker call. */
  provision?: (opts: ProvisionOptions, userId: string) => Promise<ProvisionResult>
}

const safeWsClose = (ws: { close: (code?: number, reason?: string) => void }, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

export type CodingAgentDeps = {
  fetchFn?: typeof fetch
  /** Injectable upstream WS factory (tests); defaults to the global WebSocket. */
  createUpstream?: UpstreamFactory
}

/**
 * WS `open` handler: authenticate the developer, provision their GitHub token via
 * the broker, then construct the proxy to the workspace shim. Pure of Elysia —
 * takes a minimal `ws` + injected `ctx` so every branch is unit-testable without
 * a bound port or a real shim. Auth + provisioning are wrapped so a broker/network
 * failure closes the socket rather than leaking out (Elysia `onError` does not
 * cover WS lifecycle callbacks).
 */
export const handleCodingAgentOpen = async (ws: CodingAgentWs, ctx: CodingAgentOpenCtx): Promise<void> => {
  const { settings, log } = ctx
  const data = wsData(ws)

  const subprotocolHeader = data.request?.headers.get('sec-websocket-protocol') ?? null
  const user: User | null = await authorizeWsBearer(ctx.auth, subprotocolHeader)
  if (!user) {
    safeWsClose(ws, wsCloseUnauthorized, 'unauthorized')
    return
  }

  const upstreamUrl = settings.codingAgentWorkspaceWsUrl.trim()
  if (upstreamUrl.length === 0) {
    log.warn({ userId: user.id }, 'coding-agent: workspace endpoint not configured')
    safeWsClose(ws, wsCloseProvisionFailed, 'coding agent not configured')
    return
  }

  // Provision this developer's GH_TOKEN before opening the session. Returns null
  // when the attempt threw and the socket was already closed.
  const brokerConfigured = settings.codingAgentBrokerUrl.length > 0
  const tryProvision = async (): Promise<ProvisionResult | null> => {
    const provision = ctx.provision ?? provisionWorkspaceToken
    try {
      return await provision(
        {
          brokerUrl: settings.codingAgentBrokerUrl,
          serviceToken: settings.codingAgentServiceToken,
          fetchFn: ctx.fetchFn,
        },
        user.id,
      )
    } catch (err) {
      log.error({ userId: user.id, err }, 'coding-agent provisioning threw')
      safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
      return null
    }
  }

  const result: ProvisionResult | null = brokerConfigured ? await tryProvision() : { status: 'ok' }
  if (result === null) {
    return // already closed in the catch
  }
  switch (result.status) {
    case 'ok':
      if (brokerConfigured) {
        log.info({ userId: user.id }, 'coding-agent provisioned')
      }
      break
    case 'disabled':
      log.warn({ userId: user.id }, 'coding-agent broker provisioning disabled; proceeding read-only')
      break
    case 'not_connected':
      log.warn({ userId: user.id }, 'coding-agent: github not connected')
      safeWsClose(ws, wsCloseGithubNotConnected, 'github not connected')
      return
    case 'failed':
      log.error({ userId: user.id, reason: result.reason }, 'coding-agent provisioning failed')
      safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
      return
    default: {
      const exhaustive: never = result
      log.error({ userId: user.id, result: exhaustive }, 'coding-agent: unknown provision result')
      safeWsClose(ws, wsCloseProvisionFailed, 'provisioning failed')
      return
    }
  }

  // The client may have disconnected during the awaited auth/provision above;
  // `close` would have fired before the proxy existed. Don't open the upstream.
  if (data.clientClosed) {
    log.debug({ userId: user.id }, 'coding-agent: client closed during open; aborting')
    return
  }

  try {
    data.proxy = new CodingAgentProxy({
      send: (payload) => {
        try {
          ws.send(payload)
        } catch {
          // client gone
        }
      },
      onClose: (code, reason) => safeWsClose(ws, code, reason),
      onLog: (event, detail) => log.warn({ userId: user.id, ...detail }, event),
      upstreamUrl,
      createUpstream: ctx.createUpstream,
    })
  } catch (err) {
    log.error({ userId: user.id, err }, 'coding-agent: upstream connect failed')
    safeWsClose(ws, wsCloseProvisionFailed, 'upstream connect failed')
    return
  }
  log.debug({ userId: user.id }, 'coding-agent ws opened')
}

/** WS `message` handler: forward the frame to the proxy (string verbatim, objects JSON-encoded). */
export const handleCodingAgentMessage = (ws: CodingAgentWs, message: string | object): void => {
  const proxy = wsData(ws).proxy
  if (!proxy) {
    return
  }
  proxy.handleClientMessage(typeof message === 'string' ? message : JSON.stringify(message))
}

/** WS `close` handler: mark closed (so a racing open() aborts) and dispose the proxy. */
export const handleCodingAgentClose = (ws: CodingAgentWs): void => {
  const data = wsData(ws)
  data.clientClosed = true
  data.proxy?.dispose()
  data.proxy = undefined
}

/**
 * Mount the coding-agent managed-acp routes.
 *
 *  - Registers the provider into the discovery registry (idempotent on id).
 *  - Exposes `WS /v1/coding-agent/ws`, delegating to the exported handlers above.
 *
 * Provisioning is the multi-user crux: when the broker is configured it mints a
 * user-to-server token for *this* developer (Better-Auth `user.id`) and injects
 * it into their workspace Secret before the session starts, so Cline commits as
 * them. When the broker isn't configured the proxy still runs (read-only / no-push
 * flows); a 409 closes 4002 so the UI can prompt the developer to connect GitHub.
 *
 * IMPORTANT (single-workspace caveat): today all sessions proxy to one shared
 * `CODING_AGENT_WORKSPACE_WS_URL`. Per-user workspace routing does not exist yet,
 * so concurrent users share one workspace (and the last-provisioned GH_TOKEN).
 * This is single-user / PoC-safe only — a startup WARN is emitted when both the
 * workspace and broker are configured.
 */
export const createCodingAgentRoutes = (settings: Settings, auth: Auth, deps?: CodingAgentDeps) => {
  registerAgentProvider(createCodingAgentProvider())

  // One logger for the route's lifetime — do NOT construct per connection.
  const log = createStandaloneLogger(settings)
  const ctx: CodingAgentOpenCtx = {
    auth,
    settings,
    fetchFn: deps?.fetchFn ?? globalThis.fetch,
    log,
    createUpstream: deps?.createUpstream,
  }

  if (settings.codingAgentWorkspaceWsUrl.trim().length > 0 && settings.codingAgentBrokerUrl.length > 0) {
    log.warn(
      'coding-agent: per-user GH_TOKEN is provisioned, but all sessions proxy to a single shared ' +
        'CODING_AGENT_WORKSPACE_WS_URL. Until per-user workspace routing exists, concurrent users share one ' +
        'workspace and the last-provisioned token. Treat as single-user / PoC.',
    )
  }

  return new Elysia({ name: 'coding-agent-routes', prefix: '/coding-agent' }).onError(safeErrorHandler).ws('/ws', {
    upgrade({ request, set }) {
      const subprotocolHeader = request.headers.get('sec-websocket-protocol')
      if (subprotocolHeader?.split(',').some((entry) => entry.trim() === wsCarrierSubprotocol)) {
        set.headers['sec-websocket-protocol'] = wsCarrierSubprotocol
      }
    },
    open(ws) {
      return handleCodingAgentOpen(ws as unknown as CodingAgentWs, ctx)
    },
    message(ws, message) {
      handleCodingAgentMessage(ws as unknown as CodingAgentWs, message as string | object)
    },
    close(ws) {
      handleCodingAgentClose(ws as unknown as CodingAgentWs)
    },
  })
}
