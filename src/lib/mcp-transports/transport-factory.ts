import type { McpServerConfig, McpTransportResult, CredentialStore } from '@/types/mcp'
import { createTauriHttpTransport } from './tauri-http-transport'
import { createTauriSseTransport } from './tauri-sse-transport'
import { TauriStdioTransport } from './tauri-stdio-transport'

/**
 * Creates the appropriate MCP transport based on server configuration.
 *
 * For HTTP and SSE transports:
 * - External URLs use Tauri's native HTTP client (CORS bypass)
 * - Localhost URLs use the Tauri transport as well for consistency
 * - Bearer auth is injected as an Authorization header
 * - OAuth auth is delegated to the authProvider injected by the auth layer
 *
 * For stdio transports:
 * - Spawns a child process via Tauri shell plugin
 * - Bearer/API key credentials are passed as environment variables per MCP spec
 */
export const createTransport = async (
  config: McpServerConfig,
  credentialStore: CredentialStore,
): Promise<McpTransportResult> => {
  const { transport, auth } = config

  if (transport.type === 'http') {
    const url = new URL(transport.url!)
    const requestInit = await buildRequestInit(config.id, auth.authType, credentialStore)
    return { transport: createTauriHttpTransport(url, requestInit ? { requestInit } : undefined) }
  }

  if (transport.type === 'sse') {
    const url = new URL(transport.url!)
    const requestInit = await buildRequestInit(config.id, auth.authType, credentialStore)
    return { transport: createTauriSseTransport(url, requestInit ? { requestInit } : undefined) }
  }

  if (transport.type === 'stdio') {
    const env = await buildStdioEnv(config.id, auth.authType, credentialStore)
    return {
      transport: new TauriStdioTransport({
        command: transport.command!,
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
