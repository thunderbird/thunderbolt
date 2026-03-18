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

    const rawHostname = parsed.hostname.toLowerCase()
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '::'
    ) {
      return { valid: false, error: 'Internal URLs are not allowed' }
    }

    const ipv4Regex =
      /^(?:(?:10|127)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|192\.168\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|169\.254\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/
    const ipv6LinkLocalRegex = /^fe[89ab][0-9a-f]/
    const ipv6UniqueLocalRegex = /^f[cd][0-9a-f]/

    if (ipv4Regex.test(hostname) || ipv6LinkLocalRegex.test(hostname) || ipv6UniqueLocalRegex.test(hostname)) {
      return { valid: false, error: 'Internal URLs are not allowed' }
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
          if (ipv4Regex.test(ipv4)) {
            return { valid: false, error: 'Internal URLs are not allowed' }
          }
        }
      }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL' }
  }
}

/** Resolves a potentially relative URL to an absolute URL */
export const resolveUrl = (baseUrl: string, relativeUrl: string): string => {
  try {
    return new URL(relativeUrl, baseUrl).href
  } catch {
    return relativeUrl
  }
}

/** Decodes a URL path parameter, returning null on invalid encoding */
export const decodeUrlParam = (encoded: string): string | null => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
