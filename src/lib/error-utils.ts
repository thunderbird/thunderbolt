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
 * Markers that identify an endpoint rejecting the *shape* of a message's content
 * — typically a file/image part a text-only (OpenAI-compat) gateway can't carry.
 * Distinct from auth/rate-limit/server errors, which retrying the same bytes
 * can't fix. Kept conservative so generic 4xx errors fall through to the manual
 * retry path rather than triggering automatic attachment remediation.
 */
const contentRejectionMarkers = [
  'content.str',
  'should be a valid string',
  'invalid content',
  'image_url',
  'could not process image',
  'unsupported file',
  'unsupported document',
  'unsupported media type',
  'unable to process',
]

/**
 * Check whether an error represents the endpoint rejecting an attachment's
 * native content (so it should be re-delivered as text/images), as opposed to a
 * transient or auth failure. Drives automatic attachment remediation.
 */
export const isContentRejectionError = (error?: Error | null): boolean => {
  if (!error?.message) {
    return false
  }

  const parsed = parseJson(error.message)
  const status =
    typeof parsed?.status === 'number'
      ? parsed.status
      : typeof parsed?.statusCode === 'number'
        ? parsed.statusCode
        : undefined
  // A status that's present and not a content-shape 4xx rules out remediation.
  if (status !== undefined && status !== 400 && status !== 422) {
    return false
  }

  const message = (typeof parsed?.error === 'string' ? parsed.error : error.message).toLowerCase()
  return contentRejectionMarkers.some((marker) => message.includes(marker))
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
