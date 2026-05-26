/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory. Chooses between WebSocket and HTTP+SSE based on
 * `agent.transport`. Connected vs Standalone is layered orthogonally:
 *
 *   - Web (always Connected): proxied transport always.
 *   - Tauri + proxy toggle ON  (Connected):  proxied transport.
 *   - Tauri + proxy toggle OFF (Standalone): native transport
 *     (real `new WebSocket()` / Rust SSE command).
 *
 * The effective proxy value is read from `computeEffectiveProxyEnabled` so the
 * factory matches the rest of the codebase (one source of truth).
 */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled, createProxyWebSocket, type FetchFn } from '@/lib/proxy-fetch'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { AcpHttpSseRequestFn, AcpTransport } from '../types'
import { openHttpSseTransport } from './http-sse'
import { openWebSocketTransport, type WebSocketFactory, type WebSocketLike } from './websocket'

export type OpenTransportInputs = {
  url: string
  transport: 'websocket' | 'http'
  signal: AbortSignal
  getProxyFetch: () => FetchFn
  /** Test seam — production omits these and the factory builds defaults. */
  webSocketFactory?: WebSocketFactory
  acpHttpSseRequest?: AcpHttpSseRequestFn
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

  if (inputs.transport === 'websocket') {
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

  return openHttpSseTransport({
    url: inputs.url,
    signal: inputs.signal,
    useTauriNative: standalone,
    getProxyFetch: inputs.getProxyFetch,
    acpHttpSseRequest: inputs.acpHttpSseRequest,
  })
}

// Re-export for callers that build their own transport (e.g. integration tests).
export type { AnyMessage }
export { openWebSocketTransport } from './websocket'
export { openHttpSseTransport } from './http-sse'
