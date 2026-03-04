import { getPowerSyncInstance } from '@/db/powersync'
import { mostRecentDate } from '@/lib/utils'
import type { SyncStatus } from '@powersync/web'
import { useEffect, useRef, useState } from 'react'

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

/**
 * Hook that provides PowerSync connection and sync status.
 * Returns status info that can be used to show sync indicators in the UI.
 *
 * Tracks its own lastSyncedAt timestamp by detecting when downloads complete
 * (downloading transitions from true → false), since PowerSync's native
 * lastSyncedAt only updates on full checkpoint syncs and can appear stale
 * during incremental sync activity.
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
  const [status, setStatus] = useState<PowerSyncStatusInfo>({
    isPowerSync: false,
    connectionStatus: 'not-configured',
    isUploading: false,
    isDownloading: false,
    hasSynced: false,
    lastSyncedAt: null,
  })

  const wasDownloadingRef = useRef(false)
  const localLastSyncedRef = useRef<Date | null>(null)

  useEffect(() => {
    const powerSync = getPowerSyncInstance()

    if (!powerSync) {
      setStatus({
        isPowerSync: false,
        connectionStatus: 'not-configured',
        isUploading: false,
        isDownloading: false,
        hasSynced: false,
        lastSyncedAt: null,
      })
      return
    }

    const updateStatus = (syncStatus: SyncStatus) => {
      const connected = syncStatus.connected
      const connecting = syncStatus.connecting
      const isDownloading = syncStatus.dataFlowStatus?.downloading ?? false

      let connectionStatus: PowerSyncConnectionStatus = 'disconnected'
      if (connected) {
        connectionStatus = 'connected'
      } else if (connecting) {
        connectionStatus = 'connecting'
      }

      // Track when a download completes (was downloading → no longer downloading)
      if (wasDownloadingRef.current && !isDownloading) {
        localLastSyncedRef.current = new Date()
      }
      wasDownloadingRef.current = isDownloading

      const powerSyncLastSynced = syncStatus.lastSyncedAt ? new Date(syncStatus.lastSyncedAt) : null
      const lastSyncedAt = mostRecentDate(powerSyncLastSynced, localLastSyncedRef.current)

      setStatus({
        isPowerSync: true,
        connectionStatus,
        isUploading: syncStatus.dataFlowStatus?.uploading ?? false,
        isDownloading,
        hasSynced: syncStatus.hasSynced ?? false,
        lastSyncedAt,
      })
    }

    // Set initial status
    const currentStatus = powerSync.currentStatus
    if (currentStatus) {
      updateStatus(currentStatus)
    } else {
      setStatus((prev) => ({ ...prev, isPowerSync: true }))
    }

    // Listen for status changes
    const unsubscribe = powerSync.registerListener({
      statusChanged: updateStatus,
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  return status
}
