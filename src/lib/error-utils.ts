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
 * True for a 4xx client error (excluding 429, handled as a rate limit). Such an
 * error won't succeed by retrying identical input — unlike a transient 5xx or
 * network failure. Drives two things: skipping the generic auto-retry loop, and
 * triggering attachment remediation (a 4xx on a turn carrying a file is the file
 * being rejected — the caller pairs this with an attachment check).
 */
export const isNonRetryableClientError = (error?: Error | null): boolean => {
  if (isRateLimitError(error)) {
    return false
  }
  const status = getErrorStatusCode(error)
  return status !== undefined && status >= 400 && status < 500
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
