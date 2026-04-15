import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { isMobile, isTauri } from '@/lib/platform'
import { waitForMcpOAuthCode } from '@/lib/mcp-auth/mcp-oauth-callback'
import { setMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import type { CredentialStore } from '@/types/mcp'

const thunderboltDomain = import.meta.env.VITE_THUNDERBOLT_DOMAIN ?? 'thunderbolt.io'

const mcpOAuthCallbackPath = '/mcp/oauth/callback'
const mobileRedirectUrl = `https://${thunderboltDomain}${mcpOAuthCallbackPath}`
const webRedirectUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}${mcpOAuthCallbackPath}`

type McpOAuthPlatform = 'desktop' | 'mobile' | 'web'

type McpOAuthRedirectConfig = {
  platform: McpOAuthPlatform
  redirectUrl: string
  redirectUris: string[]
  serverId: string
  serverUrl: string
}

/**
 * OAuth 2.1 client provider for MCP servers.
 *
 * Platform-aware redirect and code capture:
 * - Desktop: loopback HTTP server captures redirect
 * - Mobile: deep link captures redirect (via mcp-oauth-callback bridge)
 * - Web: NEVER auto-redirects. Stores the auth URL for user-initiated redirect via "Authorize" button.
 */
class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: string
  private readonly serverUrl: string
  private readonly credentialStore: CredentialStore
  private readonly config: McpOAuthRedirectConfig
  private codeVerifierValue: string | null = null
  private clientInfo: OAuthClientInformationFull | null = null
  private stateNonce: string | null = null

  /** Set by redirectToAuthorization on web — the URL the user needs to visit */
  pendingAuthUrl: string | null = null

  constructor(serverId: string, credentialStore: CredentialStore, config: McpOAuthRedirectConfig) {
    this.serverId = serverId
    this.serverUrl = config.serverUrl
    this.credentialStore = credentialStore
    this.config = config
  }

  get redirectUrl(): string {
    return this.config.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Thunderbolt',
      redirect_uris: this.config.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.clientInfo ?? undefined
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
    // NEVER redirect automatically — store the URL for user-initiated redirect.
    // The "Authorize" button on the server card will call startOAuthRedirect().
    this.pendingAuthUrl = authorizationUrl.toString()
  }

  /**
   * User-initiated OAuth redirect. Called when the user clicks "Authorize".
   * - Web: persists state to settings, then redirects the page (same-tab).
   * - Desktop/Mobile: persists state, then opens system browser.
   */
  async startOAuthRedirect(): Promise<void> {
    if (!this.pendingAuthUrl) {
      throw new Error('No pending OAuth authorization URL')
    }

    // Generate CSRF nonce and append to auth URL
    this.stateNonce = crypto.randomUUID()
    const authUrl = new URL(this.pendingAuthUrl)
    authUrl.searchParams.set('state', this.stateNonce)

    await setMcpOAuthState({
      serverId: this.serverId,
      serverUrl: this.serverUrl,
      codeVerifier: this.codeVerifierValue,
      redirectUrl: this.config.redirectUrl,
      clientInfo: this.clientInfo ? JSON.stringify(this.clientInfo) : null,
      stateNonce: this.stateNonce,
    })

    if (this.config.platform === 'web') {
      window.location.assign(authUrl.toString())
      return
    }

    // Desktop/mobile: open in system browser
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(authUrl.toString())
  }

  /**
   * Waits for the authorization code (desktop/mobile only).
   * Web uses the callback hook instead.
   */
  async waitForAuthCode(): Promise<string> {
    if (this.config.platform === 'mobile') {
      return waitForMcpOAuthCode()
    }
    return this.waitForLoopbackCode()
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

  private waitForLoopbackCode = async (): Promise<string> => {
    const { listen } = await import('@tauri-apps/api/event')

    let resolvePromise: (code: string) => void
    let rejectPromise: (err: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })

    // Await listen() so unlisten is guaranteed available before any event or timeout fires
    const unlisten = await listen<{ url: string }>('oauth-callback', (event) => {
      clearTimeout(timeoutId)
      unlisten()
      const callbackUrl = new URL(event.payload.url)
      const code = callbackUrl.searchParams.get('code')
      const state = callbackUrl.searchParams.get('state')
      const error = callbackUrl.searchParams.get('error')

      if (!this.stateNonce || state !== this.stateNonce) {
        rejectPromise(new Error('OAuth state mismatch — possible CSRF attack'))
      } else if (error) {
        rejectPromise(new Error(callbackUrl.searchParams.get('error_description') || error))
      } else if (code) {
        resolvePromise(code)
      } else {
        rejectPromise(new Error('No authorization code in callback'))
      }
    })

    const timeoutId = setTimeout(
      () => {
        unlisten()
        rejectPromise(new Error('OAuth authorization timed out'))
      },
      5 * 60 * 1000,
    )

    return promise
  }
}

const createMcpOAuthProvider = async (
  serverId: string,
  credentialStore: CredentialStore,
  serverUrl?: string,
): Promise<McpOAuthClientProvider> => {
  const url = serverUrl ?? ''

  if (!isTauri()) {
    return new McpOAuthClientProvider(serverId, credentialStore, {
      platform: 'web',
      redirectUrl: webRedirectUrl,
      redirectUris: [webRedirectUrl],
      serverId,
      serverUrl: url,
    })
  }

  if (isMobile()) {
    return new McpOAuthClientProvider(serverId, credentialStore, {
      platform: 'mobile',
      redirectUrl: mobileRedirectUrl,
      redirectUris: [mobileRedirectUrl],
      serverId,
      serverUrl: url,
    })
  }

  const { invoke } = await import('@tauri-apps/api/core')
  const port = await invoke<number>('start_oauth_server')
  return new McpOAuthClientProvider(serverId, credentialStore, {
    platform: 'desktop',
    redirectUrl: `http://localhost:${port}`,
    redirectUris: ['http://localhost:17421', 'http://localhost:17422', 'http://localhost:17423'],
    serverId,
    serverUrl: url,
  })
}

export { McpOAuthClientProvider, createMcpOAuthProvider }
