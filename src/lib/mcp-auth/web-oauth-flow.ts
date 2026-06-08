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
import { v4 as uuidv4 } from 'uuid'
import { setMcpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createMcpOAuthClientProvider } from './oauth-client-provider'
import { validateMcpOAuthCallback } from './callback-validation'
import { clearMcpOAuthState, getMcpOAuthState, setMcpOAuthState } from './mcp-oauth-state'

/** SDK auth helpers, injectable for tests. */
export type WebOAuthDeps = {
  discoverOAuthProtectedResourceMetadata?: typeof discoverOAuthProtectedResourceMetadata
  discoverAuthorizationServerMetadata?: typeof discoverAuthorizationServerMetadata
  registerClient?: typeof registerClient
  startAuthorization?: typeof startAuthorization
  exchangeAuthorization?: typeof exchangeAuthorization
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
): Promise<{ authorizationServerUrl: string; metadata: AuthorizationServerMetadata }> => {
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

  return { authorizationServerUrl, metadata }
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

/**
 * Begins the web OAuth flow for an MCP server: discovers the AS, registers a
 * client (mode-aware CIMD/DCR via the provider), builds the PKCE authorization
 * URL with a CSRF `state` nonce + RFC 8707 `resource`, persists the in-flight
 * handshake (so it survives the full-page redirect), and finally redirects the
 * browser. Resolves to the authorization URL after triggering the redirect.
 */
export const startMcpOAuthFlow = async (
  { db, serverId, serverUrl, fetchFn, origin, isBackendConnected }: StartArgs,
  deps: WebOAuthDeps = {},
): Promise<void> => {
  const register = deps.registerClient ?? registerClient
  const start = deps.startAuthorization ?? startAuthorization

  const { authorizationServerUrl, metadata } = await discoverServer(serverUrl, fetchFn, deps)

  const provider = createMcpOAuthClientProvider({ serverId, db, origin, isBackendConnected })

  // Mode-aware registration: CIMD when the AS advertises it AND a client metadata
  // URL is set (backend-connected); DCR otherwise. The SDK applies the same
  // precedence in `auth()`; we mirror it here for the surgical flow.
  const useCimd = metadata.client_id_metadata_document_supported === true && !!provider.clientMetadataUrl
  const clientInformation = useCimd
    ? { client_id: provider.clientMetadataUrl! }
    : await (async () => {
        const full = await register(authorizationServerUrl, {
          metadata,
          clientMetadata: provider.clientMetadata,
          fetchFn,
        })
        await provider.saveClientInformation(full)
        return full
      })()

  const stateNonce = uuidv4()
  const resource = resourceUrlFromServerUrl(serverUrl)

  // Persist the handshake (issuer + redirect + client_id + nonce) BEFORE building
  // the authorization URL so the provider's state()/saveCodeVerifier hooks read a
  // consistent record, and it survives the redirect.
  setMcpOAuthState({
    serverId,
    serverUrl,
    stateNonce,
    issuer: metadata.issuer,
    redirectUrl: provider.redirectUrl,
    clientInfo: JSON.stringify(clientInformation),
  })

  const { authorizationUrl, codeVerifier } = await start(authorizationServerUrl, {
    metadata,
    clientInformation,
    redirectUrl: provider.redirectUrl,
    state: stateNonce,
    resource,
  })

  setMcpOAuthState({ codeVerifier })
  await provider.redirectToAuthorization(authorizationUrl)
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
 * the CSRF nonce + RFC 9207 `iss` (assert-and-reject), re-discovers the AS to
 * obtain its token endpoint, exchanges the authorization code (with PKCE
 * verifier + RFC 8707 resource, using the REGISTERED redirect URI — never the
 * server URL), and persists the `oauth` credential blob. On any failure the
 * handshake is already cleared, so a retry requires re-authorization.
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

  const { authorizationServerUrl, metadata } = await discoverServer(handshake.serverUrl ?? '', fetchFn, deps)

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
