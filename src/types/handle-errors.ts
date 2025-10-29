export type HandleErrorCode =
  | 'MIGRATION_FAILED'
  | 'DATABASE_INIT_FAILED'
  | 'RECONCILE_DEFAULTS_FAILED'
  | 'TRAY_INIT_FAILED'
  | 'POSTHOG_FETCH_FAILED'
  | 'APP_DIR_CREATION_FAILED'
  | 'DATABASE_PATH_FAILED'
  | 'UNKNOWN_ERROR'

export type HandleError = {
  code: HandleErrorCode
  message: string
  originalError?: unknown
  stackTrace?: string
}

export type HandleResult<T> =
  | {
      success: true
      data: T
    }
  | {
      success: false
      error: HandleError
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
