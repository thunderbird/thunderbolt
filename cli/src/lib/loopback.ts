/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether a hostname names this machine.
 *
 * Two callers need it and they supply the name in different shapes: the MCP
 * config checks a WHATWG-parsed `URL.hostname`, which brackets IPv6 (`[::1]`),
 * while the bridge checks a raw environment variable, where an operator writes
 * `::1`. Both forms are accepted so neither caller has to normalize first.
 */

/**
 * 127.0.0.0/8 in dotted-quad form.
 *
 * Deliberately not a numeric range parse. A `URL.hostname` has already been
 * canonicalized — `127.1`, `2130706433`, `0177.1` and `0x7f.1` all arrive as
 * `127.0.0.1`, and an out-of-range octet makes the URL throw — so for that
 * caller the pattern is exact. For a hand-written bind address the shorthands
 * are not idiomatic, and treating one as non-loopback only demands a token the
 * operator should be setting anyway.
 */
const loopbackIpv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

const ipv6Loopback = new Set(['::1', '[::1]'])

/**
 * Tests a hostname against the real loopback set.
 *
 * A prefix test would be wrong: `127.0.0.1.evil.com` starts with `127.` and
 * resolves wherever its owner points it, and `localhost.evil.com` is no more
 * local than any other domain.
 *
 * @param hostname - a parsed `URL.hostname` or a raw configured host
 * @returns true when traffic to it cannot leave the machine
 */
export const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || ipv6Loopback.has(hostname) || loopbackIpv4.test(hostname)
