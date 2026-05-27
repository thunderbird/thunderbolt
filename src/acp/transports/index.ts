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
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled, createProxyWebSocket } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AgentType } from '@shared/acp-types'
import type { AcpTransport } from '../types'
import { openWebSocketTransport, type WebSocketFactory, type WebSocketLike } from './websocket'

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
 *  is the bidirectional stream `ClientSideConnection` expects. */
export const openTransport = async (inputs: OpenTransportInputs): Promise<AcpTransport> => {
  return openWebSocketTransport({
    url: inputs.url,
    signal: inputs.signal,
    webSocketFactory: inputs.webSocketFactory ?? resolveWebSocketFactory(inputs),
    backoffMs: inputs.backoffMs,
  })
}

/** Pick the WebSocket constructor for the given inputs. Managed agents skip
 *  the universal proxy unconditionally — see file header. Remote agents fall
 *  through to the standalone-vs-proxied decision. */
const resolveWebSocketFactory = (inputs: OpenTransportInputs): WebSocketFactory => {
  if (inputs.agentType === 'managed-acp') {
    return nativeWebSocketFactory
  }
  const standalone = isStandaloneTransport(inputs.isStandalone, inputs.readProxyEnabled)
  if (standalone) {
    return nativeWebSocketFactory
  }
  const proxyWs = createProxyWebSocket({ cloudUrl: cloudWsUrl(), isStandalone: inputs.isStandalone })
  return (url) => proxyWs(url) as unknown as WebSocketLike
}

// Re-export for callers that build their own transport (e.g. integration tests).
export type { AnyMessage }
export { openWebSocketTransport } from './websocket'
