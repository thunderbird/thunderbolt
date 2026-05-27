/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory. WebSocket is the only supported remote ACP transport.
 *
 * Routing by agent type:
 *   - `managed-acp` (Haystack and other server-managed agents): always native
 *     WebSocket direct to the URL. The endpoint is same-origin on the cloud
 *     backend (e.g. `/v1/haystack/ws`) and authenticates via the session
 *     cookie the browser attaches automatically. Tunnelling it through the
 *     universal proxy is wrong on two counts — the proxy rejects same-origin
 *     and `ws://` targets, and the extra hop would strip the cookie.
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
import type { HttpClient } from '@/lib/http'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled, createProxyWebSocket } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { fetchWsTicket } from '@/lib/ws-ticket'
import type { AgentType } from '@shared/acp-types'
import type { AcpTransport } from '../types'
import { openWebSocketTransport, type WebSocketFactory, type WebSocketLike } from './websocket'

/** Carrier subprotocol the managed-ACP WS handshake offers. Server echoes this back. */
const managedAcpCarrierSubprotocol = 'thunderbolt.v1'

/** Prefix for the single-use ticket subprotocol entry. Server consumes + strips. */
const managedAcpTicketSubprotocolPrefix = 'thunderbolt.ticket.'

export type OpenTransportInputs = {
  url: string
  transport: 'websocket'
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
  /** Authenticated HttpClient used to mint a single-use WebSocket ticket for
   *  managed-ACP (Haystack) connections. Omitted on Tauri Standalone where
   *  there is no cloud backend and managed-ACP isn't reachable anyway. */
  httpClient?: HttpClient
  /** Test seam — production omits and the factory calls `fetchWsTicket`. */
  fetchTicket?: (httpClient: HttpClient) => Promise<string>
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

const nativeWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike

/** Open a transport for the given ACP agent URL. The returned `AcpTransport`
 *  is the bidirectional stream `ClientSideConnection` expects.
 *
 *  Managed-ACP on web: fetches a single-use ticket and constructs the
 *  WebSocket with `['thunderbolt.v1', 'thunderbolt.ticket.<nonce>']` so the
 *  server can authenticate the upgrade without leaking the credential via the
 *  URL or relying on a third-party-context cookie. The ticket fetch is
 *  awaited up front so a failure surfaces as a transport-open rejection (the
 *  SDK then rejects `initialize` with a clear reason). */
export const openTransport = async (inputs: OpenTransportInputs): Promise<AcpTransport> => {
  const webSocketFactory = inputs.webSocketFactory ?? (await resolveWebSocketFactory(inputs))
  return openWebSocketTransport({
    url: inputs.url,
    signal: inputs.signal,
    webSocketFactory,
    backoffMs: inputs.backoffMs,
  })
}

/** Pick the WebSocket constructor for the given inputs. Managed agents skip
 *  the universal proxy unconditionally — see file header. Remote agents fall
 *  through to the standalone-vs-proxied decision. */
const resolveWebSocketFactory = async (inputs: OpenTransportInputs): Promise<WebSocketFactory> => {
  if (inputs.agentType === 'managed-acp') {
    return resolveManagedAcpFactory(inputs)
  }
  const standalone = isStandaloneTransport(inputs.isStandalone, inputs.readProxyEnabled)
  if (standalone) {
    return nativeWebSocketFactory
  }
  const proxyWs = createProxyWebSocket({ cloudUrl: cloudWsUrl(), isStandalone: inputs.isStandalone })
  return (url) => proxyWs(url) as unknown as WebSocketLike
}

/** Build a WebSocket factory for managed-ACP. On web (Connected) we mint a
 *  ticket and pass it as a subprotocol entry; in Standalone Tauri there is no
 *  cloud backend to mint against, so we connect direct (managed-ACP isn't
 *  reachable from Standalone anyway — kept as a graceful no-op for symmetry). */
const resolveManagedAcpFactory = async (inputs: OpenTransportInputs): Promise<WebSocketFactory> => {
  const standalone = isStandaloneTransport(inputs.isStandalone, inputs.readProxyEnabled)
  if (standalone || !inputs.httpClient) {
    return nativeWebSocketFactory
  }
  const fetcher = inputs.fetchTicket ?? defaultFetchTicket
  const ticket = await fetcher(inputs.httpClient)
  const protocols = [managedAcpCarrierSubprotocol, `${managedAcpTicketSubprotocolPrefix}${ticket}`]
  return (url) => new WebSocket(url, protocols) as unknown as WebSocketLike
}

const defaultFetchTicket = (httpClient: HttpClient): Promise<string> => fetchWsTicket('haystack', { httpClient })

// Re-export for callers that build their own transport (e.g. integration tests).
export type { AnyMessage }
export { openWebSocketTransport } from './websocket'
