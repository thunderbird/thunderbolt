/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPowerSyncInstance } from '@/db/powersync'
import type { SyncStatus } from '@powersync/web'
import { useSyncExternalStore } from 'react'

export type PowerSyncConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'not-configured'

export type PowerSyncStatusInfo = {
  /** Whether PowerSync is being used */
  isPowerSync: boolean
  /** Connection status */
  connectionStatus: PowerSyncConnectionStatus
  /** Whether currently uploading local changes */
  isUploading: boolean
  /** Whether currently downloading from cloud */
  isDownloading: boolean
  /** Whether initial sync has completed */
  hasSynced: boolean
  /** Last sync timestamp */
  lastSyncedAt: Date | null
}

const defaultStatus: PowerSyncStatusInfo = {
  isPowerSync: false,
  connectionStatus: 'not-configured',
  isUploading: false,
  isDownloading: false,
  hasSynced: false,
  lastSyncedAt: null,
}

const mapSyncStatus = (syncStatus: SyncStatus): PowerSyncStatusInfo => {
  const connected = syncStatus.connected
  const connecting = syncStatus.connecting

  let connectionStatus: PowerSyncConnectionStatus = 'disconnected'
  if (connected) {
    connectionStatus = 'connected'
  } else if (connecting) {
    connectionStatus = 'connecting'
  }

  return {
    isPowerSync: true,
    connectionStatus,
    isUploading: syncStatus.dataFlowStatus?.uploading ?? false,
    isDownloading: syncStatus.dataFlowStatus?.downloading ?? false,
    hasSynced: syncStatus.hasSynced ?? false,
    lastSyncedAt: syncStatus.lastSyncedAt ? new Date(syncStatus.lastSyncedAt) : null,
  }
}

/** Cached snapshot for referential stability required by useSyncExternalStore */
let cachedSnapshot: PowerSyncStatusInfo = defaultStatus

const subscribe = (callback: () => void) => {
  const powerSync = getPowerSyncInstance()
  if (!powerSync) {
    cachedSnapshot = defaultStatus
    return () => {}
  }

  // Set initial snapshot
  const currentStatus = powerSync.currentStatus
  cachedSnapshot = currentStatus ? mapSyncStatus(currentStatus) : { ...defaultStatus, isPowerSync: true }

  // Listen for changes
  const unsubscribe = powerSync.registerListener({
    statusChanged: (syncStatus: SyncStatus) => {
      cachedSnapshot = mapSyncStatus(syncStatus)
      callback()
    },
  })

  return () => {
    unsubscribe?.()
  }
}

const getSnapshot = () => cachedSnapshot

/**
 * Hook that provides PowerSync connection and sync status.
 * Returns status info that can be used to show sync indicators in the UI.
 *
 * @example
 * ```tsx
 * const { connectionStatus, isUploading, isDownloading } = usePowerSyncStatus()
 *
 * if (connectionStatus === 'connected' && !isUploading && !isDownloading) {
 *   return <CheckIcon /> // All synced
 * }
 * ```
 */
export const usePowerSyncStatus = (): PowerSyncStatusInfo => {
  return useSyncExternalStore(subscribe, getSnapshot)
}
