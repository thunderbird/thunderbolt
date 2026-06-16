/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type HandleErrorCode =
  | 'MIGRATION_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'DATABASE_INIT_FAILED'
  | 'RECONCILE_DEFAULTS_FAILED'
  | 'TRAY_INIT_FAILED'
  | 'POSTHOG_FETCH_FAILED'
  | 'APP_DIR_CREATION_FAILED'
  | 'DATABASE_PATH_FAILED'
  | 'HTTP_CLIENT_INIT_FAILED'
  | 'CANARY_EXTRACTION_FAILED'
  | 'SYNC_ENABLE_FAILED'
  | 'NO_TRUST_DOMAIN'
  | 'CONFIG_FETCH_FAILED'
  | 'STANDALONE_NOT_SUPPORTED'
  | 'NO_ACTIVE_USER'
  | 'PERSONAL_WORKSPACE_UNAVAILABLE'
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
