/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { rateLimits } from '@/db/rate-limit-schema'
import { extractClientIp } from '@/utils/request'
import { Elysia } from 'elysia'
import { type RateLimiterAbstract, RateLimiterDrizzle, RateLimiterRes } from 'rate-limiter-flexible'

/** Context shape when the auth macro has resolved a session. */
type AuthResolvedContext = {
  user?: { id: string } | null
}

type RateLimitTier = 'inference' | 'pro' | 'auth' | 'debug-transcript'
export type UserRateLimitTier = Exclude<RateLimitTier, 'auth'>

type RateLimitTierConfig = {
  max: number
  durationSecs: number
}

export type RateLimitSettings = {
  enabled: boolean
}

export type IpRateLimitSettings = RateLimitSettings & {
  trustedProxy: '' | 'cloudflare' | 'akamai'
}

/** Hardcoded per-tier limits. */
const tierConfigs = {
  inference: { max: 60, durationSecs: 60 },
  pro: { max: 100, durationSecs: 60 },
  auth: { max: 10, durationSecs: 60 },
  'debug-transcript': { max: 10, durationSecs: 60 * 60 },
} satisfies Record<RateLimitTier, RateLimitTierConfig>

/** Create a rate-limiter-flexible instance for a specific tier. */
const createLimiter = (database: typeof DbType, tier: RateLimitTier) => {
  const config = tierConfigs[tier]
  return new RateLimiterDrizzle({
    storeClient: database,
    schema: rateLimits,
    keyPrefix: tier,
    points: config.max,
    duration: config.durationSecs,
    clearExpiredByTimeout: true,
  })
}

/** Set rate limit response headers. */
const setRateLimitHeaders = (
  headers: Record<string, string | string[] | number>,
  limit: number,
  remaining: number,
  resetSecs: number,
) => {
  headers['RateLimit-Limit'] = String(limit)
  headers['RateLimit-Remaining'] = String(remaining)
  headers['RateLimit-Reset'] = String(resetSecs)
}

/** Consume a rate limit point or return a 429 response. */
const consumeOrReject = async (
  limiter: RateLimiterAbstract,
  key: string,
  set: { status?: number | string; headers: Record<string, string | string[] | number> },
) => {
  try {
    const res = await limiter.consume(key)
    setRateLimitHeaders(set.headers, limiter.points, res.remainingPoints, Math.ceil(res.msBeforeNext / 1000))
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      set.status = 429
      set.headers['Retry-After'] = String(Math.ceil(err.msBeforeNext / 1000))
      setRateLimitHeaders(set.headers, limiter.points, 0, Math.ceil(err.msBeforeNext / 1000))
      return { error: 'Too many requests. Please try again later.' }
    }
    throw err
  }
}

/**
 * Build a user-based rate limit middleware for authenticated routes.
 * Reads the `user` already resolved by the auth macro to avoid a
 * redundant getSession() call; skips rate limiting when the user
 * context is unavailable.
 *
 * Must be .use()'d INSIDE a guard({ auth: true }) so the macro's
 * resolve populates `ctx.user` before this onBeforeHandle fires.
 * Registering at the app level (outside the guard) causes the
 * macro resolve to run after onBeforeHandle, making rate limiting
 * a silent no-op.
 */
const createUserRateLimitMiddleware = (limiter: RateLimiterDrizzle) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { set } = ctx
      const user = (ctx as AuthResolvedContext).user
      if (!user?.id) {
        return
      }
      return consumeOrReject(limiter, `user:${user.id}`, set)
    })
    .as('scoped')

/** Create user-keyed middleware for one configured rate-limit tier. */
export const createUserTierRateLimit = (
  database: typeof DbType,
  settings: RateLimitSettings,
  tier: UserRateLimitTier,
) => {
  if (!settings.enabled) {
    return new Elysia()
  }
  return createUserRateLimitMiddleware(createLimiter(database, tier))
}

/**
 * Build an IP-based rate limit middleware for unauthenticated routes.
 * Uses `extractClientIp` to resolve the real client IP behind a trusted proxy,
 * falling back to the Bun socket IP when no proxy is configured.
 *
 * Fails CLOSED when the client IP cannot be resolved: unidentifiable traffic
 * shares a single `ip:unknown` bucket rather than skipping the limit, so this
 * control guarding abuse-prone unauthenticated endpoints (OTP send, waitlist
 * join) can never silently disable itself. Identifiable clients are unaffected —
 * each keeps its own `ip:<addr>` bucket, so real traffic is never funnelled into
 * the shared one. In practice 'unknown' never occurs under TCP-listening Bun
 * (`server.requestIP()` always returns the peer address); it would only arise on
 * a non-TCP transport (e.g. a Unix-domain socket), where collectively capping
 * unattributable traffic is the safe default.
 */
const createIpRateLimitMiddleware = (limiter: RateLimiterDrizzle, trustedProxy: IpRateLimitSettings['trustedProxy']) =>
  new Elysia()
    .onBeforeHandle(async (ctx) => {
      const { set } = ctx
      // `|| 'unknown'` (not `??`): a degenerate empty-string address folds into the
      // same shared fail-closed bucket as a missing one, never a stray `ip:` key.
      const socketIp = ctx.server?.requestIP(ctx.request)?.address || 'unknown'
      const clientIp = extractClientIp(ctx.request.headers, socketIp, trustedProxy)
      return consumeOrReject(limiter, `ip:${clientIp}`, set)
    })
    .as('scoped')

/** Create IP-based rate limit middleware for auth and unauthenticated routes. */
export const createAuthIpRateLimit = (database: typeof DbType, settings: IpRateLimitSettings) => {
  if (!settings.enabled) {
    return new Elysia()
  }
  const limiter = createLimiter(database, 'auth')
  return createIpRateLimitMiddleware(limiter, settings.trustedProxy)
}
