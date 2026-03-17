import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { CredentialStore } from '@/types/mcp'

/**
 * Static client ID for Thunderbolt published as a Client ID Metadata Document (CIMD).
 * Authorization servers that support CIMD will fetch this to verify the client.
 */
const THUNDERBOLT_CLIENT_ID = 'https://thunderbolt.io/.well-known/oauth-client/thunderbolt'

/**
 * OAuth 2.1 client provider for MCP servers.
 *
 * Implements the MCP SDK's `OAuthClientProvider` interface for a single MCP server.
 * Uses the existing loopback OAuth server (Rust command `start_oauth_server`) to capture
 * the authorization code callback on localhost:17421-17423.
 *
 * The code verifier is held in memory only (never persisted) per security requirements.
 * Tokens are stored encrypted via the `CredentialStore`.
 */
class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: string
  private readonly credentialStore: CredentialStore
  private codeVerifierValue: string | null = null
  private clientInfo: OAuthClientInformationFull | null = null

  constructor(serverId: string, credentialStore: CredentialStore) {
    this.serverId = serverId
    this.credentialStore = credentialStore
  }

  get redirectUrl(): string {
    return 'http://localhost:17421'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Thunderbolt',
      redirect_uris: ['http://localhost:17421', 'http://localhost:17422', 'http://localhost:17423'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation(): OAuthClientInformation | undefined {
    if (this.clientInfo) return this.clientInfo
    // Return static client ID for CIMD-based registration
    return { client_id: THUNDERBOLT_CLIENT_ID }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = clientInformation
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await this.credentialStore.load(this.serverId)
    if (!cred || cred.type !== 'oauth') return undefined

    return {
      access_token: cred.accessToken,
      refresh_token: cred.refreshToken,
      token_type: cred.tokenType,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.credentialStore.save(this.serverId, {
      type: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      tokenType: tokens.token_type ?? 'bearer',
      scope: tokens.scope,
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await invoke('start_oauth_server')
    await openUrl(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this.codeVerifierValue) throw new Error('codeVerifier called before saveCodeVerifier')
    return this.codeVerifierValue
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (scope === 'tokens' || scope === 'all') {
      await this.credentialStore.delete(this.serverId)
    }
    if (scope === 'client' || scope === 'all') {
      this.clientInfo = null
    }
    if (scope === 'verifier' || scope === 'all') {
      this.codeVerifierValue = null
    }
  }
}

export { McpOAuthClientProvider }
