/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `SSEClientTransport` is marked @deprecated by the SDK in favour of Streamable HTTP, but we
// intentionally retain it: per the MCP SDK migration guidance the client-side SSE transport is the
// only way to reach legacy SSE-only servers, and there is no non-deprecated replacement for them.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createProxyFetch } from './proxy-fetch'

/** Remote transport kind. stdio (local) servers are connected by THU-575, not here. */
export type MCPTransportType = 'http' | 'sse'

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
) => {
  const urlObj = new URL(url)
  const proxyFetch = createProxyFetch({ cloudUrl })
  const options = {
    fetch: (input: string | URL, init?: RequestInit) => proxyFetch(input, init),
    requestInit: { headers },
  }
  return type === 'sse' ? new SSEClientTransport(urlObj, options) : new StreamableHTTPClientTransport(urlObj, options)
}
