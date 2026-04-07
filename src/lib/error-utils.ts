import type { HandleError, HandleErrorCode } from '@/types/handle-errors'

/** Check whether an error represents a rate-limit (HTTP 429) response. */
export const isRateLimitError = (error?: Error | null) => error?.message?.toLowerCase().includes('too many requests')

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
