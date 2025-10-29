export type InitErrorCode =
  | 'MIGRATION_FAILED'
  | 'DATABASE_INIT_FAILED'
  | 'RECONCILE_DEFAULTS_FAILED'
  | 'TRAY_INIT_FAILED'
  | 'POSTHOG_FETCH_FAILED'
  | 'APP_DIR_CREATION_FAILED'
  | 'DATABASE_PATH_FAILED'
  | 'UNKNOWN_ERROR'

export type InitError = {
  code: InitErrorCode
  message: string
  originalError?: unknown
}

export type InitResult<T> =
  | {
      success: true
      data: T
    }
  | {
      success: false
      error: InitError
    }
