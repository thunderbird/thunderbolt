/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener'
import { v4 as uuidv4 } from 'uuid'
import { setMcpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { isMobile as isMobilePlatform, isTauri as isTauriPlatform } from '@/lib/platform'
import type { McpAuthActionability } from './auth-decision'
import { cimdClientMetadataAvailable, createMcpOAuthClientProvider } from './oauth-client-provider'
import { validateMcpOAuthCallback } from './callback-validation'
import { startMcpOAuthLoopback } from './mcp-oauth-loopback'
import { abandonedFlowMs, clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

/** Verified HTTPS App Link / Universal Link the mobile system browser returns to. */
const mobileRedirectUri = 'https://app.thunderbolt.io/oauth/callback'

/** Web OAuth callback route registered in `src/app.tsx`. */
const webCallbackPath = '/oauth/callback'

/**
 * Guards the pre-handshake desktop loopback window. The handshake-based
 * single-flight guard only covers the period after the handshake is written, but
 * the desktop flow starts the loopback server (and discovers/registers) before
 * that — this prevents a second desktop Authorize from starting a competing
 * loopback server in that window. Mirrors `loopbackActiveRef` in
 * `use-oauth-connect.ts`.
 */
let desktopLoopbackInProgress = false

/** SDK auth helpers, injectable for tests. */
export type WebOAuthDeps = {
  discoverOAuthProtectedResourceMetadata?: typeof discoverOAuthProtectedResourceMetadata
  discoverAuthorizationServerMetadata?: typeof discoverAuthorizationServerMetadata
  registerClient?: typeof registerClient
  startAuthorization?: typeof startAuthorization
  exchangeAuthorization?: typeof exchangeAuthorization
}

/** Platform predicates + browser opener, injectable for tests. */
export type PlatformDeps = {
  isTauri?: typeof isTauriPlatform
  isMobile?: typeof isMobilePlatform
  openUrl?: typeof tauriOpenUrl
  startMcpOAuthLoopback?: typeof startMcpOAuthLoopback
}

/**
 * Computes the OAuth redirect URI for the platforms that authorize via a fixed
 * callback URL: web uses the app-origin callback route, Tauri mobile uses the
 * verified App Link / Universal Link. Desktop never calls this — it authorizes
 * against the loopback `http://localhost:PORT` URI learned at runtime.
 *
 * @param origin - The app origin (e.g. `window.location.origin`).
 * @param platform - Platform predicates, injectable for tests.
 * @returns The redirect URI to register and authorize with.
 */
export const computeMcpOAuthRedirectUri = (
  origin: string,
  platform: { isTauri: typeof isTauriPlatform; isMobile: typeof isMobilePlatform } = {
    isTauri: isTauriPlatform,
    isMobile: isMobilePlatform,
  },
): string => {
  if (platform.isTauri() && platform.isMobile()) {
    return mobileRedirectUri
  }
  return `${origin}${webCallbackPath}`
}

/**
 * Probes whether a remote MCP server is OAuth-eligible: true when RFC 9728
 * Protected Resource Metadata is discoverable (the SDK falls back to
 * `/.well-known/oauth-protected-resource` when no `resource_metadata` header is
 * present). The SDK's `discoverOAuthProtectedResourceMetadata` resolves on a
 * valid document and throws on 404 / no metadata, so a resolved promise is the
 * "this server supports OAuth" signal. Used by the Add dialog to decide whether
 * an empty-credential 401 should offer "Add & Authorize" rather than a generic
 * failure. Discovery failures (no metadata, network) deliberately resolve to
 * `false` — the dialog then shows a plain connection failure.
 */
export const isOAuthServer = async (
  serverUrl: string,
  fetchFn: FetchLike,
  deps: WebOAuthDeps = {},
): Promise<boolean> => {
  const discover = deps.discoverOAuthProtectedResourceMetadata ?? discoverOAuthProtectedResourceMetadata
  try {
    const prm = await discover(serverUrl, undefined, fetchFn)
    return !!prm.authorization_servers?.[0]
  } catch {
    return false
  }
}

/**
 * Discovers the authorization server for an MCP resource server following
 * RFC 9728 (Protected Resource Metadata) → RFC 8414 (AS Metadata), validating
 * the discovered `issuer` matches the URL it was fetched from. Refuses servers
 * that don't advertise PKCE S256 (`code_challenge_methods_supported`).
 */
const discoverServer = async (
  serverUrl: string,
  fetchFn: FetchLike,
  deps: WebOAuthDeps,
): Promise<{ authorizationServerUrl: string; metadata: AuthorizationServerMetadata; scope?: string }> => {
  const discover = deps.discoverOAuthProtectedResourceMetadata ?? discoverOAuthProtectedResourceMetadata
  const discoverAs = deps.discoverAuthorizationServerMetadata ?? discoverAuthorizationServerMetadata

  const prm = await discover(serverUrl, undefined, fetchFn)
  const authorizationServerUrl = prm.authorization_servers?.[0]
  if (!authorizationServerUrl) {
    throw new Error('MCP server did not advertise an authorization server.')
  }

  const metadata = await discoverAs(authorizationServerUrl, { fetchFn })
  if (!metadata) {
    throw new Error('Could not discover authorization server metadata.')
  }
  if (metadata.issuer !== authorizationServerUrl) {
    throw new Error('Authorization server issuer mismatch — discovery rejected.')
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('Authorization server does not support PKCE S256.')
  }

  // RFC 9728: request the scopes the resource advertises (space-delimited). A
  // scope-gated server issues a token authorized for nothing without this — e.g.
  // Metabase gates every MCP tool behind an `agent:*` scope, so an unscoped token
  // makes `tools/list` return empty. `undefined` when none are advertised, which
  // omits the `scope` parameter and preserves behavior for non-gated servers.
  const scope = prm.scopes_supported?.join(' ') || undefined

  return { authorizationServerUrl, metadata, scope }
}

/**
 * Classifies how a remote MCP server can authenticate, for the Add dialog's
 * empty-credential 401 path. PRM presence alone (`isOAuthServer`) is NOT enough:
 * a server can publish RFC 9728 metadata yet have an authorization server that
 * supports neither Dynamic Client Registration (`registration_endpoint`) nor CIMD
 * (e.g. GitHub) — the SDK cannot obtain a client there, so `startMcpOAuthFlow`
 * would throw. Those servers need a static token instead of an Authorize prompt.
 *  - `authorizable`: AS supports a usable registration path (DCR, or CIMD with a
 *    hosted client-metadata document) → offer "Add & Authorize".
 *  - `token-only`: OAuth advertised (PRM) but the AS is unusable for client
 *    registration → the user must supply a PAT / API key.
 *  - `none`: no OAuth discoverable → a plain connection failure.
 */
export const classifyMcpServerAuth = async (
  serverUrl: string,
  fetchFn: FetchLike,
  deps: WebOAuthDeps = {},
  cimdAvailable: boolean = cimdClientMetadataAvailable(),
): Promise<McpAuthActionability> => {
  try {
    const { metadata } = await discoverServer(serverUrl, fetchFn, deps)
    const dcr = !!metadata.registration_endpoint
    const cimd = metadata.client_id_metadata_document_supported === true && cimdAvailable
    return dcr || cimd ? 'authorizable' : 'token-only'
  } catch {
    // The AS could not be discovered/validated (no PRM, no AS, issuer mismatch, or
    // no PKCE S256). If OAuth was at least advertised via PRM the server still
    // wants a token; otherwise it's a plain failure.
    return (await isOAuthServer(serverUrl, fetchFn, deps)) ? 'token-only' : 'none'
  }
}

/**
 * Reads the optional RFC 9207 `authorization_response_iss_parameter_supported`
 * flag. The SDK's AS metadata schema is `passthrough`, so this field is present
 * at runtime when advertised but is not part of the static type.
 */
const issParameterSupported = (metadata: AuthorizationServerMetadata): boolean =>
  (metadata as { authorization_response_iss_parameter_supported?: boolean })
    .authorization_response_iss_parameter_supported === true

type StartArgs = {
  db: AnyDrizzleDatabase
  serverId: string
  serverUrl: string
  fetchFn: FetchLike
  origin?: string
  isBackendConnected?: () => boolean
}

/** Outcome of `startMcpOAuthFlow`: the page either navigates away or the desktop loopback completed inline. */
export type StartMcpOAuthResult = { status: 'redirected' } | { status: 'completed' }

/**
 * Refuses to start while a fresh flow for a *different* server is pending. The
 * handshake lives in one shared slot, so a concurrent Authorize (another card or
 * tab) would clobber an in-flight flow and make both fail with a misleading CSRF
 * error on callback. A stale (abandoned) handshake is allowed to be replaced.
 */
const assertNoConcurrentFlow = (serverId: string): void => {
  const pending = getMcpOAuthState()
  if (
    pending.serverId &&
    pending.serverId !== serverId &&
    pending.startedAt !== null &&
    Date.now() - pending.startedAt < abandonedFlowMs
  ) {
    throw new Error('Another MCP authorization is already in progress — finish or cancel it first.')
  }
}

/**
 * Discovers the AS, registers a client (mode-aware CIMD/DCR), builds the PKCE
 * authorization URL with a CSRF `state` nonce + RFC 8707 `resource`, and persists
 * the in-flight handshake pinned to the redirect URI it was built with. Shared by
 * every platform; only how the resulting URL is opened differs.
 */
const prepareAuthorization = async (
  { db, serverId, serverUrl, fetchFn, origin, isBackendConnected }: StartArgs,
  redirectUri: string,
  deps: WebOAuthDeps,
): Promise<{ authorizationUrl: URL }> => {
  const register = deps.registerClient ?? registerClient
  const start = deps.startAuthorization ?? startAuthorization

  const { authorizationServerUrl, metadata, scope } = await discoverServer(serverUrl, fetchFn, deps)

  const provider = createMcpOAuthClientProvider({ serverId, db, origin, redirectUri, isBackendConnected })

  // Mode-aware registration: CIMD when the AS advertises it AND a client metadata
  // URL is set (backend-connected); DCR otherwise. The SDK applies the same
  // precedence in `auth()`; we mirror it here for the surgical flow.
  const useCimd = metadata.client_id_metadata_document_supported === true && !!provider.clientMetadataUrl
  if (!useCimd && !metadata.registration_endpoint) {
    // No usable client-registration path (no DCR, no CIMD) — e.g. GitHub. OAuth
    // can't obtain a client here, so surface the actionable next step instead of a
    // cryptic registration failure (mirrors `classifyMcpServerAuth`'s token-only case).
    throw new Error('This server requires a personal access token. Add it as the credential to connect.')
  }
  const clientInformation = useCimd
    ? { client_id: provider.clientMetadataUrl! }
    : await (async () => {
        const full = await register(authorizationServerUrl, {
          metadata,
          clientMetadata: provider.clientMetadata,
          scope,
          fetchFn,
        })
        await provider.saveClientInformation(full)
        return full
      })()

  const stateNonce = uuidv4()
  const resource = resourceUrlFromServerUrl(serverUrl)

  // Persist the handshake (issuer + redirect + client_id + nonce + the discovered
  // AS) BEFORE building the authorization URL so the provider's state()/
  // saveCodeVerifier hooks read a consistent record, and it survives the redirect.
  // Pinning authorizationServerUrl + metadata here is what lets the callback skip
  // re-discovery and exchange the code against the AS we actually authorized with.
  setMcpOAuthState({
    serverId,
    serverUrl,
    stateNonce,
    issuer: metadata.issuer,
    redirectUrl: provider.redirectUrl,
    clientInfo: JSON.stringify(clientInformation),
    authorizationServerUrl,
    metadata: JSON.stringify(metadata),
    startedAt: Date.now(),
  })

  const { authorizationUrl, codeVerifier } = await start(authorizationServerUrl, {
    metadata,
    clientInformation,
    redirectUrl: provider.redirectUrl,
    scope,
    state: stateNonce,
    resource,
  })

  setMcpOAuthState({ codeVerifier })
  return { authorizationUrl }
}

/**
 * Begins the OAuth flow for an MCP server, branching per platform:
 *
 * - **Web**: full-page redirect to the AS (`window.location.assign`); the
 *   callback returns to the page's OAuth effect → `{ status: 'redirected' }`.
 * - **Mobile (Tauri)**: opens the system browser to the AS with the verified
 *   App Link redirect URI (never navigates the webview); the deep-link listener
 *   delivers the callback → `{ status: 'redirected' }`.
 * - **Desktop (Tauri)**: runs an in-house loopback flow inline — discovers,
 *   registers against `http://localhost:PORT`, persists the handshake, opens the
 *   browser, awaits the loopback callback, then completes the exchange inline via
 *   `completeMcpOAuthFlow` → `{ status: 'completed' }`.
 */
export const startMcpOAuthFlow = async (
  args: StartArgs,
  deps: WebOAuthDeps = {},
  platform: PlatformDeps = {},
): Promise<StartMcpOAuthResult> => {
  const isTauri = platform.isTauri ?? isTauriPlatform
  const isMobile = platform.isMobile ?? isMobilePlatform
  const openUrl = platform.openUrl ?? tauriOpenUrl
  const runLoopback = platform.startMcpOAuthLoopback ?? startMcpOAuthLoopback

  assertNoConcurrentFlow(args.serverId)

  try {
    if (isTauri() && !isMobile()) {
      return await startDesktopOAuthFlow(args, deps, { openUrl, runLoopback })
    }

    const origin = args.origin ?? window.location.origin
    const redirectUri = computeMcpOAuthRedirectUri(origin, { isTauri, isMobile })
    const { authorizationUrl } = await prepareAuthorization(args, redirectUri, deps)

    if (isTauri() && isMobile()) {
      // Open the system browser, never navigate the webview. The deep-link listener
      // delivers the callback to the page's existing OAuth effect.
      await openUrl(authorizationUrl.toString())
      return { status: 'redirected' }
    }

    // Web: full-page redirect via the provider's redirectToAuthorization.
    createMcpOAuthClientProvider({ ...args, redirectUri }).redirectToAuthorization(authorizationUrl)
    return { status: 'redirected' }
  } catch (error) {
    // `prepareAuthorization` persists the handshake before building the auth URL,
    // so a failure after that point (a throwing `startAuthorization`, a rejected
    // `openUrl`, etc.) would otherwise leave a stale single-flight slot that blocks
    // every other server's authorization for `abandonedFlowMs`. Clear it before
    // surfacing. Success paths never reach here — web/mobile need the handshake for
    // the callback, and desktop's `completeMcpOAuthFlow` already cleared it.
    clearMcpOAuthState()
    throw error
  }
}

/**
 * Desktop inline OAuth: starts the loopback server to learn the `localhost:PORT`
 * redirect URI, prepares the authorization (discovery + DCR + handshake) against
 * it, opens the browser, awaits the loopback callback, then completes the exchange
 * inline. A module-level guard covers the pre-handshake loopback window.
 */
const startDesktopOAuthFlow = async (
  args: StartArgs,
  deps: WebOAuthDeps,
  { openUrl, runLoopback }: { openUrl: typeof tauriOpenUrl; runLoopback: typeof startMcpOAuthLoopback },
): Promise<StartMcpOAuthResult> => {
  const { db, serverId, fetchFn } = args
  if (desktopLoopbackInProgress) {
    throw new Error('Another MCP authorization is already in progress — finish or cancel it first.')
  }
  desktopLoopbackInProgress = true
  try {
    const callback = await runLoopback({
      buildAuthorizationUrl: async (redirectUri) => {
        const { authorizationUrl } = await prepareAuthorization(args, redirectUri, deps)
        return authorizationUrl
      },
      deps: { openUrl },
    })

    if (!callback) {
      // Timed out — the user never finished. Clear the pending handshake so a
      // retry isn't blocked by the single-flight guard.
      clearMcpOAuthState()
      throw new Error('Authorization timed out — please try again.')
    }

    if (callback.error) {
      clearMcpOAuthState()
      throw new Error(callback.error)
    }
    if (!callback.code) {
      clearMcpOAuthState()
      throw new Error('Authorization was cancelled.')
    }

    await completeMcpOAuthFlow(
      { db, serverId, code: callback.code, returnedState: callback.state, returnedIss: callback.iss, fetchFn },
      deps,
    )
    return { status: 'completed' }
  } finally {
    desktopLoopbackInProgress = false
  }
}

type CompleteArgs = {
  db: AnyDrizzleDatabase
  serverId: string
  code: string
  returnedState: string | null | undefined
  returnedIss: string | null | undefined
  fetchFn: FetchLike
}

/**
 * Completes the web OAuth flow on callback: reads the recorded handshake and
 * clears it immediately (single-use; with localStorage the read+clear is
 * atomic, so a concurrent callback can't double-exchange the code), validates
 * the CSRF nonce + RFC 9207 `iss` (assert-and-reject), reuses the authorization
 * server pinned at the start of the flow (never re-derived from the now-untrusted
 * server URL), exchanges the authorization code (with PKCE verifier + RFC 8707
 * resource, using the REGISTERED redirect URI — never the server URL), and
 * persists the `oauth` credential blob. On any failure the handshake is already
 * cleared, so a retry requires re-authorization.
 */
export const completeMcpOAuthFlow = async (
  { db, serverId, code, returnedState, returnedIss, fetchFn }: CompleteArgs,
  deps: WebOAuthDeps = {},
): Promise<void> => {
  const handshake = getMcpOAuthState()
  if (handshake.serverId !== serverId) {
    clearMcpOAuthState()
    throw new Error('OAuth callback did not match the pending authorization.')
  }
  // Clear before the network exchange: the handshake is single-use, so a
  // concurrent callback can't replay the authorization code.
  clearMcpOAuthState()

  // Reuse the AS pinned at start. A malicious resource server can vary its PRM
  // between start and callback, so re-discovering here would let it redirect the
  // code + PKCE verifier exchange to an endpoint it controls. Only fall back to
  // re-discovery for a handshake recorded before pinning existed, and even then
  // reject any issuer drift before touching the token endpoint.
  const { authorizationServerUrl, metadata } =
    handshake.authorizationServerUrl && handshake.metadata
      ? {
          authorizationServerUrl: handshake.authorizationServerUrl,
          metadata: JSON.parse(handshake.metadata) as AuthorizationServerMetadata,
        }
      : await (async () => {
          const discovered = await discoverServer(handshake.serverUrl ?? '', fetchFn, deps)
          if (handshake.issuer && discovered.metadata.issuer !== handshake.issuer) {
            throw new Error('Authorization server changed between start and callback — authorization rejected.')
          }
          return discovered
        })()

  const validation = validateMcpOAuthCallback({
    returnedState,
    returnedIss,
    storedNonce: handshake.stateNonce,
    storedIssuer: handshake.issuer,
    issParameterSupported: issParameterSupported(metadata),
  })
  if (!validation.ok) {
    throw new Error(validation.reason)
  }

  if (!handshake.clientInfo || !handshake.codeVerifier || !handshake.redirectUrl || !handshake.serverUrl) {
    throw new Error('OAuth handshake is incomplete — restart the authorization.')
  }

  const clientInformation = JSON.parse(handshake.clientInfo) as { client_id: string }
  const exchange = deps.exchangeAuthorization ?? exchangeAuthorization

  const tokens = await exchange(authorizationServerUrl, {
    metadata,
    clientInformation,
    authorizationCode: code,
    codeVerifier: handshake.codeVerifier,
    redirectUri: handshake.redirectUrl,
    resource: resourceUrlFromServerUrl(handshake.serverUrl),
    fetchFn,
  })

  await setMcpServerCredentials(db, serverId, {
    type: 'oauth',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    clientId: clientInformation.client_id,
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    scope: tokens.scope,
  })
}
