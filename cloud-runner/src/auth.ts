/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WebSocket bearer authentication by backend introspection.
 *
 * The app attaches its signed Better Auth session bearer as a
 * `thunderbolt.bearer.<base64url>` subprotocol entry (see `shared/ws-bearer.ts`)
 * — the exact scheme the backend's own managed-ACP endpoints use. Those tokens
 * are opaque HMAC-signed session handles that only the backend can validate
 * (signature secret + session row). Rather than sharing `BETTER_AUTH_SECRET`
 * and the auth database with this service, the runner forwards the bearer to
 * the backend's session endpoint (`GET /v1/api/auth/get-session`) once per
 * connection and trusts its verdict. Anonymous users are rejected, preserving
 * the invariant enforced by every managed-ACP surface.
 */

import { extractBearerSubprotocol } from '../../shared/ws-bearer.ts'

/** The authenticated principal a WebSocket connection acts as. */
export type AuthenticatedUser = {
  readonly id: string
  readonly email: string | null
}

/** An accepted connection: who it acts as, plus the bearer it presented. The
 *  runner keeps the bearer because every model request this connection causes
 *  is authenticated with it against the backend's inference gateway. */
export type AuthorizedConnection = {
  readonly user: AuthenticatedUser
  readonly bearer: string
}

const bearerHeaderPrefix = 'Bearer '

/** Extract the raw bearer from an HTTP `Authorization` header value. The plain
 *  HTTP surface (`POST /purge`) carries it here rather than on a subprotocol. */
export const extractBearerHeader = (header: string | null): string | null =>
  header?.startsWith(bearerHeaderPrefix) ? header.slice(bearerHeaderPrefix.length).trim() || null : null

type GetSessionResponse = {
  user?: { id?: string; email?: string | null; isAnonymous?: boolean | null } | null
} | null

/** Bound on one introspection round-trip. Without it, a hung backend would
 *  park every new connection in the pre-auth limbo indefinitely. */
const introspectTimeoutMs = 10_000

/**
 * Introspect a raw signed bearer against the backend. Resolves with the user
 * on success, `null` for missing/invalid/expired bearers and anonymous users.
 *
 * @param backendUrl - backend origin, no trailing slash
 * @param bearer - the decoded signed bearer token
 * @param fetchFn - injectable fetch for tests
 */
export const introspectBearer = async (
  backendUrl: string,
  bearer: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthenticatedUser | null> => {
  const response = await fetchFn(`${backendUrl}/v1/api/auth/get-session`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(introspectTimeoutMs),
  })
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as GetSessionResponse
  const user = body?.user
  if (!user?.id || user.isAnonymous) return null
  return { id: user.id, email: user.email ?? null }
}

/**
 * Authorize a WebSocket upgrade from its offered subprotocols. Returns the
 * authenticated regular user and the bearer it presented, or `null` when the
 * bearer is absent, invalid, expired, or belongs to an anonymous session.
 */
export const authorizeConnection = async (
  backendUrl: string,
  subprotocolHeader: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizedConnection | null> => {
  const bearer = extractBearerSubprotocol(subprotocolHeader)
  if (!bearer) return null
  const user = await introspectBearer(backendUrl, bearer, fetchFn)
  return user ? { user, bearer } : null
}
