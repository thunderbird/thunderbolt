import type { Context } from 'elysia'

/**
 * Build a stable user identifier from request metadata.
 *
 * Uses the User-Agent and client IP to produce a simple, stable identifier
 * that can be used for per-user billing or rate limiting contexts.
 */
export const buildUserIdHash = (ctx: Context, fallback = 'unknown'): string => {
  const userAgent = ctx.headers['user-agent'] || fallback
  const clientIp = ctx.headers['x-forwarded-for'] || ctx.headers['x-real-ip'] || fallback

  return `${userAgent}:${clientIp}`
}
