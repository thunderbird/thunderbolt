/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { disposeAllAdapters } from '@/acp/adapter-cache'
import { clearImageSupportCache } from '@/ai/image-support'
import { clearIrohClientSecret } from '@/acp/iroh/iroh-transport'
import { setSyncEnabled } from '@/db/powersync/sync-state'
import { supportsKeyStoreLock, withKeyStoreLock, type KeyStoreLock } from '@/crypto/key-store-lock'
import { invalidateEncryptionOperations } from '@/crypto/key-storage-lifetime'
import { clearActiveLocale } from '@/i18n/active-locale'
import { clearAuthToken, clearDeviceId, clearUserCacheSecret, invalidateAuthRequests } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { clearIdentityScopedMemory } from '@/lib/identity-memory'
import { clearCachedSession } from '@/lib/session-cache'
import { handleFullWipe } from '@/services/encryption'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { useSearchProviderStore } from '@/stores/search-provider-store'

type ClearLocalDataOptions = {
  /** Disable PowerSync sync connection (default: true) */
  disableSync?: boolean
  /** Clear all encryption keys from IndexedDB + invalidate CK cache (default: true) */
  clearEncryptionKeys?: boolean
  /** Delete the database, app files, attachments and all web storage (default: true) */
  clearDatabase?: boolean
  /** Clear auth token and device ID from localStorage (default: true). `clearDatabase` clears them anyway. */
  clearAuth?: boolean
  /**
   * With `clearAuth`, keep the bearer token and cached session: another account just signed in and
   * only the previous owner's device credentials and its database caches must go (default: false).
   */
  keepSession?: boolean
}

/** Receives each failed step as an Error whose message names the step and whose `cause` is what it threw. */
type ReportFailure = (failure: Error) => void

const logFailure: ReportFailure = (failure) => console.error(`[clearLocalData] ${failure.message}:`, failure.cause)

/**
 * Clears local data in a consistent order. Each step is independent — failures
 * are logged but don't prevent subsequent steps from running.
 *
 * Does NOT reload the page or navigate — callers handle that.
 */
export const clearLocalData = (options?: ClearLocalDataOptions): Promise<void> => runClearLocalData(options, logFailure)

/** {@link clearLocalData} for callers that must not continue after a partial cleanup: rejects once every step ran. */
export const clearLocalDataOrThrow = async (options?: ClearLocalDataOptions): Promise<void> => {
  const failures: Error[] = []
  await runClearLocalData(options, (failure) => {
    logFailure(failure)
    failures.push(failure)
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clear local data')
  }
}

const runClearLocalData = (options: ClearLocalDataOptions | undefined, report: ReportFailure): Promise<void> => {
  invalidateAuthRequests()
  if (options?.clearEncryptionKeys !== false) {
    invalidateEncryptionOperations()
  }
  clearIdentityScopedMemory()
  // Keep other tabs' key writers waiting until keys AND the old identity are gone.
  return supportsKeyStoreLock()
    ? withKeyStoreLock((lock) => clearLocalDataLocked(options, report, lock))
    : clearLocalDataLocked(options, report)
}

const clearLocalDataLocked = async (
  options: ClearLocalDataOptions | undefined,
  report: ReportFailure,
  lock?: KeyStoreLock,
): Promise<void> => {
  const {
    disableSync = true,
    clearEncryptionKeys = true,
    clearDatabase = true,
    clearAuth = true,
    keepSession = false,
  } = options ?? {}

  // Tear down every warm ACP connection first so no agent transport survives
  // across user identities (sign-out, account deletion, device revocation all
  // funnel through here).
  try {
    await disposeAllAdapters()
  } catch (error) {
    report(new Error('Failed to dispose ACP adapters', { cause: error }))
  }

  try {
    const { clearPageIdentity } = await import('@/pages/identity-lifecycle')
    await clearPageIdentity(clearAuth || clearDatabase)
  } catch (error) {
    report(new Error('Failed to close pages and local previews', { cause: error }))
  }

  if (disableSync) {
    try {
      await setSyncEnabled(false)
    } catch (error) {
      report(new Error('Failed to disable sync', { cause: error }))
    }
  }

  if (clearEncryptionKeys) {
    try {
      await handleFullWipe(lock)
    } catch (error) {
      report(new Error('Failed to clear encryption keys', { cause: error }))
    }
  }

  if (clearDatabase) {
    // Deletes every slot's attachment store too (see `appIndexedDbNames`).
    try {
      await resetAppDir()
    } catch (error) {
      report(new Error('Failed to reset app directory', { cause: error }))
    }

    // Reset local settings to defaults (previously these lived in the DB and were deleted with it)
    useLocalSettingsStore.setState(initialLocalSettings)
  }

  // What is tied to the database goes with it. A switch (`keepSession`) keeps the session but opens
  // another account's database. The locale mirror caches the synced `language` row, so it would boot
  // the next account in this account's language. Image-support results and the search selection
  // describe connections and models in this account's database.
  if (clearDatabase || keepSession) {
    useSearchProviderStore.getState().clearSearchProvider()
    clearActiveLocale()
    clearImageSupportCache()
  }

  if (clearAuth) {
    if (!keepSession) {
      clearAuthToken()
      clearCachedSession()
    }
    clearDeviceId()
    clearUserCacheSecret()
    // The iroh client secret is the bridge access credential (plaintext localStorage),
    // so it must be wiped with the other local creds on every identity teardown.
    clearIrohClientSecret()
  }

  // Everything else in web storage — OAuth flow state, banners, in-flight markers — so
  // the next load starts as a first visit. Last on purpose: other tabs learn about a
  // sign-out from the keyed token removal above, and a blanket clear() sends them only
  // an unkeyed event they ignore.
  if (clearDatabase) {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch (error) {
      report(new Error('Failed to clear web storage', { cause: error }))
    }
  }
}
