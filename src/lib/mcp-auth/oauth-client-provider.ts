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
const thunderboltDomain = import.meta.env.VITE_THUNDERBOLT_DOMAIN ?? 'thunderbolt.io'
const thunderboltClientId = `https://${thunderboltDomain}/.well-known/oauth-client/thunderbolt`

/**
 * OAuth 2.1 client provider for MCP servers.
 *
 * Implements the MCP SDK's `OAuthClientProvider` interface for a single MCP server.
 * Uses the existing loopback OAuth server (Rust command `start_oauth_server`) to capture
 * the authorization code callback.
 *
 * The loopback port must be known before the SDK reads `redirectUrl`, so callers
 * should use `createMcpOAuthProvider()` which starts the server first.
 *
 * The code verifier is held in memory only (never persisted) per security requirements.
 * Tokens are stored encrypted via the `CredentialStore`.
 */
class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: string
  private readonly credentialStore: CredentialStore
  private readonly port: number
  private codeVerifierValue: string | null = null
  private clientInfo: OAuthClientInformationFull | null = null

  constructor(serverId: string, credentialStore: CredentialStore, port: number) {
    this.serverId = serverId
    this.credentialStore = credentialStore
    this.port = port
  }

  get redirectUrl(): string {
    return `http://localhost:${this.port}`
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
    if (this.clientInfo) {
      return this.clientInfo
    }
    // Return static client ID for CIMD-based registration
    return { client_id: thunderboltClientId }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = clientInformation
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await this.credentialStore.load(this.serverId)
    if (!cred || cred.type !== 'oauth') {
      return undefined
    }

    return {
      access_token: cred.accessToken,
      refresh_token: cred.refreshToken,
      token_type: cred.tokenType,
      scope: cred.scope,
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
    await openUrl(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this.codeVerifierValue) {
      throw new Error('codeVerifier called before saveCodeVerifier')
    }
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

/**
 * Starts the loopback OAuth server and creates an `McpOAuthClientProvider`
 * with the actual bound port. This ensures `redirectUrl` is correct
 * when the SDK reads it before calling `redirectToAuthorization`.
 */
const createMcpOAuthProvider = async (
  serverId: string,
  credentialStore: CredentialStore,
): Promise<McpOAuthClientProvider> => {
  const { invoke } = await import('@tauri-apps/api/core')
  const port = await invoke<number>('start_oauth_server')
  return new McpOAuthClientProvider(serverId, credentialStore, port)
}

export { McpOAuthClientProvider, createMcpOAuthProvider }
