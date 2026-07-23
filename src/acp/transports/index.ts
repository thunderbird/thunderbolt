/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory for WebSocket and relay-routed iroh ACP connections.
 *
 * Routing by agent type:
 *   - `managed-acp` (Haystack and other server-managed agents): native
 *     WebSocket direct to the URL with the bearer token attached as a
 *     `Sec-WebSocket-Protocol` entry. The endpoint is hosted on the cloud
 *     backend (e.g. `/v1/haystack/ws`), so whenever an authenticated
 *     `httpClient` is available we offer the bearer regardless of the proxy
 *     toggle — that toggle only governs external-traffic routing, not auth
 *     against the backend itself. Tunnelling through the universal proxy is
 *     wrong on two counts: the proxy rejects same-origin and `ws://` targets,
 *     and the extra hop would strip the credential. The path falls back to a
 *     direct, unauthenticated connect only when no `httpClient` is wired
 *     (true Standalone — no backend reachable).
 *   - `remote-acp` (user-configured external agents): Connected vs Standalone
 *     is layered orthogonally:
 *       - Web (always Connected): proxied WebSocket via `createProxyWebSocket`.
 *       - Tauri + proxy toggle ON  (Connected):  proxied WebSocket.
 *       - Tauri + proxy toggle OFF (Standalone): native `new WebSocket()`.
 *
 * The effective proxy value is read from `computeEffectiveProxyEnabled` so the
 * factory matches the rest of the codebase (one source of truth).
 */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { getAuthToken } from '@/lib/auth-token'
import type { HttpClient } from '@/lib/http'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled, createProxyWebSocket } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AgentType } from '@shared/acp-types'
import { encodeWsBearer, wsBearerSubprotocolPrefix, wsCarrierSubprotocol } from '@shared/ws-bearer'
import { openIrohTransport } from '../iroh/iroh-transport'
import type { AcpTransport } from '../types'
import { openWebSocketTransport, type WebSocketFactory, type WebSocketLike } from './websocket'

export type OpenTransportInputs = {
  url: string
  transport: 'websocket' | 'iroh'
  /** Agent type drives proxy routing — see file header. `built-in` never
   *  reaches the transport, but the union stays full for type-safety. */
  agentType: AgentType
  signal: AbortSignal
  /** Test seam — production omits and the factory builds a default. */
  webSocketFactory?: WebSocketFactory
  /** Overrides for the proxy-effective + standalone determinations. Tests pass
   *  explicit values to avoid touching the platform / localStorage globals. */
  isStandalone?: () => boolean
  readProxyEnabled?: () => string | null
  backoffMs?: (attempt: number) => number
  /** Authenticated cloud backend client. Managed-ACP uses its presence to offer
   *  the bearer subprotocol; iroh uses it for transparent device enrollment. */
  httpClient?: HttpClient
  /** Test seam — production omits and the factory reads `getAuthToken()`. */
  getAuthToken?: () => string | null
}

const cloudWsUrl = (): string => useLocalSettingsStore.getState().cloudUrl

/** Decide if the transport should use the native (Standalone) path or the
 *  cloud-proxy path. Mirrors `computeEffectiveProxyEnabled` exactly — when the
 *  proxy is OFF *and* we're on Tauri, the transport is native. */
export const isStandaloneTransport = (
  isStandalone: () => boolean = isTauri,
  readProxyEnabled: () => string | null = () =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem('proxy_enabled'),
): boolean => {
  const proxyEnabled = computeEffectiveProxyEnabled(isStandalone, readProxyEnabled)
  return isStandalone() && !proxyEnabled
}

/** Open a transport for the given ACP agent URL. The returned `AcpTransport`
 *  is the bidirectional stream `ClientSideConnection` expects.
 *
 *  Managed-ACP (web or Tauri whenever an `httpClient` is wired): constructs
 *  the WebSocket with `['thunderbolt.v1', 'thunderbolt.bearer.<token>']` so the
 *  server authenticates the upgrade via the same signed-bearer path REST uses,
 *  without leaking the credential via the URL or relying on a
 *  third-party-context cookie. The bearer rides a `Sec-WebSocket-Protocol`
 *  entry because browsers can't attach `Authorization` headers to
 *  `new WebSocket()` — and unlike the URL/Referer, the subprotocol header is
 *  not logged by default. */
export const openTransport = async (inputs: OpenTransportInputs): Promise<AcpTransport> => {
  // iroh dials a peer bridge by NodeId/ticket over an n0 relay — no URL, proxy,
  // or bearer routing applies. `inputs.url` carries the NodeId/ticket.
  if (inputs.transport === 'iroh') {
    return openIrohTransport({ target: inputs.url, signal: inputs.signal, httpClient: inputs.httpClient })
  }
  const webSocketFactory = inputs.webSocketFactory ?? resolveWebSocketFactory(inputs)
  return openWebSocketTransport({
    url: inputs.url,
    signal: inputs.signal,
    webSocketFactory,
    backoffMs: inputs.backoffMs,
  })
}

/** Pick the WebSocket constructor for the given inputs. Managed agents skip
 *  the universal proxy unconditionally — see file header. Remote agents fall
 *  through to the standalone-vs-proxied decision.
 *
 *  When the proxied path is selected, `createProxyWebSocket` returns a sync
 *  factory that builds the `Sec-WebSocket-Protocol` list (carrier + bearer +
 *  target) synchronously from the in-memory bearer token. */
const resolveWebSocketFactory = (inputs: OpenTransportInputs): WebSocketFactory => {
  if (inputs.agentType === 'managed-acp') {
    return resolveManagedAcpFactory(inputs)
  }
  if (isStandaloneTransport(inputs.isStandalone, inputs.readProxyEnabled)) {
    return nativeWebSocketFactory
  }
  const proxyWs = createProxyWebSocket({
    cloudUrl: cloudWsUrl(),
    isStandalone: inputs.isStandalone,
    getAuthToken: inputs.getAuthToken,
  })
  return (url) => proxyWs(url) as unknown as WebSocketLike
}

const nativeWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike

/** Build a WebSocket factory for managed-ACP. Whenever an authenticated
 *  `httpClient` is wired we offer the bearer token as a subprotocol entry —
 *  managed-ACP is hosted on the same cloud backend, so the proxy toggle (which
 *  routes external traffic) is orthogonal to auth here. Without `httpClient`
 *  we fall back to a direct connect (true Standalone: no backend reachable,
 *  kept as a graceful no-op). */
const resolveManagedAcpFactory = (inputs: OpenTransportInputs): WebSocketFactory => {
  if (!inputs.httpClient) {
    return nativeWebSocketFactory
  }
  const token = (inputs.getAuthToken ?? getAuthToken)()
  const protocols = token
    ? [wsCarrierSubprotocol, `${wsBearerSubprotocolPrefix}${encodeWsBearer(token)}`]
    : [wsCarrierSubprotocol]
  return (url) => new WebSocket(url, protocols) as unknown as WebSocketLike
}

// Re-export for callers that build their own transport (e.g. integration tests).
export type { AnyMessage }
export { openWebSocketTransport } from './websocket'
