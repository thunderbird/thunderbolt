/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ChildExit, ExitCode, UnavailableErrorOptions } from './types'

/**
 * Canonical sysexits exit-code table for the bridge.
 */
const EX = Object.freeze({
  OK: 0,
  USAGE: 64,
  UNAVAILABLE: 69,
  SOFTWARE: 70,
  SIGINT: 130,
} as const)

/**
 * Node error codes that classify as EX_UNAVAILABLE (69) — the single source of
 * truth for the unavailable classification.
 */
const UNAVAILABLE_CODES = new Set(['ENOENT', 'EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'ECONNREFUSED'])

/** Fixed, PII-safe phrases for each unavailable Node error code. */
const UNAVAILABLE_PHRASES: Record<string, string> = Object.freeze({
  ENOENT: 'command not found',
  EADDRINUSE: 'address in use',
  EACCES: 'permission denied',
  EADDRNOTAVAIL: 'address not available',
  ECONNREFUSED: 'connection refused',
})

/** A usage/validation error → exit 64. Names the offending flag, never user payload. */
class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** A resource-unavailable error → exit 69. Carries a Node errorCode string. */
class UnavailableError extends Error {
  code?: string
  constructor(opts: UnavailableErrorOptions = {}) {
    super(opts.message ?? opts.code ?? 'unavailable')
    this.name = 'UnavailableError'
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
 */
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined

/**
 * Pure mapper from any thrown value to a sysexits exit code.
 * UsageError→64; UnavailableError or a Node error in the unavailable set→69;
 * a SIGINT marker→130; anything else→70.
 */
const toExitCode = (err: unknown): ExitCode => {
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
 */
const toMessage = (err: unknown): string => {
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
 */
const childExitToCode = (exit: ChildExit): ExitCode => {
  if (exit.signal === 'SIGINT') return EX.SIGINT
  if (exit.signal) return EX.SOFTWARE
  if (exit.code === 0) return EX.OK
  return EX.SOFTWARE
}

export { EX, UsageError, UnavailableError, SigintError, toExitCode, toMessage, childExitToCode }
