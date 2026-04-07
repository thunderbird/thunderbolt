import { getSettings, updateSettings, deleteSetting } from '@/dal'
import { getDb } from '@/db/database'

/**
 * MCP OAuth state persisted in sqlite settings across page redirects.
 * Same pattern as integration OAuth (src/lib/oauth-state.ts).
 */
type McpOAuthState = {
  serverId: string | null
  serverUrl: string | null
  codeVerifier: string | null
  redirectUrl: string | null
  clientInfo: string | null
  stateNonce: string | null
}

export const getMcpOAuthState = async (): Promise<McpOAuthState> => {
  const db = getDb()
  const settings = await getSettings(db, {
    mcp_oauth_server_id: String,
    mcp_oauth_server_url: String,
    mcp_oauth_code_verifier: String,
    mcp_oauth_redirect_url: String,
    mcp_oauth_client_info: String,
    mcp_oauth_state_nonce: String,
  })

  return {
    serverId: settings.mcpOauthServerId,
    serverUrl: settings.mcpOauthServerUrl,
    codeVerifier: settings.mcpOauthCodeVerifier,
    redirectUrl: settings.mcpOauthRedirectUrl,
    clientInfo: settings.mcpOauthClientInfo,
    stateNonce: settings.mcpOauthStateNonce,
  }
}

export const setMcpOAuthState = async (state: Partial<McpOAuthState>): Promise<void> => {
  const settings: Record<string, string | null> = {}

  if (state.serverId !== undefined) {
    settings.mcp_oauth_server_id = state.serverId
  }
  if (state.serverUrl !== undefined) {
    settings.mcp_oauth_server_url = state.serverUrl
  }
  if (state.codeVerifier !== undefined) {
    settings.mcp_oauth_code_verifier = state.codeVerifier
  }
  if (state.redirectUrl !== undefined) {
    settings.mcp_oauth_redirect_url = state.redirectUrl
  }
  if (state.clientInfo !== undefined) {
    settings.mcp_oauth_client_info = state.clientInfo
  }
  if (state.stateNonce !== undefined) {
    settings.mcp_oauth_state_nonce = state.stateNonce
  }

  if (Object.keys(settings).length > 0) {
    const db = getDb()
    await updateSettings(db, settings)
  }
}

export const clearMcpOAuthState = async (): Promise<void> => {
  const db = getDb()
  await Promise.all([
    deleteSetting(db, 'mcp_oauth_server_id'),
    deleteSetting(db, 'mcp_oauth_server_url'),
    deleteSetting(db, 'mcp_oauth_code_verifier'),
    deleteSetting(db, 'mcp_oauth_redirect_url'),
    deleteSetting(db, 'mcp_oauth_client_info'),
    deleteSetting(db, 'mcp_oauth_state_nonce'),
  ])
}
