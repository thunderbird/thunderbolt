/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthMetadataSchema, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { createAuthMacro, type Auth } from '@/auth/elysia-plugin'
import { cloudConnectionOAuth, cloudConnections } from '@/db/cloud-agent-schema'
import { createMcpFetch } from '@/hosted-agent/mcp-fetch'
import { validateAndPin, type DnsLookup } from '@/utils/url-validation'
import { cloudConnectionScope, type CloudConnectionConfig } from '@shared/cloud-agent/contracts'
import { decryptScopedJson, encryptScopedJson } from '@shared/cloud-agent/crypto'
import { CloudError } from './errors'
import { requireCloudTrustedDevice } from './device'
import type { CloudAgentService, ConnectionRow } from './service'

export type CloudOAuthNetwork = { fetchFn?: typeof fetch; dnsLookup?: DnsLookup; now?: () => Date }
const pendingSchema = z.object({
  state: z.string(),
  verifier: z.string(),
  redirectUri: z.string().url(),
  issuer: z.string().url(),
  resource: z.string().url(),
  clientId: z.string(),
  metadata: OAuthMetadataSchema,
})
const lifetimeMs = 10 * 60 * 1000

/** Reject redirects before credentials can follow them and pin DNS on every request. */
export const createCloudOAuthFetch = ({ fetchFn = fetch, dnsLookup }: CloudOAuthNetwork = {}): typeof fetch => {
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const outgoing = new Request(input, init)
    const url = new URL(outgoing.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new CloudError(422, 'oauth_url_invalid')
    }
    const [target, headers, tls] = await validateAndPin(url.href, outgoing.headers, dnsLookup)
    const body = outgoing.method === 'GET' || outgoing.method === 'HEAD' ? undefined : await outgoing.arrayBuffer()
    const response = await fetchFn(target, {
      method: outgoing.method,
      body,
      headers,
      tls,
      redirect: 'manual',
      signal: AbortSignal.any([outgoing.signal, AbortSignal.timeout(15_000)]),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new CloudError(422, 'oauth_redirect_refused')
    }
    return response
  }
  return createMcpFetch(Object.assign(request, { preconnect: fetchFn.preconnect }), {
    maxResponseBytes: 256_000,
    closeTimeoutMs: 2000,
  })
}

/** Store only a hash of the bearer-like callback state in routing metadata. */
const stateDigest = async (state: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))).toString('hex')
/** Context changes for every state, even when a user restarts authorization for the same connection. */
const pendingContext = (row: Pick<ConnectionRow, 'userId' | 'id' | 'keyEpoch'>, digest: string) => ({
  ownerId: row.userId,
  scopeId: cloudConnectionScope(row.id),
  keyEpoch: row.keyEpoch,
  recordId: digest,
  purpose: 'connection-oauth-pending',
})
/** Token storage shares the selected connection's key, never the account-wide keyring. */
const configContext = (row: Pick<ConnectionRow, 'userId' | 'id' | 'keyEpoch'>) => ({
  ownerId: row.userId,
  scopeId: cloudConnectionScope(row.id),
  keyEpoch: row.keyEpoch,
  recordId: 'config',
  purpose: 'connection-config',
})
/** Only bearer tokens from the frozen issuer exchange are accepted. */
const tokenAuthentication = (
  tokens: OAuthTokens,
  binding: { issuer: string; tokenEndpoint: string; clientId: string; resource: string },
  now: Date,
): Extract<CloudConnectionConfig['authentication'], { type: 'oauth' }> => {
  if (!tokens.access_token || tokens.token_type.toLowerCase() !== 'bearer') {
    throw new CloudError(422, 'oauth_token_type_unsupported')
  }
  if (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) {
    throw new CloudError(422, 'oauth_token_expired')
  }
  return {
    type: 'oauth',
    accessToken: tokens.access_token,
    ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
    ...(tokens.expires_in !== undefined && {
      expiresAt: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
    }),
    ...binding,
  }
}

/** Independent cloud authorization; refresh ownership is the locked connection row. */
export const createCloudOAuth = (service: CloudAgentService, network: CloudOAuthNetwork = {}) => {
  const { database, settings } = service
  const now = network.now ?? (() => new Date())
  const fetchFn = createCloudOAuthFetch(network)
  const configuredRedirects = () => {
    if (!settings.oauthCallbackUrl || !settings.oauthReturnUrl) {
      throw new CloudError(503, 'cloud_oauth_unavailable')
    }
    for (const address of [settings.oauthCallbackUrl, settings.oauthReturnUrl]) {
      const url = new URL(address)
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      ) {
        throw new CloudError(503, 'cloud_oauth_url_invalid')
      }
    }
    return { callback: settings.oauthCallbackUrl, returnUrl: settings.oauthReturnUrl }
  }
  const start = async (ownerId: string, connectionId: string) => {
    await service.requireCloudAccount(ownerId)
    const redirects = configuredRedirects()
    const row = await service.getConnection(ownerId, connectionId)
    if (!row.enabled) {
      throw new CloudError(409, 'connection_disabled')
    }
    const { key, config } = await service.openConnection(row)
    if (config.kind !== 'mcp') {
      throw new CloudError(422, 'oauth_requires_mcp_connection')
    }
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(config.url, undefined, fetchFn)
    const issuer = resourceMetadata.authorization_servers?.[0]
    const resource = resourceUrlFromServerUrl(config.url)
    if (
      !issuer ||
      !checkResourceAllowed({ requestedResource: resource, configuredResource: resourceMetadata.resource })
    ) {
      throw new CloudError(422, 'oauth_resource_mismatch')
    }
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn })
    if (!metadata || metadata.issuer !== issuer) {
      throw new CloudError(422, 'oauth_issuer_mismatch')
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new CloudError(422, 'oauth_pkce_required')
    }
    if (
      !metadata.registration_endpoint ||
      (metadata.token_endpoint_auth_methods_supported &&
        !metadata.token_endpoint_auth_methods_supported.includes('none'))
    ) {
      throw new CloudError(422, 'oauth_registration_unavailable')
    }
    for (const address of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
      const url = new URL(address)
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new CloudError(422, 'oauth_url_invalid')
      }
      await validateAndPin(url.href, undefined, network.dnsLookup)
    }
    const scope = resourceMetadata.scopes_supported?.join(' ') || undefined
    const registration = await registerClient(issuer, {
      metadata,
      clientMetadata: {
        client_name: 'Thunderbolt Cloud',
        redirect_uris: [redirects.callback],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      scope,
      fetchFn,
    })
    if (registration.token_endpoint_auth_method && registration.token_endpoint_auth_method !== 'none') {
      throw new CloudError(422, 'oauth_registration_unavailable')
    }
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const digest = await stateDigest(state)
    const authorization = await startAuthorization(issuer, {
      metadata,
      clientInformation: { client_id: registration.client_id },
      redirectUrl: redirects.callback,
      scope,
      state,
      resource,
    })
    const pending = {
      state,
      verifier: authorization.codeVerifier,
      redirectUri: redirects.callback,
      issuer,
      resource: resource.href,
      clientId: registration.client_id,
      metadata,
    }
    const payload = await encryptScopedJson(pending, key, pendingContext(row, digest))
    const expiresAt = new Date(now().getTime() + lifetimeMs).toISOString()
    await database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(cloudConnections)
        .where(
          and(
            eq(cloudConnections.id, connectionId),
            eq(cloudConnections.userId, ownerId),
            eq(cloudConnections.enabled, true),
            isNull(cloudConnections.deletedAt),
          ),
        )
        .for('update')
      if (!current || current.version !== row.version || current.keyEpoch !== row.keyEpoch) {
        throw new CloudError(409, 'connection_version_conflict')
      }
      const values = {
        connectionId,
        userId: ownerId,
        stateDigest: digest,
        connectionVersion: row.version,
        keyEpoch: row.keyEpoch,
        payload,
        expiresAt,
        status: 'pending',
        createdAt: now().toISOString(),
      }
      await tx
        .insert(cloudConnectionOAuth)
        .values(values)
        .onConflictDoUpdate({ target: cloudConnectionOAuth.connectionId, set: values })
    })
    return { authorizationUrl: authorization.authorizationUrl.href, expiresAt }
  }
  const complete = async (query: { state: string; code?: string; iss?: string; error?: string }) => {
    const redirects = configuredRedirects()
    if (!/^[A-Za-z0-9_-]{43}$/.test(query.state)) {
      throw new CloudError(400, 'oauth_state_invalid')
    }
    const digest = await stateDigest(query.state)
    const claimed = await database.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(cloudConnectionOAuth)
        .where(eq(cloudConnectionOAuth.stateDigest, digest))
      if (!candidate) {
        throw new CloudError(400, 'oauth_state_invalid')
      }
      const [row] = await tx
        .select()
        .from(cloudConnections)
        .where(
          and(
            eq(cloudConnections.id, candidate.connectionId),
            eq(cloudConnections.userId, candidate.userId),
            eq(cloudConnections.enabled, true),
            isNull(cloudConnections.deletedAt),
          ),
        )
        .for('update')
      const [pending] = await tx
        .select()
        .from(cloudConnectionOAuth)
        .where(eq(cloudConnectionOAuth.stateDigest, digest))
        .for('update')
      if (!pending || pending.status !== 'pending' || Date.parse(pending.expiresAt) <= now().getTime()) {
        throw new CloudError(400, 'oauth_state_invalid')
      }
      if (!row || row.version !== pending.connectionVersion || row.keyEpoch !== pending.keyEpoch) {
        throw new CloudError(409, 'connection_version_conflict')
      }
      await service.requireCloudAccount(row.userId, tx)
      const { key, config } = await service.openConnection(row)
      const saved = pendingSchema.parse(await decryptScopedJson(pending.payload, key, pendingContext(row, digest)))
      if (
        saved.state !== query.state ||
        saved.redirectUri !== redirects.callback ||
        saved.resource !== resourceUrlFromServerUrl(config.url).href ||
        (query.iss !== undefined && query.iss !== saved.issuer) ||
        (saved.metadata.authorization_response_iss_parameter_supported === true && query.iss !== saved.issuer)
      ) {
        throw new CloudError(400, 'oauth_callback_mismatch')
      }
      await tx
        .update(cloudConnectionOAuth)
        .set({ status: 'exchanging' })
        .where(eq(cloudConnectionOAuth.stateDigest, digest))
      return { row, key, config, saved }
    })
    try {
      if (query.error || !query.code) {
        throw new CloudError(400, 'oauth_authorization_denied')
      }
      const tokens = await exchangeAuthorization(claimed.saved.issuer, {
        metadata: claimed.saved.metadata,
        clientInformation: { client_id: claimed.saved.clientId },
        authorizationCode: query.code,
        codeVerifier: claimed.saved.verifier,
        redirectUri: claimed.saved.redirectUri,
        resource: new URL(claimed.saved.resource),
        fetchFn,
      })
      const authentication = tokenAuthentication(
        tokens,
        {
          issuer: claimed.saved.issuer,
          tokenEndpoint: claimed.saved.metadata.token_endpoint,
          clientId: claimed.saved.clientId,
          resource: claimed.saved.resource,
        },
        now(),
      )
      const config = await encryptScopedJson(
        { ...claimed.config, authentication },
        claimed.key,
        configContext(claimed.row),
      )
      await database.transaction(async (tx) => {
        await tx.select().from(cloudConnections).where(eq(cloudConnections.id, claimed.row.id)).for('update')
        const [pending] = await tx
          .select()
          .from(cloudConnectionOAuth)
          .where(eq(cloudConnectionOAuth.stateDigest, digest))
          .for('update')
        if (!pending || pending.status !== 'exchanging') {
          throw new CloudError(409, 'oauth_state_invalid')
        }

        const [saved] = await tx
          .update(cloudConnections)
          .set({
            config,
            version: claimed.row.version + 1,
            credentialVersion: claimed.row.credentialVersion + 1,
            status: 'ready',
            updatedAt: now().toISOString(),
          })
          .where(
            and(
              eq(cloudConnections.id, claimed.row.id),
              eq(cloudConnections.userId, claimed.row.userId),
              eq(cloudConnections.version, claimed.row.version),
              eq(cloudConnections.credentialVersion, claimed.row.credentialVersion),
              eq(cloudConnections.keyEpoch, claimed.row.keyEpoch),
              eq(cloudConnections.enabled, true),
              isNull(cloudConnections.deletedAt),
            ),
          )
          .returning()
        if (!saved) {
          throw new CloudError(409, 'connection_version_conflict')
        }
        await tx
          .update(cloudConnectionOAuth)
          .set({ status: 'complete' })
          .where(eq(cloudConnectionOAuth.stateDigest, digest))
      })
      return { connectionId: claimed.row.id }
    } catch {
      await database.transaction(async (tx) => {
        await tx.select().from(cloudConnections).where(eq(cloudConnections.id, claimed.row.id)).for('update')
        const [pending] = await tx
          .select()
          .from(cloudConnectionOAuth)
          .where(eq(cloudConnectionOAuth.stateDigest, digest))
          .for('update')
        if (!pending) {
          return
        }

        await tx
          .update(cloudConnectionOAuth)
          .set({ status: 'failed' })
          .where(eq(cloudConnectionOAuth.stateDigest, digest))
        await tx
          .update(cloudConnections)
          .set({ status: 'needs-authorization', updatedAt: now().toISOString() })
          .where(
            and(
              eq(cloudConnections.id, claimed.row.id),
              eq(cloudConnections.version, claimed.row.version),
              eq(cloudConnections.credentialVersion, claimed.row.credentialVersion),
            ),
          )
      })
      throw new CloudError(409, 'oauth_authorization_failed')
    }
  }
  const refresh = async (ownerId: string, connectionId: string): Promise<ConnectionRow> => {
    const result = await database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cloudConnections)
        .where(
          and(
            eq(cloudConnections.id, connectionId),
            eq(cloudConnections.userId, ownerId),
            isNull(cloudConnections.deletedAt),
          ),
        )
        .for('update')
      if (!row || !row.enabled) {
        throw new CloudError(409, 'connection_disabled')
      }
      const { key, config } = await service.openConnection(row)
      const auth = config.authentication
      if (auth.type !== 'oauth') {
        return { row }
      }
      if (row.status === 'needs-authorization') {
        return { failure: true as const }
      }
      if (!auth.expiresAt || Date.parse(auth.expiresAt) > now().getTime() + 30_000) {
        return { row }
      }
      try {
        if (!auth.refreshToken) {
          throw new CloudError(409, 'oauth_refresh_unavailable')
        }
        const metadata = {
          issuer: auth.issuer,
          authorization_endpoint: auth.issuer,
          token_endpoint: auth.tokenEndpoint,
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['none'],
        }
        const tokens = await refreshAuthorization(auth.issuer, {
          metadata,
          clientInformation: { client_id: auth.clientId },
          refreshToken: auth.refreshToken,
          resource: new URL(auth.resource),
          fetchFn,
        })
        const authentication = tokenAuthentication(
          tokens,
          { issuer: auth.issuer, tokenEndpoint: auth.tokenEndpoint, clientId: auth.clientId, resource: auth.resource },
          now(),
        )
        const encrypted = await encryptScopedJson({ ...config, authentication }, key, configContext(row))
        const [saved] = await tx
          .update(cloudConnections)
          .set({
            config: encrypted,
            credentialVersion: row.credentialVersion + 1,
            status: 'ready',
            updatedAt: now().toISOString(),
          })
          .where(
            and(
              eq(cloudConnections.id, row.id),
              eq(cloudConnections.version, row.version),
              eq(cloudConnections.credentialVersion, row.credentialVersion),
              eq(cloudConnections.keyEpoch, row.keyEpoch),
              eq(cloudConnections.enabled, true),
              isNull(cloudConnections.deletedAt),
            ),
          )
          .returning()
        if (!saved) {
          throw new CloudError(409, 'connection_version_conflict')
        }
        return { row: saved }
      } catch {
        // Commit the failure state before throwing; retrying a potentially rotated refresh token is unsafe.
        await tx
          .update(cloudConnections)
          .set({ status: 'needs-authorization', updatedAt: now().toISOString() })
          .where(
            and(
              eq(cloudConnections.id, row.id),
              eq(cloudConnections.version, row.version),
              eq(cloudConnections.credentialVersion, row.credentialVersion),
            ),
          )
        return { failure: true as const }
      }
    })
    if ('failure' in result) {
      throw new CloudError(409, 'connection_needs_authorization')
    }
    return result.row
  }
  return { start, complete, refresh }
}

/** Shared by model and MCP callers; a device never participates in cloud token refresh. */
export const refreshCloudConnection = (
  service: CloudAgentService,
  row: ConnectionRow,
  network?: CloudOAuthNetwork,
): Promise<ConnectionRow> => createCloudOAuth(service, network).refresh(row.userId, row.id)

/** The callback is intentionally public; the encrypted single-use state authorizes its exact connection. */
export const createCloudOAuthRoutes = (auth: Auth, service: CloudAgentService, network?: CloudOAuthNetwork) => {
  const oauth = createCloudOAuth(service, network)
  return new Elysia({ name: 'cloud-agent-oauth', prefix: '/cloud-agents' })
    .onError(({ error, set }) => {
      set.status = error instanceof CloudError ? error.status : 502
      return { error: error instanceof CloudError ? error.code : 'oauth_request_failed' }
    })
    .get('/oauth/callback', async ({ request, redirect, set }) => {
      set.headers['Cache-Control'] = 'no-store'
      set.headers['Referrer-Policy'] = 'no-referrer'
      if (!service.settings.oauthReturnUrl) {
        throw new CloudError(503, 'cloud_oauth_unavailable')
      }
      const params = new URL(request.url).searchParams
      if (['code', 'state', 'iss', 'error'].some((key) => params.getAll(key).length > 1)) {
        throw new CloudError(400, 'oauth_callback_invalid')
      }
      const returnUrl = new URL(service.settings.oauthReturnUrl)
      try {
        await oauth.complete({
          state: params.get('state') ?? '',
          code: params.get('code') ?? undefined,
          iss: params.get('iss') ?? undefined,
          error: params.get('error') ?? undefined,
        })
        returnUrl.searchParams.set('cloudOAuth', 'connected')
      } catch {
        returnUrl.searchParams.set('cloudOAuth', 'failed')
      }
      return redirect(returnUrl.href, 303)
    })
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (app) =>
      app.post('/connections/:id/oauth/start', async ({ user, session, request, params }) => {
        if (user.isAnonymous) {
          throw new CloudError(403, 'cloud_account_required')
        }
        await requireCloudTrustedDevice(service.database, user.id, request, session)
        return oauth.start(user.id, params.id)
      }),
    )
}
