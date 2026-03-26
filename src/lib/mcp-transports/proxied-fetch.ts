import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Creates a fetch function that proxies MCP requests through the backend
 * to bypass CORS restrictions for web browsers.
 *
 * The original MCP server URL is passed as an X-Mcp-Target-Url header,
 * and the actual request is sent to the backend's /v1/mcp-proxy endpoint.
 */
export const createProxiedFetch =
  (proxyBaseUrl: string): FetchLike =>
  async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('X-Mcp-Target-Url', url.toString())
    return globalThis.fetch(`${proxyBaseUrl}/mcp-proxy`, { ...init, headers })
  }
