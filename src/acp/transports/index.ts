/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory. WebSocket is the only supported remote ACP transport.
 * Connected vs Standalone is layered orthogonally:
 *
 *   - Web (always Connected): proxied WebSocket via `createProxyWebSocket`.
 *   - Tauri + proxy toggle ON  (Connected):  proxied WebSocket.
 *   - Tauri + proxy toggle OFF (Standalone): native `new WebSocket()`.
 *
 * The effective proxy value is read from `computeEffectiveProxyEnabled` so the
 * factory matches the rest of the codebase (one source of truth).
 */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled, createProxyWebSocket } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AcpTransport } from '../types'
import { openWebSocketTransport, type WebSocketFactory, type WebSocketLike } from './websocket'

export type OpenTransportInputs = {
  url: string
  transport: 'websocket'
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

/** Open a transport for the given ACP agent URL. The returned `AcpTransport`
 *  is the bidirectional stream `ClientSideConnection` expects. */
export const openTransport = async (inputs: OpenTransportInputs): Promise<AcpTransport> => {
  const standalone = isStandaloneTransport(inputs.isStandalone, inputs.readProxyEnabled)

  const factory: WebSocketFactory =
    inputs.webSocketFactory ??
    (standalone
      ? (url) => new WebSocket(url) as unknown as WebSocketLike
      : (() => {
          const proxyWs = createProxyWebSocket({ cloudUrl: cloudWsUrl(), isStandalone: inputs.isStandalone })
          return (url) => proxyWs(url) as unknown as WebSocketLike
        })())

  return openWebSocketTransport({
    url: inputs.url,
    signal: inputs.signal,
    webSocketFactory: factory,
    backoffMs: inputs.backoffMs,
  })
}

// Re-export for callers that build their own transport (e.g. integration tests).
export type { AnyMessage }
export { openWebSocketTransport } from './websocket'
