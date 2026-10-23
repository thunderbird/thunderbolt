/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { promises as dnsPromises } from 'node:dns'
import { isPrivateOrInternalAddress, parseIpAddress } from '@shared/ip-classification'

/** DNS lookup used by URL validation. Shape mirrors `dns.promises.lookup(host, { all: true })`.
 *  Injected as a dep so tests can substitute a deterministic resolver without
 *  `mock.module('node:dns')` (which leaks across files — see docs/internals/development/testing.md). */
export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

const defaultDnsLookup: DnsLookup = (hostname) => dnsPromises.lookup(hostname, { all: true })

/**
 * Returns true if the IP address falls within a private/internal/reserved range.
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:x.x.x.x), bracketed notation ([::1]),
 * and IPv6 transition addresses (NAT64/6to4/Teredo) that embed IPv4.
 */
export const isPrivateAddress = (rawHostname: string): boolean => {
  const address = parseIpAddress(rawHostname)
  return address ? isPrivateOrInternalAddress(address) : false
}

/** Returns the URL upgraded to https://, or null if it isn't http(s) and can't be safely upgraded. */
export const ensureHttps = (raw: string | null | undefined): string | null => {
  if (!raw) {
    return null
  }
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') {
      return u.toString()
    }
    if (u.protocol === 'http:') {
      u.protocol = 'https:'
      return u.toString()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Validates that a URL is safe to fetch (prevents SSRF attacks).
 * Only allows http/https protocols and blocks internal/private IP addresses.
 */
export const validateSafeUrl = (url: string): { valid: boolean; error?: string } => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS URLs are supported' }
    }
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || isPrivateAddress(hostname)) {
      return { valid: false, error: 'Internal URLs are not allowed' }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL' }
  }
}

const maxRedirects = 5

/** A URL the SSRF guard refuses: a private or internal address, or a scheme the caller disallowed. */
export class BlockedUrlError extends Error {}

/** A URL whose redirects run past the hop limit: a loop, which no retry escapes. */
export class TooManyRedirectsError extends Error {}

/** Permit one exact local proxy fixture only while the backend runs tests. */
export const isAllowedTestProxyTarget = (url: URL): boolean =>
  process.env.NODE_ENV === 'test' &&
  (url.protocol === 'http:' || url.protocol === 'https:') &&
  (process.env.TEST_PROXY_ALLOWED_HOSTS ?? '').split(',').includes(url.host)

/** Bun-specific `fetch` TLS options for a pinned request. */
export type PinnedTls = { serverName: string }

/**
 * Resolves a URL's hostname via DNS, validates all resolved IPs against the
 * private address blocklist, and returns a fetch-ready [pinnedUrl, headers, tls] triple.
 * Prevents DNS rebinding by connecting to the resolved IP with the original Host header.
 *
 * `tls` names the original hostname for TLS SNI and certificate verification, which
 * would otherwise follow the IP in the pinned URL. Bun derived SNI from the Host header
 * through 1.4.0; from 1.4.1 every pinned HTTPS request fails the handshake without it.
 * It is undefined when the URL was not rewritten (IP literals, test fixtures).
 *
 * Userinfo (username/password) is stripped from the resulting pinned URL.
 *
 * Also exported for handlers that run their own per-hop redirect loop and need
 * to validate + pin each hop independently (e.g. the universal proxy endpoint).
 */
export const validateAndPin = async (
  url: string,
  extraHeaders?: HeadersInit,
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<[pinnedUrl: string, headers: Headers, tls: PinnedTls | undefined]> => {
  const parsed = new URL(url)
  parsed.username = ''
  parsed.password = ''
  const hostname = parsed.hostname
  const literalAddress = parseIpAddress(hostname)

  if (isAllowedTestProxyTarget(parsed)) {
    return [parsed.toString(), new Headers(extraHeaders), undefined]
  }

  if (literalAddress) {
    if (isPrivateOrInternalAddress(literalAddress)) {
      throw new BlockedUrlError(`Blocked: ${hostname} is a private/internal address`)
    }
    return [parsed.toString(), new Headers(extraHeaders), undefined]
  }

  const addresses = await dnsLookup(hostname)
  if (!addresses.length) {
    throw new Error(`DNS resolution returned no addresses for ${hostname}`)
  }

  for (const { address } of addresses) {
    const resolvedAddress = parseIpAddress(address)
    if (!resolvedAddress) {
      throw new BlockedUrlError(`Blocked: ${hostname} resolves to invalid IP address ${address}`)
    }
    if (isPrivateOrInternalAddress(resolvedAddress)) {
      throw new BlockedUrlError(`Blocked: ${hostname} resolves to private/internal address ${address}`)
    }
  }

  const pinnedUrl = new URL(parsed.toString())
  const resolvedIp = addresses[0].address
  // IPv6 addresses must be bracket-wrapped for URL hostname assignment
  pinnedUrl.hostname = addresses[0].family === 6 ? `[${resolvedIp}]` : resolvedIp
  const headers = new Headers(extraHeaders)
  headers.set('Host', hostname)

  return [pinnedUrl.toString(), headers, { serverName: hostname }]
}

/**
 * Creates a fetch wrapper with SSRF protection. Resolves DNS before connecting,
 * validates all resolved IPs, and follows redirects safely (each hop is validated).
 *
 * Uses IP pinning: resolves the hostname, validates IPs, then connects directly
 * to the resolved IP with the original hostname in the Host header (virtual hosting)
 * and in `tls.serverName` (SNI and certificate verification).
 *
 * With `httpsOnly`, every hop must be https: a redirect to plain http is refused
 * rather than followed, so an https-only URL stays https end to end.
 */
export const createSafeFetch = (
  fetchFn: typeof fetch,
  dnsLookup: DnsLookup = defaultDnsLookup,
  options: { httpsOnly?: boolean } = {},
) => {
  const validateHop = (url: string, extraHeaders: HeadersInit | undefined) => {
    if (options.httpsOnly && new URL(url).protocol !== 'https:') {
      throw new BlockedUrlError(`Blocked: ${new URL(url).host} is not served over https`)
    }
    return validateAndPin(url, extraHeaders, dnsLookup)
  }
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const [pinnedUrl, headers, tls] = await validateHop(url, init?.headers)

    // Always intercept redirects so we can validate each hop's destination
    const callerWantsManual = init?.redirect === 'manual'
    const response = await fetchFn(pinnedUrl, { ...init, headers, tls, redirect: 'manual' })

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    if (!isRedirect || callerWantsManual) {
      return response
    }

    // Follow redirects, validating SSRF on each hop
    let currentResponse = response
    let currentUrl = url
    for (let i = 0; i < maxRedirects; i++) {
      const location = currentResponse.headers.get('location')
      if (!location) {
        return currentResponse
      }
      // Only the headers matter; release the connection before the next hop, which may be refused.
      await currentResponse.body?.cancel()

      const redirectUrl = new URL(location, currentUrl).toString()
      currentUrl = redirectUrl
      const [pinnedRedirect, redirectHeaders, redirectTls] = await validateHop(redirectUrl, init?.headers)

      // 303 always becomes GET; 301/302 become GET for non-GET/HEAD (per spec)
      const methodOverride =
        currentResponse.status === 303 ||
        ([301, 302].includes(currentResponse.status) && init?.method && !['GET', 'HEAD'].includes(init.method))
      const redirectInit: BunFetchRequestInit = {
        ...init,
        headers: redirectHeaders,
        tls: redirectTls,
        redirect: 'manual',
        ...(methodOverride ? { method: 'GET', body: undefined } : {}),
      }

      currentResponse = await fetchFn(pinnedRedirect, redirectInit)

      if (![301, 302, 303, 307, 308].includes(currentResponse.status)) {
        return currentResponse
      }
    }

    await currentResponse.body?.cancel()
    throw new TooManyRedirectsError(`Too many redirects (max ${maxRedirects})`)
  }
}
