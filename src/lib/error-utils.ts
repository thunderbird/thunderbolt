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
