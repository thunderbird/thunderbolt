import type { Context, ErrorHandler } from 'elysia'
import { Elysia } from 'elysia'

export type ErrorResponse = {
  success: false
  data: null
  error: string
}

export const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  500: 'An unexpected error occurred',
  502: 'Bad gateway',
  503: 'Service temporarily unavailable',
  504: 'Gateway timeout',
}

/**
 * Create a standardized error response object
 */
export const createErrorResponse = (message: string): ErrorResponse => ({
  success: false,
  data: null,
  error: message,
})

/**
 * Get a safe, generic error message for a given status code
 * SECURITY: Never returns internal error details - only predefined messages
 */
export const getSafeErrorMessage = (status: number): string => STATUS_MESSAGES[status] ?? 'An unexpected error occurred'

/**
 * Extract HTTP status code from an error, defaulting to 500
 */
export const getErrorStatus = (error: unknown, fallbackStatus: number = 500): number => {
  if (error instanceof Error && 'status' in error && typeof (error as any).status === 'number') {
    return (error as any).status
  }
  return fallbackStatus
}

/**
 * Reusable error handler for Elysia routes/plugins
 * SECURITY: Never exposes internal error details to clients
 *
 * Use this on any Elysia instance that defines routes:
 * ```ts
 * new Elysia().onError(safeErrorHandler).get('/route', ...)
 * ```
 */
export const safeErrorHandler: ErrorHandler = ({ code, error, set }) => {
  // Let Elysia handle validation errors with its default behavior (422 status)
  // These are user-facing and safe to expose
  if (code === 'VALIDATION') {
    return
  }

  // Let Elysia handle NOT_FOUND with its default behavior
  if (code === 'NOT_FOUND') {
    return
  }

  const currentStatus = typeof set.status === 'number' ? set.status : 500
  const status = getErrorStatus(error, currentStatus)
  set.status = status

  if (error instanceof Error) {
    console.error(`[${status}] ${error.message}`, error.stack)
  }

  return createErrorResponse(getSafeErrorMessage(status))
}

/**
 * Global error handling middleware for Elysia
 * NOTE: Due to Elysia's plugin architecture, this only handles errors
 * from routes defined directly on the main app, not from plugins.
 * Each plugin should use `safeErrorHandler` via `.onError(safeErrorHandler)`
 */
export const createErrorHandlingMiddleware = () => new Elysia({ name: 'error-handling' }).onError(safeErrorHandler)
