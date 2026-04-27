/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setSyncEnabled } from '@/db/powersync'
import { clearAuthToken, clearDeviceId } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { handleFullWipe } from '@/services/encryption'

type ClearLocalDataOptions = {
  /** Disable PowerSync sync connection (default: true) */
  disableSync?: boolean
  /** Clear all encryption keys from IndexedDB + invalidate CK cache (default: true) */
  clearEncryptionKeys?: boolean
  /** Delete the database and app files via resetAppDir (default: true) */
  clearDatabase?: boolean
  /** Clear auth token and device ID from localStorage (default: true) */
  clearAuth?: boolean
}

/**
 * Clears local data in a consistent order. Each step is independent — failures
 * are logged but don't prevent subsequent steps from running.
 *
 * Does NOT reload the page or navigate — callers handle that.
 */
export const clearLocalData = async (options?: ClearLocalDataOptions): Promise<void> => {
  const { disableSync = true, clearEncryptionKeys = true, clearDatabase = true, clearAuth = true } = options ?? {}

  if (disableSync) {
    try {
      await setSyncEnabled(false)
    } catch (error) {
      console.error('[clearLocalData] Failed to disable sync:', error)
    }
  }

  if (clearEncryptionKeys) {
    try {
      await handleFullWipe()
    } catch (error) {
      console.error('[clearLocalData] Failed to clear encryption keys:', error)
    }
  }

  if (clearDatabase) {
    try {
      await resetAppDir()
    } catch (error) {
      console.error('[clearLocalData] Failed to reset app directory:', error)
    }
  }

  if (clearAuth) {
    clearAuthToken()
    clearDeviceId()
  }
}
