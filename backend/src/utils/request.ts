/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isIP } from 'node:net'

export type TrustedProxy = '' | 'cloudflare' | 'akamai' | number

const trustedClientIpHeader = 'x-thunderbolt-client-ip'

/**
 * Default denylist for request headers that should not be forwarded in proxy scenarios.
 * These headers are either hop-by-hop or would cause issues when forwarding.
 */
export const defaultRequestDenylist = [
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  /^proxy-/i,
  /^x-forwarded-/i,
  'x-real-ip',
  'content-length',
  'authorization',
  'cookie',
]

/**
 * Default denylist for response headers that should not be forwarded.
 * These headers can cause issues when proxying responses back to clients.
 */
export const defaultResponseDenylist = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'content-encoding',
  'transfer-encoding',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
]

/**
 * Extract client IP address from request headers.
 *
 * Proxy headers are only trusted when `trustedProxy` is set, because without
 * a proxy in front, any client can forge these headers to bypass rate limiting.
 *
 * When `trustedProxy` is set:
 * - `cloudflare`: trusts `CF-Connecting-IP`, falls back to socket IP
 * - `akamai`: trusts `True-Client-IP`, falls back to socket IP
 * - a positive number: selects that many trusted hops from the right of XFF
 *
 * Hop-count mode requires a fixed proxy chain and an origin inaccessible directly
 * to clients. Never skip malformed/empty hops: doing so could select attacker input.
 *
 * If the authoritative CDN header is absent, the request likely bypassed
 * the CDN, so proxy headers (XFF, X-Real-IP) are untrusted — only the
 * socket IP (passed as `fallback`) is used.
 *
 * When `trustedProxy` is empty (no proxy), only the socket IP is used.
 */
export const extractClientIp = (headers: Headers, fallback = 'unknown', trustedProxy: TrustedProxy = ''): string => {
  if (typeof trustedProxy === 'number') {
    const address = headers.get('x-forwarded-for')?.split(',').at(-trustedProxy)?.trim()
    if (!address || address.includes('%') || !isIP(address)) {
      return fallback
    }
    // Canonicalize IPv6 spellings so one address cannot create multiple buckets.
    return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address
  }

  if (!trustedProxy) {
    return fallback
  }

  if (trustedProxy === 'cloudflare') {
    return headers.get('cf-connecting-ip') ?? fallback
  }

  if (trustedProxy === 'akamai') {
    return headers.get('true-client-ip') ?? fallback
  }

  return fallback
}

/**
 * Return the trusted IP header names for a given proxy configuration.
 * Used by Better Auth's `advanced.ipAddress.ipAddressHeaders` so its
 * built-in rate limiter uses the same client as `extractClientIp`. Hop-count
 * mode reads the internal header overwritten by `withTrustedClientIp`.
 *
 * Returns `undefined` when no proxy is configured so Better Auth falls
 * back to its default (`x-forwarded-for`). Returning `[]` would cause
 * Better Auth to skip all headers and return `null` for the IP, which
 * puts unidentifiable requests into a shared bucket.
 */
export const getTrustedIpHeaders = (trustedProxy: TrustedProxy): string[] | undefined => {
  if (typeof trustedProxy === 'number') {
    return [trustedClientIpHeader]
  }
  if (trustedProxy === 'cloudflare') {
    return ['cf-connecting-ip']
  }
  if (trustedProxy === 'akamai') {
    return ['true-client-ip']
  }
  return undefined
}

/** Give Better Auth the same resolved hop as the API limiter, overwriting client input. */
export const withTrustedClientIp = (request: Request, trustedProxy: TrustedProxy): Request => {
  if (typeof trustedProxy !== 'number') {
    return request
  }
  const headers = new Headers(request.headers)
  headers.set(trustedClientIpHeader, extractClientIp(headers, 'unknown', trustedProxy))
  return new Request(request, { headers })
}

/**
 * Generic function to filter headers based on a denylist.
 * Works with both request headers (plain object) and response headers (Headers object).
 *
 * @param headers - Either a plain object (request headers) or Headers object (response headers)
 * @param denylist - Array of strings (exact match) or RegExp objects to exclude
 * @returns Filtered headers in the same format as input
 */
export const filterHeaders = <T extends Record<string, string | undefined> | Headers>(
  headers: T,
  denylist: (string | RegExp)[],
): T extends Headers ? Headers : Record<string, string> => {
  const shouldExclude = (key: string): boolean => {
    return denylist.some((filter) => {
      if (typeof filter === 'string') {
        return key.toLowerCase() === filter.toLowerCase()
      }
      return filter.test(key)
    })
  }

  if (headers instanceof Headers) {
    const cleanHeaders = new Headers()
    headers.forEach((value, key) => {
      if (!shouldExclude(key)) {
        cleanHeaders.set(key, value)
      }
    })
    return cleanHeaders as T extends Headers ? Headers : Record<string, string>
  }
  const cleanHeaders: Record<string, string> = {}
  Object.entries(headers).forEach(([key, value]) => {
    if (value && !shouldExclude(key)) {
      cleanHeaders[key] = value
    }
  })
  return cleanHeaders as T extends Headers ? Headers : Record<string, string>
}

/**
 * Safely builds a query string from query parameters, handling null/undefined values gracefully.
 * Uses try-catch to handle URLSearchParams constructor errors.
 *
 * @param query - Query parameters object that may contain null/undefined values
 * @returns Query string with leading '?' if parameters exist, empty string otherwise
 */
export const buildQueryString = (query: Record<string, unknown> | undefined): string => {
  if (!query) {
    return ''
  }

  try {
    const queryParams = new URLSearchParams(query as Record<string, string>)
    return queryParams.toString() ? `?${queryParams.toString()}` : ''
  } catch {
    return ''
  }
}

/**
 * Extract response headers, removing denylisted ones.
 * Used for cleaning up response headers when proxying API responses.
 *
 * @param headers - Headers object from a fetch response
 * @param denylist - Array of strings (exact match) or RegExp objects to exclude from headers
 * @returns New Headers object with denylisted headers removed
 */
export const extractResponseHeaders = (
  headers: Headers,
  denylist: (string | RegExp)[] = defaultResponseDenylist,
): Headers => {
  return filterHeaders(headers, denylist)
}
