/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { promises as dnsPromises } from 'node:dns'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

/** DNS lookup used by URL validation. Shape mirrors `dns.promises.lookup(host, { all: true })`.
 *  Injected as a dep so tests can substitute a deterministic resolver without
 *  `mock.module('node:dns')` (which leaks across files — see docs/development/testing.md). */
export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

const defaultDnsLookup: DnsLookup = (hostname) => dnsPromises.lookup(hostname, { all: true })

/** IP ranges blocked for SSRF protection. Excludes multicast (could block legitimate CDN traffic). */
const blockedRanges = new Set([
  'private', // 10/8, 172.16/12, 192.168/16
  'loopback', // 127/8, ::1
  'linkLocal', // 169.254/16, fe80::/10
  'uniqueLocal', // fc00::/7
  'unspecified', // 0.0.0.0/8, ::
  'carrierGradeNat', // 100.64/10 (RFC 6598)
  'reserved', // 198.18/15, 192.0.0/24, 192.0.2/24, 198.51.100/24, 203.0.113/24, 240.0.0/4, etc.
  'broadcast', // 255.255.255.255
])

type IpAddr = ReturnType<typeof ipaddr.process>

/**
 * Extracts the IPv4 address embedded in an IPv6 transition/translation address,
 * or null if none is embedded. A host with the matching connectivity (NAT64/DNS64,
 * 6to4, Teredo) routes these to the embedded IPv4 — so the embedded address, including
 * a private/internal one, must be re-validated. Blocking the whole range would be wrong:
 * on a DNS64 deployment, legitimate public IPv4 sites resolve to `64:ff9b::<public-ip>`.
 * (`::ffff:x.x.x.x` is already normalized to IPv4 by `ipaddr.process`, so it's not here.)
 *
 * The `case` labels are coupled to ipaddr.js's range taxonomy — if an upgrade renames
 * or reclassifies these ranges, the `default` branch silently reverts to pre-fix behavior
 * (the embedded IPv4 stops being checked). Re-verify these labels when bumping ipaddr.js.
 * Operator-configured NAT64 prefixes (RFC 6052 §2.2 non-`/96` variants) are not detectable
 * here — only the well-known `64:ff9b::/96` is classified `rfc6052`.
 */
const embeddedIpv4 = (addr: IpAddr): string | null => {
  const bytes = addr.toByteArray()
  switch (addr.range()) {
    case 'rfc6052': // NAT64 64:ff9b::/96 — IPv4 in the low 32 bits
    case 'rfc6145': // stateless IPv4/IPv6 translation — IPv4 in the low 32 bits
      return bytes.slice(12, 16).join('.')
    case '6to4': // 2002::/16 — IPv4 in bytes 2..5
      return bytes.slice(2, 6).join('.')
    case 'teredo': // 2001::/32 — client IPv4 in the low 32 bits, one's-complement obfuscated
      return bytes
        .slice(12, 16)
        .map((b) => b ^ 0xff)
        .join('.')
    default:
      return null
  }
}

/**
 * Returns true if the IP address falls within a private/internal/reserved range.
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:x.x.x.x), bracketed notation ([::1]),
 * and IPv6 transition addresses (NAT64/6to4/Teredo) that embed a private IPv4.
 */
export const isPrivateAddress = (rawHostname: string): boolean => {
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname

  if (!ipaddr.isValid(hostname)) {
    return false
  }

  // process() normalizes IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1) to IPv4
  const addr = ipaddr.process(hostname)
  if (blockedRanges.has(addr.range())) {
    return true
  }
  const embedded = embeddedIpv4(addr)
  return embedded !== null && isPrivateAddress(embedded)
}

/** Returns true if the hostname is a loopback address (127.0.0.0/8, ::1, or localhost). */
const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase()
  if (h === 'localhost') {
    return true
  }
  if (!ipaddr.isValid(h)) {
    return false
  }
  return ipaddr.process(h).range() === 'loopback'
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
    if (isLoopback(hostname)) {
      return { valid: false, error: 'Internal URLs are not allowed' }
    }
    if (isPrivateAddress(hostname)) {
      return { valid: false, error: 'Internal URLs are not allowed' }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL' }
  }
}

const maxRedirects = 5

/**
 * Resolves a URL's hostname via DNS, validates all resolved IPs against the
 * private address blocklist, and returns a fetch-ready [pinnedUrl, headers] pair.
 * Prevents DNS rebinding by connecting to the resolved IP with the original Host header.
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
): Promise<[pinnedUrl: string, headers: Headers]> => {
  const parsed = new URL(url)
  parsed.username = ''
  parsed.password = ''
  const hostname = parsed.hostname

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Blocked: ${hostname} is a private/internal address`)
    }
    return [parsed.toString(), new Headers(extraHeaders)]
  }

  const addresses = await dnsLookup(hostname)
  if (!addresses.length) {
    throw new Error(`DNS resolution returned no addresses for ${hostname}`)
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked: ${hostname} resolves to private/internal address ${address}`)
    }
  }

  const pinnedUrl = new URL(parsed.toString())
  const resolvedIp = addresses[0].address
  // IPv6 addresses must be bracket-wrapped for URL hostname assignment
  pinnedUrl.hostname = addresses[0].family === 6 ? `[${resolvedIp}]` : resolvedIp
  const headers = new Headers(extraHeaders)
  headers.set('Host', hostname)

  return [pinnedUrl.toString(), headers]
}

/**
 * Creates a fetch wrapper with SSRF protection. Resolves DNS before connecting,
 * validates all resolved IPs, and follows redirects safely (each hop is validated).
 *
 * Uses IP pinning: resolves the hostname, validates IPs, then connects directly
 * to the resolved IP with the original Host header for TLS SNI / virtual hosting.
 */
export const createSafeFetch = (fetchFn: typeof fetch, dnsLookup: DnsLookup = defaultDnsLookup) => {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const [pinnedUrl, headers] = await validateAndPin(url, init?.headers, dnsLookup)

    // Always intercept redirects so we can validate each hop's destination
    const callerWantsManual = init?.redirect === 'manual'
    const response = await fetchFn(pinnedUrl, { ...init, headers, redirect: 'manual' })

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

      const redirectUrl = new URL(location, currentUrl).toString()
      currentUrl = redirectUrl
      const [pinnedRedirect, redirectHeaders] = await validateAndPin(redirectUrl, init?.headers, dnsLookup)

      // 303 always becomes GET; 301/302 become GET for non-GET/HEAD (per spec)
      const methodOverride =
        currentResponse.status === 303 ||
        ([301, 302].includes(currentResponse.status) && init?.method && !['GET', 'HEAD'].includes(init.method))
      const redirectInit: RequestInit = {
        ...init,
        headers: redirectHeaders,
        redirect: 'manual',
        ...(methodOverride ? { method: 'GET', body: undefined } : {}),
      }

      currentResponse = await fetchFn(pinnedRedirect, redirectInit)

      if (![301, 302, 303, 307, 308].includes(currentResponse.status)) {
        return currentResponse
      }
    }

    throw new Error(`Too many redirects (max ${maxRedirects})`)
  }
}
