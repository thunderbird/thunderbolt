import type { Context, ErrorHandler } from 'elysia'
import { Elysia } from 'elysia'

interface ErrorContext extends Context {
  log?: {
    warn: (data: object, message: string) => void
    error: (data: object, message: string) => void
  }
}

interface ErrorResponse {
  success: false
  data: null
  error: string
}

/**
 * Global error handling middleware for Elysia
 * Provides consistent error responses and logging
 * Returns format: { success: false, data: null, error: string }
 */
export const createErrorHandlingMiddleware = () => {
  const errorHandler: ErrorHandler = (ctx) => {
    const { code, error, set, request } = ctx
    const log = (ctx as any).log

    switch (code) {
      case 'VALIDATION':
        set.status = 400
        log?.warn({ error: error.message }, 'Validation failed')
        return createErrorResponse(`Validation failed: ${error.message}`)

      case 'NOT_FOUND':
        set.status = 404
        log?.warn({ url: request.url }, 'Resource not found')
        return createErrorResponse('The requested resource was not found')

      default:
        return handleGenericError(error, set, log)
    }
  }

  return new Elysia({ name: 'error-handling' }).onError(errorHandler)
}

/**
 * Handle generic errors with appropriate status codes and logging
 */
function handleGenericError(error: unknown, set: Context['set'], log?: any): ErrorResponse {
  if (error instanceof Error) {
    const status = (error as any).status || set.status || 500
    set.status = status

    switch (status) {
      case 503:
        log?.error({ error: error.message, stack: error.stack }, 'Service unavailable')
        return createErrorResponse(`Service unavailable: ${error.message}`)

      case 401:
        log?.warn({ error: error.message }, 'Unauthorized request')
        return createErrorResponse(`Unauthorized: ${error.message}`)

      case 400:
        log?.warn({ error: error.message }, 'Bad request')
        return createErrorResponse(`Bad request: ${error.message}`)

      default:
        log?.error({ error: error.message, stack: error.stack }, 'Unhandled request error')
        break
    }
  } else {
    log?.error({ error }, 'Non-Error exception thrown')
  }

  set.status = 500
  return createErrorResponse(error instanceof Error ? error.message : 'An unexpected error occurred')
}

/**
 * Create a standardized error response object
 */
function createErrorResponse(error: string): ErrorResponse {
  return {
    success: false,
    data: null,
    error,
  }
}
