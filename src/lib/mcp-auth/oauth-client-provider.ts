/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { computeEffectiveProxyEnabled } from '@/lib/proxy-fetch'
import { getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

/** Path the OAuth callback route is registered at (`src/app.tsx`). */
const oauthCallbackPath = '/oauth/callback'

/**
 * CIMD master switch. `false` in PR 1: the client-metadata document is not yet
 * hosted, so `clientMetadataUrl` always yields `undefined` and the SDK uses
 * Dynamic Client Registration everywhere. Flip to `true` (one line) once the
 * document is hosted at a stable production HTTPS origin — `clientMetadataUrl`
 * then re-activates its mode-aware `isBackendConnected` predicate.
 */
const cimdEnabled = false

/** Well-known location the AS fetches to read this client's metadata (SEP-991 / CIMD). */
const clientMetadataPath = '/.well-known/oauth-client-metadata'

/**
 * Whether the CIMD client-metadata document is available to advertise as a
 * client_id. Server-independent (depends only on the `cimdEnabled` master switch
 * + backend connectivity), so callers without a server row — e.g. the Add dialog's
 * actionability probe — can consult it. Mirrors `clientMetadataUrl !== undefined`.
 */
export const cimdClientMetadataAvailable = (
  isBackendConnected: () => boolean = () => computeEffectiveProxyEnabled(),
): boolean => cimdEnabled && isBackendConnected()

type CreateProviderArgs = {
  serverId: string
  db: AnyDrizzleDatabase
  /**
   * App origin used to build `redirect_uri`.
   * Defaults to `window.location.origin`; injectable for tests.
   */
  origin?: string
  /**
   * Explicit redirect URI to register and authorize with. The caller computes it
   * per-platform (web callback route, mobile app-link, or desktop loopback
   * `http://localhost:PORT`). Defaults to `${origin}${oauthCallbackPath}` to
   * preserve the web behavior when not provided.
   */
  redirectUri?: string
  /** Predicate for "backend-connected"; defaults to the proxy-mode check. Injectable for tests. */
  isBackendConnected?: () => boolean
}

/**
 * SDK `OAuthClientProvider` for one MCP server, backed by the app's on-device
 * stores. Tokens and the DCR client_id live in `mcp_secrets` (per server, never
 * synced); the in-flight PKCE verifier and CSRF nonce live in localStorage so
 * they survive the full-page web redirect.
 *
 * Registration uses Dynamic Client Registration everywhere in PR 1: CIMD
 * (SEP-991) is disabled because the client-metadata document is not yet hosted.
 * The `isBackendConnected` predicate is kept wired as the follow-up hook to
 * re-enable CIMD once that document is hosted (see `clientMetadataUrl`).
 */
class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: string
  private readonly db: AnyDrizzleDatabase
  private readonly origin: string
  private readonly redirectUri: string | undefined
  private readonly isBackendConnected: () => boolean
  private clientInfo: OAuthClientInformationFull | undefined

  constructor(
    args: Required<Pick<CreateProviderArgs, 'serverId' | 'db'>> & {
      origin: string
      redirectUri?: string
      isBackendConnected: () => boolean
    },
  ) {
    this.serverId = args.serverId
    this.db = args.db
    this.origin = args.origin
    this.redirectUri = args.redirectUri
    this.isBackendConnected = args.isBackendConnected
  }

  get redirectUrl(): string {
    return this.redirectUri ?? `${this.origin}${oauthCallbackPath}`
  }

  /**
   * CIMD (SEP-991) client-metadata document URL. Disabled in PR 1 via
   * `cimdEnabled = false`, so this always yields `undefined` and the SDK uses
   * Dynamic Client Registration everywhere.
   *
   * CIMD must NOT be re-enabled until the client-metadata document is actually
   * hosted at a STABLE PRODUCTION HTTPS origin (never localhost: the AS fetches
   * it server-side, and CIMD requires HTTPS). When that lands, flip `cimdEnabled`
   * to `true` and the mode-aware `isBackendConnected` predicate below re-activates
   * — points at the hosted document only when backend-connected.
   */
  get clientMetadataUrl(): string | undefined {
    if (!cimdClientMetadataAvailable(this.isBackendConnected)) {
      return undefined
    }
    return `${this.origin}${clientMetadataPath}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Thunderbolt',
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.clientInfo) {
      return this.clientInfo
    }
    const cred = await getMcpServerCredentials(this.db, this.serverId)
    if (cred?.type !== 'oauth' || !cred.clientId) {
      return undefined
    }
    return { client_id: cred.clientId }
  }

  /**
   * Persists the DCR-issued client_id into the oauth blob (per-AS binding via
   * `issuer`). Keeps any existing tokens intact; before authorization completes
   * there are usually none, so a placeholder access_token is written and later
   * overwritten by `saveTokens`.
   */
  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = clientInformation
    const existing = await getMcpServerCredentials(this.db, this.serverId)
    const base = existing?.type === 'oauth' ? existing : { type: 'oauth' as const, access_token: '' }
    await setMcpServerCredentials(this.db, this.serverId, {
      ...base,
      clientId: clientInformation.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await getMcpServerCredentials(this.db, this.serverId)
    if (cred?.type !== 'oauth' || !cred.access_token) {
      return undefined
    }
    return {
      access_token: cred.access_token,
      token_type: 'Bearer',
      refresh_token: cred.refresh_token,
      scope: cred.scope,
      ...(cred.expires_at !== undefined && {
        expires_in: Math.max(0, Math.round((cred.expires_at - Date.now()) / 1000)),
      }),
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const existing = await getMcpServerCredentials(this.db, this.serverId)
    const base = existing?.type === 'oauth' ? existing : { type: 'oauth' as const, access_token: '' }
    await setMcpServerCredentials(this.db, this.serverId, {
      ...base,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? base.refresh_token,
      expires_at: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : base.expires_at,
      scope: tokens.scope ?? base.scope,
    })
  }

  async state(): Promise<string> {
    const handshake = getMcpOAuthState()
    if (!handshake.stateNonce) {
      throw new Error('state() called before the OAuth handshake nonce was persisted')
    }
    return handshake.stateNonce
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    setMcpOAuthState({ codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const handshake = getMcpOAuthState()
    if (!handshake.codeVerifier) {
      throw new Error('codeVerifier() called before saveCodeVerifier')
    }
    return handshake.codeVerifier
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    window.location.assign(authorizationUrl.toString())
  }
}

/**
 * Builds the MCP OAuth client provider for a server, threading the on-device db
 * and the mode-aware backend predicate.
 */
export const createMcpOAuthClientProvider = (args: CreateProviderArgs): McpOAuthClientProvider =>
  new McpOAuthClientProvider({
    serverId: args.serverId,
    db: args.db,
    origin: args.origin ?? window.location.origin,
    redirectUri: args.redirectUri,
    isBackendConnected: args.isBackendConnected ?? (() => computeEffectiveProxyEnabled()),
  })

export { McpOAuthClientProvider }
