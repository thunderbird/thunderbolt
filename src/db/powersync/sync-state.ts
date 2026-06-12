/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * SDK-free access to the PowerSync singleton and sync preferences.
 *
 * This module is imported statically from entry-bundle code (app.tsx, hooks,
 * contexts), so it must never import `@powersync/web`/`@powersync/common` at
 * runtime — only as types. The actual SDK loads via the dynamic
 * `import('./powersync')` in `src/db/database.ts`; this module reaches the
 * instance through the database registry in `../database`.
 */

import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { withTimeout } from '@/lib/timeout'
import type { PowerSyncDatabase } from '@powersync/web'
import { getDatabaseInstance } from '../database'

/** Custom event name for sync enabled changes */
export const syncEnabledChangeEvent = 'powersync_sync_enabled_change'

/**
 * Get PowerSync instance from singleton if available.
 * Returns null if not using PowerSync or not initialized.
 */
export const getPowerSyncInstance = (): PowerSyncDatabase | null => {
  try {
    const database = getDatabaseInstance()
    // PowerSyncDatabaseImpl exposes powerSyncInstance as a typed getter, but getDatabaseInstance()
    // returns the DatabaseInterface union which doesn't include PowerSync-specific properties.
    if ('powerSyncInstance' in database) {
      return (database as { powerSyncInstance: PowerSyncDatabase | null }).powerSyncInstance
    }
  } catch {
    // Not initialized or not PowerSync
  }
  return null
}

/**
 * Force a disconnect + reconnect cycle via the singleton database.
 * Guarded against concurrent attempts — no-ops if a reconnect is already in-flight.
 */
export const reconnectSync = async (): Promise<void> => {
  try {
    const database = getDatabaseInstance()
    if ('reconnect' in database) {
      await (database as { reconnect: () => Promise<void> }).reconnect()
    }
  } catch (error) {
    console.warn('Failed to reconnect PowerSync:', error)
  }
}

/**
 * Check if sync is enabled by user preference
 */
export const isSyncEnabled = (): boolean => getLocalSetting('syncEnabled')

/**
 * Set sync enabled preference, connect/disconnect from PowerSync, and dispatch change event
 */
export const setSyncEnabled = async (enabled: boolean): Promise<void> => {
  // Update store and dispatch event
  useLocalSettingsStore.getState().setLocalSetting('syncEnabled', enabled)
  window.dispatchEvent(new CustomEvent(syncEnabledChangeEvent, { detail: enabled }))

  // Connect or disconnect from PowerSync Cloud
  try {
    const database = getDatabaseInstance()
    if ('connectToSync' in database && 'disconnectFromSync' in database) {
      if (enabled) {
        await (database as { connectToSync: () => Promise<void> }).connectToSync()
      } else {
        await withTimeout(
          (database as { disconnectFromSync: () => Promise<void> }).disconnectFromSync(),
          10_000,
          'disconnectFromSync',
        )
      }
    }
  } catch (error) {
    console.error('Failed to connect/disconnect from PowerSync:', error)
  }
}
