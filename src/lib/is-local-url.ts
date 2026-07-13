/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Returns true when the URL points at the user's own machine or private
 * network — the case where the browser can reach the target without our
 * backend acting as a CORS intermediary. Used by the Custom-provider dispatch
 * to decide whether to skip the universal proxy (see `src/ai/fetch.ts`).
 *
 * Strict hostname matching: only exact names and literal IP ranges count as
 * local. A domain like `localhost.evil.com` does NOT match — the string
 * `localhost` must be the entire hostname — so an attacker can't trick the
 * dispatcher into bypassing the proxy for a public target. Common IPv4
 * private ranges are covered (RFC 1918 + loopback); rare setups (IPv6 unique
 * local, link-local, `::ffff:` mapped private) fall through to the proxy
 * path, which is the safer default anyway.
 */
const exactLocalHostnames = new Set(['localhost', 'host.docker.internal'])

const privateIpv4Patterns = [
  /^127\./, // loopback (127/8)
  /^10\./, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
  /^192\.168\./, // RFC 1918
]

export const isLocalUrl = (rawUrl: string): boolean => {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  // The URL parser preserves bracket notation for IPv6 in `hostname`.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1)
  }
  if (exactLocalHostnames.has(hostname)) {
    return true
  }
  if (hostname === '::1') {
    return true
  }
  return privateIpv4Patterns.some((pattern) => pattern.test(hostname))
}
