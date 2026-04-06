import { promises as dnsPromises } from 'node:dns'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

/** IP ranges blocked for SSRF protection. Excludes multicast (could block legitimate CDN traffic). */
const blockedRanges = new Set([
  'private', // 10/8, 172.16/12, 192.168/16
  'loopback', // 127/8, ::1
  'linkLocal', // 169.254/16, fe80::/10
  'uniqueLocal', // fc00::/7
  'unspecified', // 0.0.0.0/8, ::
  'carrierGradeNat', // 100.64/10 (RFC 6598)
  'reserved', // 198.18/15 (RFC 2544), documentation blocks, etc.
  'broadcast', // 255.255.255.255
])

/**
 * Returns true if the IP address falls within a private/internal/reserved range.
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:x.x.x.x), and bracketed notation ([::1]).
 */
export const isPrivateAddress = (rawHostname: string): boolean => {
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname

  if (!ipaddr.isValid(hostname)) return false

  // process() normalizes IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1) to IPv4
  const addr = ipaddr.process(hostname)
  return blockedRanges.has(addr.range())
}

/** Returns true if the hostname is localhost or 127.0.0.1 (loopback only, not all private). */
export const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
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

/**
 * Creates a fetch wrapper that resolves DNS before connecting and validates
 * all resolved IPs against the private address blocklist. Prevents DNS rebinding
 * SSRF attacks where a hostname resolves to a private IP at connection time.
 *
 * Uses IP pinning: resolves the hostname, validates IPs, then connects directly
 * to the resolved IP with the original Host header for TLS SNI / virtual hosting.
 */
export const createSafeFetch = (fetchFn: typeof fetch) => {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    const hostname = parsed.hostname

    // Direct IP in URL — validate immediately, no DNS needed
    if (isIP(hostname)) {
      if (isPrivateAddress(hostname)) {
        throw new Error(`Blocked: ${hostname} is a private/internal address`)
      }
      return fetchFn(input, init)
    }

    // Resolve DNS and validate ALL resolved IPs
    const addresses = await dnsPromises.lookup(hostname, { all: true })

    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`Blocked: ${hostname} resolves to private/internal address ${address}`)
      }
    }

    // Pin to resolved IP, preserve Host header for TLS SNI + virtual hosting
    const pinnedUrl = new URL(url)
    pinnedUrl.hostname = addresses[0].address
    const headers = new Headers(init?.headers)
    headers.set('Host', hostname)

    return fetchFn(pinnedUrl.toString(), { ...init, headers })
  }
}
