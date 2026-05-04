/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { extractClientIp } from '@/utils/request'
import { Elysia } from 'elysia'

/** JWT mint endpoint exposed by the Better Auth JWT plugin. The auth plugin is
 *  mounted under `/api/auth/*` so the full URL path is `/v1/api/auth/token`. */
const JWT_MINT_PATH_SUFFIX = '/api/auth/token'

/** Better Auth's session cookie name. The same identifier is used on both the
 *  cookie and Bearer paths — Better Auth signs and verifies the cookie value
 *  against this name. */
const SESSION_COOKIE_NAME = 'better-auth.session_token'

/** Per-session/IP token mints allowed per minute. */
export const JWT_MINT_RATE_LIMIT_MAX = 20
export const JWT_MINT_RATE_LIMIT_WINDOW_MS = 60_000

type Bucket = { count: number; resetAt: number }

type JwtRateLimitDeps = {
  /** Optional clock injection for tests. */
  now?: () => number
  /** Trusted-proxy setting passed through to `extractClientIp` so anonymous
   *  callers are bucketed per-IP rather than into a single global slot. */
  trustedProxy?: '' | 'cloudflare' | 'akamai'
  /** Logger for the IP-unknown edge case. Optional in tests. */
  logger?: { warn: (obj: Record<string, unknown>, msg?: string) => void }
}

/** Parse the Better Auth session cookie value out of a Cookie header. Returns
 *  `null` if the named cookie is absent. We deliberately key on this single
 *  cookie value rather than the whole Cookie blob — sibling cookies (CSRF
 *  tokens, A/B buckets, analytics) can change request-to-request, which would
 *  otherwise mint a fresh bucket on every flip and silently bypass the limit. */
const parseSessionCookie = (cookieHeader: string): string | null => {
  // Cookie: a=1; better-auth.session_token=VALUE; b=2
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name !== SESSION_COOKIE_NAME) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * Build an Elysia middleware that gates the Better Auth `/api/auth/token`
 * endpoint with two protections:
 *
 *  1. **Method gate**: only POST is allowed. Better Auth's plugin exposes the
 *     route as GET upstream, but a token-issuing endpoint reachable via GET is
 *     bookmarkable, prefetchable, and embeddable as `<img src>` (CSRF-burn).
 *     The accompanying `createBetterAuthPlugin` registers a custom POST route
 *     ahead of the catch-all `auth.handler` so the only mint path is POST.
 *  2. **Rate limit**: 20 mints/min keyed by session ID (Bearer or Better Auth
 *     session cookie), or by client IP for anonymous callers. The previous
 *     implementation keyed on the entire Cookie blob — sibling cookies
 *     mutating request-to-request would create fresh buckets and bypass the
 *     limit. The previous anonymous bucket was global ('anonymous') — a single
 *     unauthenticated flood could starve all other anonymous mint attempts.
 *
 * The default of 20/min/session is generous enough that the React Query hook
 * (mints once on mount, refetches every ~8 min) cannot hit it under normal
 * usage, but tight enough to defeat token-vending DoS via a stolen session.
 *
 * Caveat: In-memory state is per-instance. Horizontally-scaled deployments
 * will share the limit only across requests that hit the same node — same
 * trade-off as the existing Better Auth IP rate limit (TODO(THU-113) covers
 * the distributed migration for both).
 */
export const createJwtMintRateLimit = (deps: JwtRateLimitDeps = {}) => {
  const buckets = new Map<string, Bucket>()
  const now = deps.now ?? Date.now
  const trustedProxy = deps.trustedProxy ?? ''
  const logger = deps.logger

  /** Sweep entries whose window has elapsed. O(n) but n is bounded by active
   *  sessions in the past minute — fine for the volumes the JWT plugin sees. */
  const sweep = (currentTime: number) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) {
        buckets.delete(key)
      }
    }
  }

  /** Identifier for the bucket. Order of preference:
   *
   *   1. `Authorization: Bearer <token>` → key `bearer:<token>` (programmatic)
   *   2. `Cookie: better-auth.session_token=<v>` → key `session:<v>` (browser)
   *   3. Anonymous fallback → key `ip:<client-ip>`. Skipped (`null`) when the
   *      IP cannot be resolved (e.g. proxy header missing) — consistent with
   *      `createIpRateLimitMiddleware`, we don't punish unidentifiable traffic
   *      by funnelling it into a shared bucket.
   */
  const resolveKey = (
    request: Request,
    server: { requestIP?: (req: Request) => { address?: string } | null } | null,
  ): string | null => {
    const auth = request.headers.get('authorization')
    if (auth?.startsWith('Bearer ')) return `bearer:${auth.slice(7)}`
    const cookie = request.headers.get('cookie')
    if (cookie) {
      const sessionValue = parseSessionCookie(cookie)
      if (sessionValue) return `session:${sessionValue}`
    }
    // Anonymous: bucket per-IP so a single flooder can't starve other anons.
    const socketIp = server?.requestIP?.(request)?.address ?? 'unknown'
    const clientIp = extractClientIp(request.headers, socketIp, trustedProxy)
    if (clientIp === 'unknown') {
      logger?.warn({ path: new URL(request.url).pathname }, 'jwt-mint rate limit: client IP unknown — skipping bucket')
      return null
    }
    return `ip:${clientIp}`
  }

  return (
    new Elysia({ name: 'jwt-mint-rate-limit' })
      .onBeforeHandle(({ request, server, set }) => {
        // Only gate the JWT-mint path. Every other auth route flows through
        // untouched — this middleware MUST be cheap on the hot path.
        const url = new URL(request.url)
        if (!url.pathname.endsWith(JWT_MINT_PATH_SUFFIX)) return

        // Method gate: GET is rejected unconditionally. The custom POST handler
        // registered alongside this middleware is the only legitimate mint path.
        if (request.method !== 'POST') {
          set.status = 405
          set.headers['Allow'] = 'POST'
          return { error: 'Method not allowed. JWT mint must be POST.' }
        }

        const currentTime = now()
        sweep(currentTime)

        const key = resolveKey(request, server ?? null)
        if (key === null) return // unidentifiable — skip rate limiting (warned above)

        const existing = buckets.get(key)

        if (!existing || existing.resetAt <= currentTime) {
          buckets.set(key, { count: 1, resetAt: currentTime + JWT_MINT_RATE_LIMIT_WINDOW_MS })
          set.headers['RateLimit-Limit'] = String(JWT_MINT_RATE_LIMIT_MAX)
          set.headers['RateLimit-Remaining'] = String(JWT_MINT_RATE_LIMIT_MAX - 1)
          set.headers['RateLimit-Reset'] = String(Math.ceil(JWT_MINT_RATE_LIMIT_WINDOW_MS / 1000))
          return
        }

        if (existing.count >= JWT_MINT_RATE_LIMIT_MAX) {
          const retryAfterSecs = Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000))
          set.status = 429
          set.headers['Retry-After'] = String(retryAfterSecs)
          set.headers['RateLimit-Limit'] = String(JWT_MINT_RATE_LIMIT_MAX)
          set.headers['RateLimit-Remaining'] = '0'
          set.headers['RateLimit-Reset'] = String(retryAfterSecs)
          logger?.warn({ key, currentCount: existing.count, resetAt: existing.resetAt }, 'jwt-mint rate limit exceeded')
          return { error: 'Too many JWT mint requests. Please try again later.' }
        }

        existing.count += 1
        set.headers['RateLimit-Limit'] = String(JWT_MINT_RATE_LIMIT_MAX)
        set.headers['RateLimit-Remaining'] = String(JWT_MINT_RATE_LIMIT_MAX - existing.count)
        set.headers['RateLimit-Reset'] = String(Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000)))
      })
      // `.as('scoped')` propagates the onBeforeHandle to consumers via .use().
      // Without this, the middleware is local-only and Elysia silently no-ops.
      // (Same pattern as `middleware/rate-limit.ts`.)
      .as('scoped')
  )
}
