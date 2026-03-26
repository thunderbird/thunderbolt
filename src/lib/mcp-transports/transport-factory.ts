import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { isTauri } from '@/lib/platform'
import { isLocalMcpServer } from '@/lib/mcp-utils'
import type { McpServerConfig, McpTransportResult, CredentialStore } from '@/types/mcp'

/**
 * Creates the appropriate MCP transport based on server configuration.
 *
 * Platform-aware: uses Tauri native HTTP (CORS bypass) when available,
 * falls back to browser fetch for web. stdio is desktop-only.
 */
export const createTransport = async (
  config: McpServerConfig,
  credentialStore: CredentialStore,
  options?: { cloudUrl?: string },
): Promise<McpTransportResult> => {
  const { transport, auth } = config

  if (transport.type === 'http') {
    const url = new URL(transport.url)
    const requestInit = await buildRequestInit(config.id, auth.authType, credentialStore)
    const opts = requestInit ? { requestInit } : undefined

    if (isTauri()) {
      const { createTauriHttpTransport } = await import('./tauri-http-transport')
      return { transport: createTauriHttpTransport(url, opts) }
    }

    if (options?.cloudUrl && !isLocalMcpServer(transport.url)) {
      const { createProxiedFetch } = await import('./proxied-fetch')
      return {
        transport: new StreamableHTTPClientTransport(url, { ...opts, fetch: createProxiedFetch(options.cloudUrl) }),
      }
    }

    return { transport: new StreamableHTTPClientTransport(url, opts) }
  }

  if (transport.type === 'sse') {
    const url = new URL(transport.url)
    const requestInit = await buildRequestInit(config.id, auth.authType, credentialStore)
    const opts = requestInit ? { requestInit } : undefined

    if (isTauri()) {
      const { createTauriSseTransport } = await import('./tauri-sse-transport')
      return { transport: createTauriSseTransport(url, opts) }
    }

    if (options?.cloudUrl && !isLocalMcpServer(transport.url)) {
      const { createProxiedFetch } = await import('./proxied-fetch')
      return { transport: new SSEClientTransport(url, { ...opts, fetch: createProxiedFetch(options.cloudUrl) }) }
    }

    return { transport: new SSEClientTransport(url, opts) }
  }

  if (transport.type === 'stdio') {
    const { TauriStdioTransport } = await import('./tauri-stdio-transport')
    const env = await buildStdioEnv(config.id, auth.authType, credentialStore)
    return {
      transport: new TauriStdioTransport({
        command: transport.command,
        args: transport.args,
        env,
      }),
    }
  }

  throw new Error(`Unknown MCP transport type: ${(transport as { type: string }).type}`)
}

/**
 * Builds a RequestInit with Authorization header for bearer auth.
 * Returns undefined for 'none' and 'oauth' (OAuth is handled via authProvider).
 */
const buildRequestInit = async (
  serverId: string,
  authType: McpServerConfig['auth']['authType'],
  credentialStore: CredentialStore,
): Promise<RequestInit | undefined> => {
  if (authType !== 'bearer') return undefined

  const credential = await credentialStore.load(serverId)
  if (!credential || credential.type !== 'bearer') return undefined

  return {
    headers: { Authorization: `Bearer ${credential.token}` },
  }
}

/**
 * Builds an env var map for stdio processes. For bearer auth, the token is
 * passed as MCP_BEARER_TOKEN per the MCP spec recommendation to use env vars
 * for stdio credentials rather than CLI args.
 */
const buildStdioEnv = async (
  serverId: string,
  authType: McpServerConfig['auth']['authType'],
  credentialStore: CredentialStore,
): Promise<Record<string, string> | undefined> => {
  if (authType !== 'bearer') return undefined

  const credential = await credentialStore.load(serverId)
  if (!credential || credential.type !== 'bearer') return undefined

  return { MCP_BEARER_TOKEN: credential.token }
}
