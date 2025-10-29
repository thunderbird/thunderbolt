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
