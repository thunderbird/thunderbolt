/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { disposeAllAdapters } from '@/acp/adapter-cache'
import { clearIrohClientSecret } from '@/acp/iroh/iroh-transport'
import { setSyncEnabled } from '@/db/powersync/sync-state'
import { clearActiveLocale } from '@/i18n/active-locale'
import { clearAuthToken, clearDeviceId, clearUserCacheSecret } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { clearCachedSession } from '@/lib/session-cache'
import { handleFullWipe } from '@/services/encryption'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'

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

  // Tear down every warm ACP connection first so no agent transport survives
  // across user identities (sign-out, account deletion, device revocation all
  // funnel through here).
  try {
    await disposeAllAdapters()
  } catch (error) {
    console.error('[clearLocalData] Failed to dispose ACP adapters:', error)
  }

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

    // Reset local settings to defaults (previously these lived in the DB and were deleted with it)
    useLocalSettingsStore.setState(initialLocalSettings)
    // Same reasoning for the locale mirror: it caches the synced `language` row, so
    // with the database gone it would boot the next identity in this account's
    // language. Tied to the database rather than to `clearAuth` because a caller
    // that keeps the database keeps the row the mirror agrees with.
    clearActiveLocale()
  }

  if (clearAuth) {
    clearAuthToken()
    clearDeviceId()
    clearUserCacheSecret()
    // The iroh client secret is the bridge access credential (plaintext localStorage),
    // so it must be wiped with the other local creds on every identity teardown.
    clearIrohClientSecret()
    clearCachedSession()
  }
}
