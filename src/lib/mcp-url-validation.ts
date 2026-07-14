/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Result of validating an MCP server URL. `reason` explains why an invalid URL
 * was rejected so the UI can surface actionable guidance.
 */
export type McpUrlValidation = { ok: true } | { ok: false; reason: string }

const httpsRequiredReason = 'Use https:// (http is only allowed for localhost or a local network)'

/** Parses a dotted-quad IPv4 string into its four octets, or null if malformed. */
const parseIpv4Octets = (host: string): [number, number, number, number] | null => {
  const parts = host.split('.')
  if (parts.length !== 4) {
    return null
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return null
  }
  return octets as [number, number, number, number]
}

/** True for the IPv4 loopback range 127.0.0.0/8. */
const isLoopbackIpv4 = (host: string): boolean => {
  const octets = parseIpv4Octets(host)
  return octets !== null && octets[0] === 127
}

/** True for loopback (127.0.0.0/8) or RFC-1918 private ranges (10/8, 172.16/12, 192.168/16). */
const isPrivateIpv4 = (host: string): boolean => {
  const octets = parseIpv4Octets(host)
  if (!octets) {
    return false
  }
  const [a, b] = octets
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** True for IPv6 loopback (::1) or unique-local addresses (fc00::/7, i.e. fc00–fdff). */
const isPrivateIpv6 = (host: string): boolean => {
  const normalized = host.toLowerCase()
  if (normalized === '::1') {
    return true
  }
  const firstHextet = normalized.split(':')[0]
  return /^f[cd][0-9a-f]{0,2}$/.test(firstHextet)
}

/**
 * True for hostnames the browser treats as loopback — the only cross-origin
 * `http://` targets an `https://` page can fetch without hitting mixed-content
 * blocking. Matches `localhost`, `*.localhost` (RFC 6761), the entire IPv4
 * loopback range 127.0.0.0/8, and IPv6 `::1`. Uses `parseIpv4Octets` so real
 * DNS names starting with numeric-looking labels (e.g. `127.0.0.1.evil.com`)
 * are NOT matched — each octet must be a numeric 0–255. Callers hand it a
 * hostname (no scheme, no brackets on IPv6 required — both `::1` and `[::1]`
 * work).
 */
export const isLoopbackHost = (rawHost: string): boolean => {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true
  }
  if (host.includes(':')) {
    return lower === '::1'
  }
  return isLoopbackIpv4(host)
}

/** True for localhost, *.localhost, loopback/private IPv4, or loopback/ULA IPv6. */
const isLocalOrPrivateHost = (rawHost: string): boolean => {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true
  }
  return host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host)
}

/**
 * Validates a URL entered for an MCP server connection.
 *
 * Only http/https are allowed. A public host must use https; plain http is
 * permitted only for loopback (localhost, *.localhost, 127.0.0.0/8, ::1) or
 * private LAN addresses (RFC-1918 10/8, 172.16/12, 192.168/16; IPv6 ULA fc00::/7).
 */
export const validateMcpServerUrl = (url: string): McpUrlValidation => {
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (!parsed) {
    return { ok: false, reason: 'Enter a valid URL' }
  }
  if (parsed.protocol === 'https:') {
    return { ok: true }
  }
  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Use an http:// or https:// URL' }
  }
  if (isLocalOrPrivateHost(parsed.hostname)) {
    return { ok: true }
  }
  return { ok: false, reason: httpsRequiredReason }
}
