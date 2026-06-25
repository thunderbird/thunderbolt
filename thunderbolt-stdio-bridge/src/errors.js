/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

/**
 * Canonical sysexits exit-code table for the bridge.
 * @type {{ OK: 0, USAGE: 64, UNAVAILABLE: 69, SOFTWARE: 70, SIGINT: 130 }}
 */
const EX = Object.freeze({
  OK: 0,
  USAGE: 64,
  UNAVAILABLE: 69,
  SOFTWARE: 70,
  SIGINT: 130,
})

/**
 * Node error codes that classify as EX_UNAVAILABLE (69) — the single source of
 * truth for the unavailable classification.
 * @type {Set<string>}
 */
const UNAVAILABLE_CODES = new Set(['ENOENT', 'EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'ECONNREFUSED'])

/** Fixed, PII-safe phrases for each unavailable Node error code. */
const UNAVAILABLE_PHRASES = Object.freeze({
  ENOENT: 'command not found',
  EADDRINUSE: 'address in use',
  EACCES: 'permission denied',
  EADDRNOTAVAIL: 'address not available',
  ECONNREFUSED: 'connection refused',
})

/** A usage/validation error → exit 64. Names the offending flag, never user payload. */
class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** A resource-unavailable error → exit 69. Carries a Node errorCode string. */
class UnavailableError extends Error {
  /** @param {{ code?: string, message?: string }} [opts] */
  constructor(opts = {}) {
    super(opts.message ?? opts.code ?? 'unavailable')
    this.name = 'UnavailableError'
    /** @type {string|undefined} */
    this.code = opts.code
  }
}

/** A marker error for SIGINT-initiated teardown → exit 130. */
class SigintError extends Error {
  constructor() {
    super('interrupted')
    this.name = 'SigintError'
  }
}

/**
 * Reads the Node error code (`err.code`) from an unknown value, if present.
 * @param {unknown} err
 * @returns {string|undefined}
 */
const codeOf = (err) =>
  typeof err === 'object' && err !== null && typeof (/** @type {{ code?: unknown }} */ (err).code) === 'string'
    ? /** @type {{ code: string }} */ (err).code
    : undefined

/**
 * Pure mapper from any thrown value to a sysexits exit code.
 * UsageError→64; UnavailableError or a Node error in the unavailable set→69;
 * a SIGINT marker→130; anything else→70.
 * @param {unknown} err
 * @returns {number}
 */
const toExitCode = (err) => {
  if (err instanceof UsageError) return EX.USAGE
  if (err instanceof SigintError) return EX.SIGINT
  if (err instanceof UnavailableError) return EX.UNAVAILABLE
  const code = codeOf(err)
  if (code && UNAVAILABLE_CODES.has(code)) return EX.UNAVAILABLE
  return EX.SOFTWARE
}

/**
 * Pure mapper to a PII-safe, single-line, user-facing message. Embeds only the
 * Node errorCode (never err.message/stack for arbitrary errors), the failing
 * flag name for UsageError, and a fixed friendly phrase for the unavailable set.
 * @param {unknown} err
 * @returns {string}
 */
const toMessage = (err) => {
  if (err instanceof UsageError) return err.message
  if (err instanceof SigintError) return 'interrupted'
  if (err instanceof UnavailableError) {
    const phrase = err.code ? UNAVAILABLE_PHRASES[err.code] : undefined
    return phrase ?? (err.code ? `unavailable (${err.code})` : 'unavailable')
  }
  const code = codeOf(err)
  if (code && UNAVAILABLE_CODES.has(code)) return UNAVAILABLE_PHRASES[code]
  if (code) return `internal error (${code})`
  return 'internal error'
}

/**
 * Pure: derive the bridge exit code from a child process exit. A clean exit
 * (code 0) → 0; a SIGINT signal → 130; any other nonzero code or signal → 70.
 * @param {{ code: number|null, signal: string|null }} exit
 * @returns {number}
 */
const childExitToCode = (exit) => {
  if (exit.signal === 'SIGINT') return EX.SIGINT
  if (exit.signal) return EX.SOFTWARE
  if (exit.code === 0) return EX.OK
  return EX.SOFTWARE
}

module.exports = {
  EX,
  UNAVAILABLE_CODES,
  UsageError,
  UnavailableError,
  SigintError,
  toExitCode,
  toMessage,
  childExitToCode,
}
