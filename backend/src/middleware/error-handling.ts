/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ErrorHandler } from 'elysia'
import { Elysia, InvertedStatusMap } from 'elysia'
import { DrizzleQueryError } from 'drizzle-orm/errors'

export type ErrorResponse = {
  success: false
  data: null
  error: string
}

type ErrorWithStatus = Error & { status: number }

const hasStatus = (error: Error): error is ErrorWithStatus => 'status' in error && typeof error.status === 'number'

/**
 * Create a standardized error response object
 */
export const createErrorResponse = (message: string): ErrorResponse => ({
  success: false,
  data: null,
  error: message,
})

/**
 * Get a safe, generic error message for a given status code.
 * SECURITY: Never returns internal error details - only standard HTTP reason phrases.
 */
export const getSafeErrorMessage = (status: number): string =>
  (InvertedStatusMap as Record<number, string>)[status] ?? 'An unexpected error occurred'

/**
 * Extract a log-safe message from an error, redacting PII.
 * DrizzleQueryError embeds parameter values (emails, etc.) in .message —
 * we use its structured .query property instead to keep only the parameterized SQL.
 */
export const getSafeLogMessage = (error: unknown): string => {
  if (error instanceof DrizzleQueryError) {
    return `Failed query: ${error.query}`
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/**
 * Extract HTTP status code from an error, defaulting to 500
 */
export const getErrorStatus = (error: unknown, fallbackStatus: number = 500): number => {
  if (error instanceof Error && hasStatus(error)) {
    return error.status
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
export const safeErrorHandler: ErrorHandler = ({ code, error, set, request }) => {
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

  const route = `${request.method} ${new URL(request.url).pathname}`
  console.error(`[${status}] ${route} — ${getSafeLogMessage(error)}`)
  if (error instanceof Error && !(error instanceof DrizzleQueryError) && error.stack) {
    console.error(error.stack)
  }
  if (error instanceof Error && error.cause != null) {
    const cause = error.cause
    if (cause instanceof Error) {
      console.error('Caused by:', cause.message)
      if (cause.stack) console.error(cause.stack)
    } else {
      console.error('Caused by:', cause)
    }
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
