/**
 * Hook for managing the sync service lifecycle and status
 */

import { useHttpClient } from '@/contexts'
import { getSyncService, initSyncService, type SyncStatus } from '@/db/sync-service'
import { DatabaseSingleton } from '@/db/singleton'
import { useCallback, useEffect, useState } from 'react'

export type UseSyncServiceResult = {
  /** Current sync status */
  status: SyncStatus
  /** Whether sync is supported (cr-sqlite database) */
  isSupported: boolean
  /** Whether the sync service is running */
  isRunning: boolean
  /** Force an immediate sync */
  forceSync: () => Promise<void>
  /** Start the sync service */
  start: () => void
  /** Stop the sync service */
  stop: () => void
  /** Last error if status is 'error' */
  lastError: Error | null
}

/**
 * Hook for managing the sync service
 * Automatically initializes and starts the sync service when the app is ready
 */
export const useSyncService = (): UseSyncServiceResult => {
  const httpClient = useHttpClient()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [isRunning, setIsRunning] = useState(false)
  const [lastError, setLastError] = useState<Error | null>(null)

  const isSupported = DatabaseSingleton.instance.isInitialized && DatabaseSingleton.instance.supportsSyncing

  // Initialize and start sync service
  useEffect(() => {
    if (!isSupported || !httpClient) {
      return
    }

    const service = initSyncService({
      httpClient,
      syncIntervalMs: 30000, // 30 seconds
      onStatusChange: (newStatus) => {
        setStatus(newStatus)
      },
      onError: (error) => {
        setLastError(error)
      },
    })

    service.start()
    setIsRunning(true)

    return () => {
      service.stop()
      setIsRunning(false)
    }
  }, [isSupported, httpClient])

  const forceSync = useCallback(async () => {
    const service = getSyncService()
    if (service) {
      await service.forceSync()
    }
  }, [])

  const start = useCallback(() => {
    const service = getSyncService()
    if (service) {
      service.start()
      setIsRunning(true)
    }
  }, [])

  const stop = useCallback(() => {
    const service = getSyncService()
    if (service) {
      service.stop()
      setIsRunning(false)
    }
  }, [])

  return {
    status,
    isSupported,
    isRunning,
    forceSync,
    start,
    stop,
    lastError,
  }
}
