/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Loopback classification for the bridge connect flow.
 *
 * The bridge binds to `127.0.0.1` and prints `ws://127.0.0.1:PORT` (ACP) or
 * `http://127.0.0.1:PORT/mcp` (MCP) on its STDERR. The app connects to that
 * local endpoint *directly* — never through the universal proxy, which forbids
 * loopback/private targets (4003) and would strip the credential. These helpers
 * are the single source of truth for "is this a local bridge endpoint?", read by
 * both the ACP WebSocket factory and the MCP fetch selector.
 */

/** Non-IPv4 hostnames that resolve to the local machine, in canonical
 *  (bracket-free, lowercase) form. `new URL().hostname` brackets IPv6 literals
 *  (`[::1]`), so `isLoopbackHost` strips those brackets before comparing against
 *  `::1`. The entire `127.0.0.0/8` IPv4 block is loopback but checked
 *  separately (see `isIpv4Loopback`). `0.0.0.0` is deliberately excluded: it is
 *  an all-interfaces *bind* address, not a valid *connect* target, and excluding
 *  it matches the bridge's own classifier (`cli/src/util.ts`, which accepts
 *  127.0.0.0/8, ::1, localhost). */
const loopbackHosts = new Set(['::1', 'localhost'])

/** True when `host` is an IPv4 literal in the `127.0.0.0/8` loopback block (each
 *  octet 0..255). Mirrors the bridge's classifier so a bridge bound with e.g.
 *  `--host 127.0.0.2` is connected to directly, not routed through the universal
 *  proxy (which rejects loopback). */
const isIpv4Loopback = (host: string): boolean => {
  const octets = host.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/**
 * True when `host` names the local machine. Accepts a bare hostname (no
 * scheme/port) and tolerates an IPv6 literal in either bracketed (`[::1]`, the
 * form `URL.hostname` yields) or bare (`::1`) form. Case-insensitive. Any IPv4
 * literal in `127.0.0.0/8` (not just `127.0.0.1`) counts as loopback.
 */
export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[(.+)\]$/, '$1')
  return loopbackHosts.has(normalized) || isIpv4Loopback(normalized)
}

/**
 * True when `url` points at a loopback host. Parses via `new URL()` so shorthand
 * like `ws://127.0.0.1:8080` is canonicalized (IPv6 brackets stripped, host
 * lowercased) before classification. A malformed URL is not loopback.
 */
export const isLoopbackUrl = (url: string): boolean => {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}
