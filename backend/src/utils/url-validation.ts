/** Regex matching RFC 1918, loopback, link-local, and carrier-grade NAT IPv4 ranges. */
const privateIpv4Regex =
  /^(?:(?:10|127)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|192\.168\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|169\.254\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/
const ipv6LinkLocalRegex = /^fe[89ab][0-9a-f]/
const ipv6UniqueLocalRegex = /^f[cd][0-9a-f]/

/**
 * Returns true if the hostname resolves to a private/internal address.
 * Covers: loopback, RFC 1918, link-local (169.254.x.x), IPv6 ULA/link-local, IPv4-mapped IPv6.
 */
export const isPrivateAddress = (rawHostname: string): boolean => {
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1).toLowerCase()
    : rawHostname.toLowerCase()

  if (hostname === '0.0.0.0' || hostname === '::' || hostname === '::1') {
    return true
  }

  if (privateIpv4Regex.test(hostname) || ipv6LinkLocalRegex.test(hostname) || ipv6UniqueLocalRegex.test(hostname)) {
    return true
  }

  // Block IPv4-mapped IPv6 (::ffff:XXYY:ZZWW) — Bun normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (hostname.startsWith('::ffff:')) {
    const mapped = hostname.slice(7)
    const hexParts = mapped.split(':')
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16)
      const low = parseInt(hexParts[1], 16)
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
        if (privateIpv4Regex.test(ipv4)) {
          return true
        }
      }
    }
  }

  return false
}

/** Returns true if the hostname is localhost or 127.0.0.1 (loopback only, not all private). */
export const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Creates a fetch wrapper that resolves DNS before connecting and validates
 * all resolved IPs against the private address blocklist. Prevents DNS rebinding
 * SSRF attacks where a hostname resolves to a private IP at connection time.
 *
 * Uses IP pinning: resolves the hostname, validates IPs, then connects directly
 * to the resolved IP with the original Host header for TLS SNI / virtual hosting.
 */
export const createSafeFetch = (
  fetchFn: typeof fetch,
  options?: { allowLoopback?: boolean },
) => {
  const { allowLoopback = false } = options ?? {}

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    const hostname = parsed.hostname

    // Direct IP in URL — validate immediately, no DNS needed
    const { isIP } = await import('node:net')
    if (isIP(hostname)) {
      if (allowLoopback && isLoopback(hostname)) {
        return fetchFn(input, init)
      }
      if (isPrivateAddress(hostname)) {
        throw new Error(`Blocked: ${hostname} is a private/internal address`)
      }
      return fetchFn(input, init)
    }

    // Allow loopback hostnames directly (no IP pinning needed for localhost)
    if (allowLoopback && isLoopback(hostname)) {
      return fetchFn(input, init)
    }

    // Resolve DNS and validate ALL resolved IPs
    const dns = await import('node:dns')
    const addresses = await dns.promises.lookup(hostname, { all: true })

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
