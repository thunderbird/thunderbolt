/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from './auth'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'

/** Audience claim required on every media-proxy JWT. Narrowly scoped so a leaked
 *  media token cannot be replayed against other auth endpoints. */
export const MEDIA_JWT_AUDIENCE = 'media-proxy'

/** Algorithm allowlist for media-proxy JWT verification. Matches the Better
 *  Auth JWT plugin default (EdDSA). Pinned explicitly as defense-in-depth so
 *  a future key-rotation that introduces an additional asymmetric `alg`
 *  (e.g. RS256) cannot silently widen accepted signatures. If the team
 *  switches `jwks.keyPairConfig.alg`, this allowlist must be updated. */
export const MEDIA_JWT_ALGORITHMS = ['EdDSA'] as const

/** Clock skew tolerance for `exp` validation (seconds). Browsers and servers can
 *  drift by a few seconds; jose's default is 0 which makes near-expiry tokens
 *  flap on tab focus. 10s matches the GLM v1 advisory. */
const CLOCK_TOLERANCE_SECONDS = 10

/** In-process JWKS cache. The Better Auth JWT plugin stores keys in the database
 *  and exposes them at `/api/auth/jwks`; we read them once via `auth.api.getJwks()`
 *  and reuse the parsed key set across every verify call. On a `kid` miss (e.g.
 *  after key rotation), we refresh once and retry. */
type JwksCache = {
  keys: JSONWebKeySet
  resolver: ReturnType<typeof createLocalJWKSet>
}

let jwksCache: JwksCache | null = null
/** In-flight promise for concurrent refresh requests — prevents a thundering herd
 *  of `getJwks()` calls when the first request after rotation arrives. */
let jwksRefreshPromise: Promise<JwksCache> | null = null

const refreshJwks = async (auth: Auth): Promise<JwksCache> => {
  // Better Auth's `getJwks` endpoint returns a JSONWebKeySet shape directly.
  const keys = (await auth.api.getJwks()) as JSONWebKeySet
  const resolver = createLocalJWKSet(keys)
  jwksCache = { keys, resolver }
  return jwksCache
}

const getJwks = async (auth: Auth): Promise<JwksCache> => {
  if (jwksCache) return jwksCache
  if (!jwksRefreshPromise) {
    jwksRefreshPromise = refreshJwks(auth).finally(() => {
      jwksRefreshPromise = null
    })
  }
  return jwksRefreshPromise
}

/** Result returned to the proxy resolver. Mirrors the partial shape of a Better
 *  Auth session so observability/rate-limit code can read `user.id` uniformly. */
export type MediaJwtVerification = {
  user: { id: string }
}

/**
 * Verify a media-proxy JWT received in a `?token=` query param. Returns the
 * subject (Better Auth uses `user.id` as `sub` by default) on success, `null`
 * on any failure (signature, audience, expiry, malformed token, JWKS lookup).
 *
 * Verification is stateless — we do NOT consult the session table on every
 * image load. The JWT's signature + audience + expiry are sufficient because
 * the token was minted by the JWT plugin only when the user had a valid session.
 * Token TTL is the revocation window for a leaked JWT; that's the trade-off
 * Variant B accepts to remove the per-image DB hit.
 *
 * On `kid` mismatch (after key rotation), the JWKS cache is refreshed once and
 * verification is retried.
 */
export const verifyMediaJwt = async (token: string, auth: Auth): Promise<MediaJwtVerification | null> => {
  if (!token) return null
  const tryVerify = async (cache: JwksCache) => {
    return jwtVerify(token, cache.resolver, {
      audience: MEDIA_JWT_AUDIENCE,
      algorithms: [...MEDIA_JWT_ALGORITHMS],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    })
  }

  try {
    const cache = await getJwks(auth)
    const { payload } = await tryVerify(cache)
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    return { user: { id: payload.sub } }
  } catch (err) {
    // jose throws JOSEError subclasses; on `kid` miss it's `JWKSNoMatchingKey`.
    // Refresh once and retry — handles the post-rotation case without restarting.
    const code = (err as { code?: string }).code
    if (code !== 'ERR_JWKS_NO_MATCHING_KEY') return null
    try {
      const refreshed = await refreshJwks(auth)
      const { payload } = await tryVerify(refreshed)
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
      return { user: { id: payload.sub } }
    } catch {
      return null
    }
  }
}

/** Test-only escape hatch: drop the cached JWKS so the next call re-fetches.
 *  Production callers MUST NOT depend on this — rotation is handled automatically
 *  via the `kid`-miss path above. */
export const __resetMediaJwtCacheForTests = () => {
  jwksCache = null
  jwksRefreshPromise = null
}
