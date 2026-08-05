/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `SSEClientTransport` is marked @deprecated by the SDK in favour of Streamable HTTP, but we
// intentionally retain it: per the MCP SDK migration guidance the client-side SSE transport is the
// only way to reach legacy SSE-only servers, and there is no non-deprecated replacement for them.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { HttpClient } from './http'
import { getAuthToken } from './auth-token'
import { createMcpIrohTransport } from './mcp-iroh-transport'
import { computeEffectiveProxyEnabled, createProxyFetch } from './proxy-fetch'

/** Remote transport kind. `iroh` dials a peer-to-peer CLI bridge by NodeId/ticket;
 *  http/sse hit a URL through the universal proxy. stdio (local) servers are
 *  connected by THU-575, not here. */
export type MCPTransportType = 'http' | 'sse' | 'iroh'

/**
 * Reconciles a version mismatch between `@ai-sdk/mcp` and `@modelcontextprotocol/sdk` at our
 * transport seam. After the initialize handshake, `@ai-sdk/mcp`'s `init()` records the negotiated
 * protocol via the *direct assignment* `this.transport.protocolVersion = result.protocolVersion`
 * (see @ai-sdk/mcp dist `init()`). But `@modelcontextprotocol/sdk` (>=1.25) made `protocolVersion`
 * a getter-only accessor on `StreamableHTTPClientTransport` and exposes a `setProtocolVersion()`
 * setter instead — so the direct assignment throws
 * `TypeError: Cannot set property protocolVersion ... which has only a getter`, breaking every
 * remote (http/sse) MCP connect. The SDK's own client uses `transport.setProtocolVersion(...)`.
 *
 * No stable `@ai-sdk/mcp` release fixes the assignment (it persists through 1.0.45; only the
 * AI-SDK-v6 `2.0.0-beta` line drops it, which would force a major upgrade of our v5 AI SDK stack),
 * and the getter-only accessor exists across our whole declared `@modelcontextprotocol/sdk` range —
 * so the proper, minimal fix lives here, where we own the transport. We shadow the getter-only
 * accessor with a settable instance accessor that delegates writes to the SDK's own
 * `setProtocolVersion()`, leaving reads unchanged.
 */
const installProtocolVersionSetter = (transport: Transport): Transport => {
  Object.defineProperty(transport, 'protocolVersion', {
    configurable: true,
    enumerable: false,
    get() {
      return this._protocolVersion
    },
    set(version: string) {
      this.setProtocolVersion?.(version)
    },
  })
  return transport
}

/**
 * Builds the request headers for an MCP connection. Adds a **plain**
 * `Authorization: Bearer <token>` when a credential is present — `createProxyFetch`
 * promotes it to the passthrough header on web and sends it direct on Tauri.
 * Never set the passthrough header here (it would double-prefix). See proxy-fetch.ts.
 */
export const buildMcpHeaders = (token?: string): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * Builds an MCP client transport that routes through the universal proxy fetch.
 * Hosted mode (web) goes through `${cloudUrl}/v1/proxy` with header rewriting;
 * Standalone mode (Tauri) hits the upstream directly. Picks SSE for `sse`,
 * otherwise Streamable HTTP — both accept the identical `{ fetch, requestInit }`
 * shape. Keeps the provider and the settings test-connection on one code path.
 */
export const createMcpTransport = (
  url: string,
  type: MCPTransportType,
  cloudUrl: string,
  headers: Record<string, string>,
  httpClient?: HttpClient,
) => {
  // iroh dials a peer bridge by NodeId/ticket over an encrypted relay — no URL,
  // proxy, or bearer applies (the link is e2e-encrypted and allowlist-gated), so
  // `cloudUrl`/`headers` are unused. `url` carries the NodeId/ticket.
  if (type === 'iroh') {
    return createMcpIrohTransport({ target: url, httpClient })
  }
  const urlObj = new URL(url)
  // Authenticate the proxy hop with the Thunderbolt session bearer (the same getter the
  // app-wide ProxyFetchProvider uses) — without it `/v1/proxy` returns 401. The upstream
  // MCP credential rides separately as `X-Proxy-Passthrough-Authorization` (createProxyFetch
  // promotes the plain `Authorization` we set in buildMcpHeaders). `getProxyEnabled` honours
  // the Tauri standalone toggle; web always proxies (CORS forces it).
  const proxyFetch = createProxyFetch({
    cloudUrl,
    getProxyAuthToken: getAuthToken,
    getProxyEnabled: () => computeEffectiveProxyEnabled(),
  })
  const options = {
    fetch: (input: string | URL, init?: RequestInit) => proxyFetch(input, init),
    requestInit: { headers },
  }
  const transport =
    type === 'sse' ? new SSEClientTransport(urlObj, options) : new StreamableHTTPClientTransport(urlObj, options)
  return installProtocolVersionSetter(transport)
}
