import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Returns Tauri's native HTTP fetch function, which bypasses CORS restrictions
 * imposed on the webview's built-in fetch.
 */
export const createTauriFetch = (): FetchLike => (url: string | URL, init?: RequestInit) =>
  tauriFetch(url.toString(), init ?? {})

/**
 * Creates a Streamable HTTP MCP transport that uses Tauri's native HTTP client
 * for CORS bypass on external MCP server URLs.
 */
export const createTauriHttpTransport = (
  url: URL,
  options?: StreamableHTTPClientTransportOptions,
): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(url, {
    ...options,
    fetch: createTauriFetch(),
  })
