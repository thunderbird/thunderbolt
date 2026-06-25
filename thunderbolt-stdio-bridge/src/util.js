/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { UsageError } = require('./errors')

/**
 * Coerce a CLI port value to an integer in [0, 65535]. `undefined`/empty → 0
 * (OS-assigned ephemeral port). Throws UsageError on NaN or out-of-range.
 * @param {string|number|undefined} raw
 * @returns {number}
 */
const resolvePort = (raw) => {
  if (raw === undefined || raw === '') return 0
  const str = String(raw)
  if (!/^\d+$/.test(str)) throw new UsageError(`--port must be an integer in 0..65535, got "${str}"`)
  const port = Number(str)
  if (port > 65535) throw new UsageError(`--port must be an integer in 0..65535, got "${str}"`)
  return port
}

/**
 * Render a host for embedding in a URL — wraps bare IPv6 literals in brackets,
 * passes through IPv4 / hostnames / already-bracketed literals unchanged.
 * @param {string} host
 * @returns {string}
 */
const formatHostForUrl = (host) => {
  if (host.startsWith('[') && host.endsWith(']')) return host
  if (host.includes(':')) return `[${host}]`
  return host
}

/**
 * True iff `host` is a loopback literal: 127.0.0.0/8, ::1 (bracketed or not),
 * or localhost (case-insensitive). Single source of truth for the Origin
 * allowlist and the insecure-flag warnings; mirrors the app's isLoopbackHost.
 * @param {string} host
 * @returns {boolean}
 */
const isLoopbackHost = (host) => {
  const stripped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const lower = stripped.toLowerCase()
  if (lower === 'localhost' || lower === '::1') return true
  const octets = lower.split('.')
  if (octets.length !== 4) return false
  return octets[0] === '127' && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
}

/**
 * A resolve-once close latch shared by both faces. `settle` runs the bound
 * resolver exactly once (later calls are no-ops); `close()` first sets the
 * resolver then triggers teardown, so the resolver fires when teardown
 * completes. Centralizes the never-orphan teardown semantics so the two faces
 * can't drift.
 * @returns {{ finishClose: () => void, setResolver: (fn: () => void) => void, settled: () => boolean }}
 */
const makeCloseLatch = () => {
  let settled = false
  let resolveClose = null
  return {
    finishClose: () => {
      if (settled) return
      settled = true
      if (resolveClose) resolveClose()
    },
    setResolver: (fn) => {
      resolveClose = fn
    },
    settled: () => settled,
  }
}

/**
 * Build the list of loud warning lines to emit before binding. Empty array when
 * the config is safe. Builds messages only — printing is the caller's job, so
 * this stays pure and testable.
 * @param {{ host: string, allowAnyOrigin: boolean, tunnel: boolean }} opts
 * @returns {string[]}
 */
const insecureFlagWarnings = ({ host, allowAnyOrigin, tunnel }) => {
  const warnings = []
  if (allowAnyOrigin && !isLoopbackHost(host)) {
    warnings.push(
      `DANGER: --allow-any-origin on non-loopback host "${host}" disables the Origin gate and exposes the face to the network — any site can drive your local server.`,
    )
  } else if (allowAnyOrigin) {
    warnings.push('WARNING: --allow-any-origin disables the Origin gate — any browser Origin may connect.')
  }
  if (tunnel) {
    warnings.push('WARNING: --tunnel exposes the MCP face publicly via cloudflared (protected by a mandatory bearer).')
  }
  return warnings
}

module.exports = {
  resolvePort,
  formatHostForUrl,
  isLoopbackHost,
  insecureFlagWarnings,
  makeCloseLatch,
}
