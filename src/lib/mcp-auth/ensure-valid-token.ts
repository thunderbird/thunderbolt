/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { refreshAuthorization as sdkRefreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { eq } from 'drizzle-orm'
import { getMcpServerCredentials, setMcpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { mcpServersTable } from '@/db/tables'
import { isTokenFresh } from '@/integrations/oauth-credentials'

/**
 * Thrown when an MCP OAuth token can no longer be refreshed (refresh token
 * revoked, expired, or reuse-detected). The caller surfaces this as a clean
 * re-authorization prompt on the server card.
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

/** True for an OAuth `invalid_grant` error from the SDK (refresh token no longer valid). */
const isInvalidGrant = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const { errorCode, message } = err as { errorCode?: unknown; message?: unknown }
  return errorCode === 'invalid_grant' || (typeof message === 'string' && /invalid_grant/i.test(message))
}

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
 * In-process only (one entry per tab); `mcp_secrets` is local-only, so a
 * cross-tab race at worst writes the same fresh token twice — harmless.
 */
const tokenRefreshInFlight = new Map<string, Promise<string>>()

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
 * canonical MCP server URL) is sent on the refresh request. An `invalid_grant`
 * (revoked/reused refresh token) surfaces as `McpOAuthNeedsReauthError` so the
 * UI can prompt a clean re-authorization. `refreshAuthorization` is injectable
 * for tests.
 */
export const ensureValidMcpOAuthToken = (
  db: AnyDrizzleDatabase,
  serverId: string,
  fetchFn: FetchLike,
  refreshAuthorization: RefreshFn = sdkRefreshAuthorization,
): Promise<string> => {
  const inFlight = tokenRefreshInFlight.get(serverId)
  if (inFlight) {
    return inFlight
  }
  // Evict on settle so the next call re-reads credentials and a failed refresh
  // is retried rather than replaying a poisoned promise.
  const promise = resolveValidMcpOAuthToken(db, serverId, fetchFn, refreshAuthorization).finally(() => {
    if (tokenRefreshInFlight.get(serverId) === promise) {
      tokenRefreshInFlight.delete(serverId)
    }
  })
  tokenRefreshInFlight.set(serverId, promise)
  return promise
}

const resolveValidMcpOAuthToken = async (
  db: AnyDrizzleDatabase,
  serverId: string,
  fetchFn: FetchLike,
  refreshAuthorization: RefreshFn,
): Promise<string> => {
  const cred = await getMcpServerCredentials(db, serverId)
  if (cred?.type !== 'oauth') {
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
  const resource = server?.url ? resourceUrlFromServerUrl(server.url) : undefined

  const tokens = await (async () => {
    try {
      return await refreshAuthorization(issuer, {
        metadata: buildMetadata(issuer, tokenEndpoint),
        clientInformation: { client_id: clientId },
        refreshToken,
        resource,
        fetchFn,
      })
    } catch (err) {
      if (isInvalidGrant(err)) {
        throw new McpOAuthNeedsReauthError(serverId, err)
      }
      throw err
    }
  })()

  await setMcpServerCredentials(db, serverId, {
    ...cred,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? cred.refresh_token,
    expires_at: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope ?? cred.scope,
  })

  return tokens.access_token
}
