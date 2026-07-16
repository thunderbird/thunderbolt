/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HandleError, HandleErrorCode } from '@/types/handle-errors'

const parseJson = (str: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(str)
  } catch {
    return undefined
  }
}

/** Check whether an error represents a rate-limit (HTTP 429) response. */
export const isRateLimitError = (error?: Error | null): boolean => {
  if (!error?.message) {
    return false
  }

  // aiFetchStreamingResponse serializes errors as {"error":"...","status":429}
  // DefaultChatTransport may use {"error":"...","statusCode":429}
  const parsed = parseJson(error.message)
  if (parsed?.status === 429 || parsed?.statusCode === 429) {
    return true
  }

  return error.message.toLowerCase().includes('too many requests')
}

/**
 * ACP agents (e.g. Zeroclaw) reject a new `session/prompt` while a prior turn
 * still holds the session slot — often right after Stop, when `session/cancel`
 * has fired but the turn has not exited yet. Auto-retrying the identical send
 * only amplifies the race; surface the error and let the user retry once idle.
 */
export const isAcpSessionBusyError = (error?: Error | null): boolean => {
  if (!error?.message) {
    return false
  }
  const parsed = parseJson(error.message)
  const message = (typeof parsed?.error === 'string' ? parsed.error : error.message).toLowerCase()
  return message.includes('active prompt turn')
}

/**
 * Extract an HTTP status code from a serialized stream/transport error, if one
 * is present. The frontend serializes API errors as `{"error":...,"status":N}`
 * (see `aiFetchStreamingResponse`), which is the only place the upstream status
 * survives — the AI SDK otherwise flattens it to a bare "Bad Request".
 */
export const getErrorStatusCode = (error?: Error | null): number | undefined => {
  if (!error?.message) {
    return undefined
  }
  const parsed = parseJson(error.message)
  if (typeof parsed?.status === 'number') {
    return parsed.status
  }
  if (typeof parsed?.statusCode === 'number') {
    return parsed.statusCode
  }
  return undefined
}

/**
 * The provider/SDK's own retry verdict, if it survived serialization
 * (`serializeStreamError` includes `isRetryable` for `APICallError` and the
 * client-side `UnsupportedFunctionalityError`). `false` means identical input
 * will fail again (4xx, unsupported content); `true` / `undefined` means it may
 * be transient (408/409/5xx/network) and is worth the normal retry loop. This is
 * a more precise retry signal than "is it a 4xx", which wrongly buckets transient
 * 408s with deterministic 400s.
 */
export const getErrorRetryable = (error?: Error | null): boolean | undefined => {
  if (!error?.message) {
    return undefined
  }
  const parsed = parseJson(error.message)
  return typeof parsed?.isRetryable === 'boolean' ? parsed.isRetryable : undefined
}

/**
 * Markers for "the request exceeds the model's context window" — emitted by every
 * provider, usually as a 400 that carries the token counts (e.g. Anthropic's
 * "prompt is too long: N tokens > M maximum", OpenAI's `context_length_exceeded`).
 * This is a distinct failure from a content rejection: the file *can* be read,
 * it's just too big — so it should NOT trigger attachment remediation (converting
 * native→text/images won't shrink it enough) and warrants its own guidance.
 */
const contextOverflowMarkers = [
  'context_length_exceeded',
  'context length',
  'maximum context',
  'prompt is too long',
  'exceeds the context window',
  'reduce the length of the messages',
  'too many tokens',
  'maximum number of tokens',
]

/** Check whether an error represents a context-window overflow (request too large). */
export const isContextOverflowError = (error?: Error | null): boolean => {
  if (!error?.message) {
    return false
  }
  const parsed = parseJson(error.message)
  const message = (typeof parsed?.error === 'string' ? parsed.error : error.message).toLowerCase()
  return contextOverflowMarkers.some((marker) => message.includes(marker))
}

/**
 * A content rejection: the endpoint rejected the *form* of the request body —
 * a file part it can't carry — surfaced as a 400 (e.g. the OpenAI-compat
 * `content.str` error) or the 422 `serializeStreamError` mints for a file-part
 * `UnsupportedFunctionalityError`. Deliberately narrow: it excludes auth
 * (401/403), not-found (404), timeouts (408), rate limits (429), and context
 * overflow — none of which attachment remediation can fix by re-delivering as
 * text/images. This is the ONLY signal that should trigger remediation.
 */
export const isContentRejectionError = (error?: Error | null): boolean => {
  if (isRateLimitError(error) || isContextOverflowError(error)) {
    return false
  }
  const status = getErrorStatusCode(error)
  return status === 400 || status === 422
}

/**
 * Creates a HandleError with optional stack trace if available
 */
export const createHandleError = (code: HandleErrorCode, message: string, originalError?: unknown): HandleError => {
  const error: HandleError = {
    code,
    message,
    originalError,
  }

  // Add stack trace if available
  if (originalError instanceof Error) {
    error.stackTrace = originalError.stack
  }

  return error
}
