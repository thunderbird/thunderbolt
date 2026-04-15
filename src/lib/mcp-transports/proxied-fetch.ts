import { getAuthToken } from '@/lib/auth-token'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Creates a fetch function that proxies MCP requests through the backend
 * to bypass CORS restrictions for web browsers.
 *
 * The original MCP server URL is passed as an X-Mcp-Target-Url header,
 * and the actual request is sent to the backend's /v1/mcp-proxy endpoint.
 *
 * Auth header remapping: the MCP server's Authorization header is moved to
 * Mcp-Authorization so the proxy can authenticate the Thunderbolt user
 * via the standard Authorization header. The backend remaps it back before
 * forwarding to the target MCP server.
 */
export const createProxiedFetch =
  (proxyBaseUrl: string): FetchLike =>
  async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('X-Mcp-Target-Url', url.toString())

    // Move MCP server's auth to a separate header so it doesn't conflict with proxy auth
    const mcpAuth = headers.get('Authorization')
    if (mcpAuth) {
      headers.set('Mcp-Authorization', mcpAuth)
    }

    // Authenticate with the proxy using the Thunderbolt session token
    const token = getAuthToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    } else {
      headers.delete('Authorization')
    }

    return globalThis.fetch(`${proxyBaseUrl}/mcp-proxy`, { ...init, headers })
  }
