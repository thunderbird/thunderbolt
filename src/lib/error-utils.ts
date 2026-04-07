import type { HandleError, HandleErrorCode } from '@/types/handle-errors'

/** Check whether an error represents a rate-limit (HTTP 429) response. */
export const isRateLimitError = (error?: Error | null): boolean => {
  if (!error?.message) return false

  // DefaultChatTransport passes response.text() as the error message,
  // which is JSON like: {"error":"...","statusCode":429}
  try {
    const parsed = JSON.parse(error.message)
    if (parsed.statusCode === 429) return true
  } catch {
    // Not JSON — fall through to string matching
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
