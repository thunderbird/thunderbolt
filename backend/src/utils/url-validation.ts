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

const maxRedirects = 5

/**
 * Resolves a URL's hostname via DNS, validates all resolved IPs against the
 * private address blocklist, and returns a fetch-ready [pinnedUrl, headers] pair.
 * Prevents DNS rebinding by connecting to the resolved IP with the original Host header.
 */
const resolveAndValidate = async (
  url: string,
  extraHeaders?: HeadersInit,
): Promise<[pinnedUrl: string, headers: Headers]> => {
  const parsed = new URL(url)
  const hostname = parsed.hostname

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Blocked: ${hostname} is a private/internal address`)
    }
    return [url, new Headers(extraHeaders)]
  }

  const addresses = await dnsPromises.lookup(hostname, { all: true })

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked: ${hostname} resolves to private/internal address ${address}`)
    }
  }

  const pinnedUrl = new URL(url)
  pinnedUrl.hostname = addresses[0].address
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
export const createSafeFetch = (fetchFn: typeof fetch) => {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const [pinnedUrl, headers] = await resolveAndValidate(url, init?.headers)

    // Always intercept redirects so we can validate each hop's destination
    const callerWantsManual = init?.redirect === 'manual'
    const response = await fetchFn(pinnedUrl, { ...init, headers, redirect: 'manual' })

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status)
    if (!isRedirect || callerWantsManual) {
      return response
    }

    // Follow redirects, validating SSRF on each hop
    let currentResponse = response
    for (let i = 0; i < maxRedirects; i++) {
      const location = currentResponse.headers.get('location')
      if (!location) return currentResponse

      const redirectUrl = new URL(location, url).toString()
      const [pinnedRedirect, redirectHeaders] = await resolveAndValidate(redirectUrl, init?.headers)

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
