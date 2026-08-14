/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HandleError, HandleErrorCode } from '@/types/handle-errors'
import { tinfoilUpstreamIdleTimeoutMessage, tinfoilUpstreamTimeoutMessage } from '@shared/tinfoil-proxy'

const chatErrorKinds = ['attestation', 'timeout', 'rate-limit', 'provider', 'network', 'connection-lost'] as const
export type ChatErrorKind = (typeof chatErrorKinds)[number]

const isChatErrorKind = (value: unknown): value is ChatErrorKind => chatErrorKinds.includes(value as ChatErrorKind)

const parseJson = (str: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(str)
  } catch {
    return undefined
  }
}
const providerErrorNames = new Set(['KeyConfigMismatchError', 'ProtocolError', 'DecryptionError'])
const timeoutMarkers = [tinfoilUpstreamTimeoutMessage, tinfoilUpstreamIdleTimeoutMessage]
const networkErrorMarkers = ['failed to fetch', 'load failed', 'networkerror']

type ErrorClassificationFields = {
  name?: string
  status?: number
  message?: string
}

const firstNumber = (...values: unknown[]): number | undefined =>
  values.find((value): value is number => typeof value === 'number')

const firstString = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string')

const getPiErrorStatusCode = (message: string): number | undefined => {
  const match = message.match(/^(\d{3}):\s/) ?? message.match(/^[^(]*\((\d{3})\):/)
  const status = match ? Number(match[1]) : undefined
  return status !== undefined && status >= 400 && status <= 599 ? status : undefined
}

/** Normalize raw error fields used by chat error classification. */
const getErrorClassificationFields = (error: unknown): ErrorClassificationFields => {
  if (typeof error === 'string') {
    return { message: error }
  }
  if (typeof error !== 'object' || error === null) {
    return {}
  }

  const value = error as Record<string, unknown>
  const response = (value.response ?? {}) as Record<string, unknown>
  return {
    name: getErrorName(value),
    status: firstNumber(value.status, value.statusCode, response.status),
    message: firstString(value.responseBody, value.message),
  }
}

/**
 * Classify a raw pipeline error into a stable user-facing chat error kind.
 * Classification uses only normalized error name, HTTP status, and message.
 */
export const classifyErrorKind = (error: unknown): ChatErrorKind | undefined => {
  const { name, status: structuredStatus, message } = getErrorClassificationFields(error)
  const status = structuredStatus ?? (message ? getPiErrorStatusCode(message) : undefined)
  const normalizedMessage = message?.toLowerCase()
  const isContentRejectionStatus = status === 400 || status === 422

  if (name === 'TinfoilAttestationTimeoutError') {
    return 'timeout'
  }
  if (name === 'TinfoilAttestationError') {
    return 'attestation'
  }
  if (status === 429) {
    return 'rate-limit'
  }
  if (status === 408 || (normalizedMessage && timeoutMarkers.some((marker) => normalizedMessage.includes(marker)))) {
    return 'timeout'
  }
  // ChatErrorKind has no content-rejection bucket, so use its existing provider class.
  if ((name && providerErrorNames.has(name)) || isContentRejectionStatus || (status !== undefined && status >= 500)) {
    return 'provider'
  }
  if (
    name === 'TypeError' &&
    normalizedMessage &&
    networkErrorMarkers.some((marker) => normalizedMessage.includes(marker))
  ) {
    return 'network'
  }
  return undefined
}

/**
 * Read a serialized chat error kind, falling back to legacy status/message
 * classification when older payloads do not carry one.
 */
export const getChatErrorKind = (error?: Error | null): ChatErrorKind | undefined => {
  if (!error?.message) {
    return undefined
  }

  const parsed = parseJson(error.message)
  if (!parsed) {
    return classifyErrorKind(error)
  }
  if (isChatErrorKind(parsed.kind)) {
    return parsed.kind
  }

  return classifyErrorKind({
    status: firstNumber(parsed.status, parsed.statusCode),
    message: firstString(parsed.error),
  })
}

/** Return an error-like value's string name, when present. */
export const getErrorName = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return undefined
  }
  return typeof error.name === 'string' ? error.name : undefined
}

/** Check whether an error represents a rate-limit (HTTP 429) response. */
export const isRateLimitError = (error?: Error | null): boolean => {
  if (!error?.message) {
    return false
  }

  // aiFetchStreamingResponse serializes errors as {"error":"...","status":429}
  // DefaultChatTransport may use {"error":"...","statusCode":429}
  const parsed = parseJson(error.message)
  if (parsed?.status === 429 || parsed?.statusCode === 429 || getPiErrorStatusCode(error.message) === 429) {
    return true
  }

  return error.message.toLowerCase().includes('too many requests')
}

/**
 * Extract an HTTP status code from a serialized stream/transport error, if one
 * is present. The frontend serializes API errors as `{"error":...,"status":N}`
 * (see `aiFetchStreamingResponse`). The Pi path instead flattens errors to text
 * through pi-ai's `formatProviderError`, using either `"<status>: <body>"` or
 * `"<prefix> (<status>): <message>"`.
 */
export const getErrorStatusCode = (error?: Error | null): number | undefined => {
  if (!error?.message) {
    return undefined
  }
  const parsed = parseJson(error.message)
  return firstNumber(parsed?.status, parsed?.statusCode) ?? getPiErrorStatusCode(error.message)
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
  if (typeof parsed?.isRetryable === 'boolean') {
    return parsed.isRetryable
  }

  const status = getPiErrorStatusCode(error.message)
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429
    ? false
    : undefined
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
