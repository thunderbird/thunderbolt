/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { refreshAuthorization as sdkRefreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { eq } from 'drizzle-orm'
import {
  getMcpServerCredentialSnapshot,
  updateMcpServerCredentialsIfCurrent,
  type McpServerCredentials,
} from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { mcpServersTable } from '@/db/tables'
import { isTokenFresh } from '@/integrations/oauth-credentials'
import { getIdentitySignal } from '@/lib/identity-lifetime'

/**
 * Thrown when an MCP OAuth token can no longer be refreshed (refresh token
 * revoked, expired, reuse-detected, or its client rejected). The caller surfaces
 * this as a clean re-authorization prompt on the server card.
 */
export class McpOAuthNeedsReauthError extends Error {
  readonly serverId: string

  constructor(serverId: string, cause?: unknown) {
    super(`MCP server ${serverId} requires re-authorization`)
    this.name = 'McpOAuthNeedsReauthError'
    this.serverId = serverId
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/**
 * OAuth error codes after which retrying the same refresh cannot succeed, so the card offers Authorize.
 * Metabase answers a rotated-away refresh token with `invalid_request` ("The token request is invalid."),
 * the same body it sends for a malformed request, so the two cannot be told apart; a new authorization
 * (fresh client and tokens) is the only recovery for either, and the SDK error stays attached as `cause`.
 * Transient `server_error` and `temporarily_unavailable` stay retryable.
 */
const credentialRejectedCodes = new Set(['invalid_grant', 'invalid_request', 'invalid_client', 'unauthorized_client'])

/** Builds the minimal AS metadata the SDK refresh path reads (token endpoint). */
const buildMetadata = (issuer: string, tokenEndpoint: string): AuthorizationServerMetadata => ({
  issuer,
  authorization_endpoint: issuer,
  token_endpoint: tokenEndpoint,
  response_types_supported: ['code'],
})

type RefreshFn = typeof sdkRefreshAuthorization

/**
 * In-flight refreshes keyed by serverId so concurrent callers coalesce onto a
 * single refresh instead of each presenting the same rotating refresh token.
 * Entries belong to one database and identity; the credential compare-and-swap
 * below also rejects results superseded by another authorization.
 */
const tokenRefreshInFlight = new Map<
  string,
  { db: AnyDrizzleDatabase; signal: AbortSignal; promise: Promise<string> }
>()

/**
 * Returns a valid MCP OAuth access token for the server, refreshing proactively
 * when it is near expiry (60s buffer, mirroring `ensureValidOAuthToken`).
 *
 * Concurrent calls for the same server share one in-flight refresh: OAuth 2.1
 * reuse-detection rejects a second presentation of a rotating refresh token with
 * `invalid_grant`, which would otherwise force a needless re-authorization.
 *
 * On refresh the rotated refresh token replaces the stored one and `expires_at`
 * is recomputed from the new `expires_in` (a response without `expires_in` is
 * stored as non-expiring, never as the stale pre-refresh timestamp, which would
 * trigger a refresh on every subsequent connect). The RFC 8707 `resource` (the
 * canonical MCP server URL) is sent on the refresh request. A rejected refresh
 * token or client (`credentialRejectedCodes`) surfaces as `McpOAuthNeedsReauthError`
 * so the UI can prompt a clean re-authorization. `refreshAuthorization` is injectable
 * for tests.
 */
export const ensureValidMcpOAuthToken = (
  db: AnyDrizzleDatabase,
  serverId: string,
  fetchFn: FetchLike,
  refreshAuthorization: RefreshFn = sdkRefreshAuthorization,
): Promise<string> => {
  const signal = getIdentitySignal()
  const inFlight = tokenRefreshInFlight.get(serverId)
  if (inFlight?.signal === signal && inFlight.db === db) {
    return inFlight.promise
  }
  // Evict on settle so the next call re-reads credentials and a failed refresh
  // is retried rather than replaying a poisoned promise.
  const promise = navigator.locks
    .request(`mcp-oauth:${serverId}`, { signal }, () =>
      resolveValidMcpOAuthToken(db, serverId, fetchFn, refreshAuthorization, signal),
    )
    .finally(() => {
      if (tokenRefreshInFlight.get(serverId)?.promise === promise) {
        tokenRefreshInFlight.delete(serverId)
      }
    })
  tokenRefreshInFlight.set(serverId, { db, signal, promise })
  return promise
}

const resolveValidMcpOAuthToken = async (
  db: AnyDrizzleDatabase,
  serverId: string,
  fetchFn: FetchLike,
  refreshAuthorization: RefreshFn,
  signal: AbortSignal,
): Promise<string> => {
  signal.throwIfAborted()
  const snapshot = await getMcpServerCredentialSnapshot(db, serverId)
  signal.throwIfAborted()
  const cred = snapshot?.credentials
  if (!snapshot || cred?.type !== 'oauth') {
    throw new Error(`MCP server ${serverId} has no OAuth credentials`)
  }

  // A token with no expiry never needs proactive refresh; treat it as fresh.
  if (cred.expires_at === undefined || isTokenFresh(cred.expires_at)) {
    return cred.access_token
  }

  const { refresh_token: refreshToken, issuer, tokenEndpoint, clientId } = cred
  if (!refreshToken || !issuer || !tokenEndpoint || !clientId) {
    throw new McpOAuthNeedsReauthError(serverId)
  }

  const server = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, serverId)).get()
  signal.throwIfAborted()
  const resource = server?.url ? resourceUrlFromServerUrl(server.url) : undefined

  const tokens = await (async () => {
    try {
      return await refreshAuthorization(issuer, {
        metadata: buildMetadata(issuer, tokenEndpoint),
        clientInformation: { client_id: clientId },
        refreshToken,
        resource,
        fetchFn: (input, init) => {
          signal.throwIfAborted()
          const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          return fetchFn(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : [])]),
          })
        },
      })
    } catch (err) {
      signal.throwIfAborted()
      if (err instanceof OAuthError && credentialRejectedCodes.has(err.errorCode)) {
        throw new McpOAuthNeedsReauthError(serverId, err)
      }
      throw err
    }
  })()

  const credentials: McpServerCredentials = {
    ...cred,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? cred.refresh_token,
    expires_at: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope ?? cred.scope,
  }
  await updateMcpServerCredentialsIfCurrent(db, serverId, credentials, {
    expectedCredentials: snapshot.serialized,
    expectedUrl: server?.url ?? null,
    signal,
  })

  signal.throwIfAborted()
  return tokens.access_token
}
