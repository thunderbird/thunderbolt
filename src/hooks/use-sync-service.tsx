/**
 * Hook for managing the sync service lifecycle and status
 */

import { useHttpClient } from '@/contexts'
import { getSyncService, initSyncService, type SyncStatus } from '@/db/sync-service'
import { DatabaseSingleton } from '@/db/singleton'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

/**
 * Mapping from database table names to React Query keys that should be invalidated
 * when that table changes from a sync operation
 */
const TABLE_TO_QUERY_KEYS: Record<string, string[][]> = {
  models: [['models']],
  tasks: [['tasks']],
  prompts: [['prompts'], ['triggers']],
  settings: [['settings']],
  chat_threads: [['chatThreads']],
  chat_messages: [['chatThreads']], // Messages affect thread display
  mcp_servers: [['mcp-servers']],
  triggers: [['triggers']],
}

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
  /** Required migration version if status is 'version_mismatch' */
  requiredVersion: string | null
}

/**
 * Hook for managing the sync service
 * Automatically initializes and starts the sync service when the app is ready
 */
export const useSyncService = (): UseSyncServiceResult => {
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [isRunning, setIsRunning] = useState(false)
  const [lastError, setLastError] = useState<Error | null>(null)
  const [requiredVersion, setRequiredVersion] = useState<string | null>(null)

  const isSupported = DatabaseSingleton.instance.isInitialized && DatabaseSingleton.instance.supportsSyncing

  /**
   * Invalidate React Query caches for tables that have changed
   */
  const invalidateQueriesForTables = useCallback(
    (tables: string[]) => {
      // Collect all query keys that need to be invalidated
      const queryKeysToInvalidate = new Set<string>()

      for (const table of tables) {
        const queryKeys = TABLE_TO_QUERY_KEYS[table]
        if (queryKeys) {
          for (const key of queryKeys) {
            queryKeysToInvalidate.add(JSON.stringify(key))
          }
        }
      }

      // Invalidate each unique query key
      for (const keyJson of queryKeysToInvalidate) {
        const queryKey = JSON.parse(keyJson) as string[]
        queryClient.invalidateQueries({ queryKey })
      }
    },
    [queryClient],
  )

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
      onTablesChanged: (tables) => {
        // Invalidate React Query caches for changed tables
        invalidateQueriesForTables(tables)
      },
      onVersionMismatch: (version) => {
        setRequiredVersion(version)
      },
    })

    service.start()
    setIsRunning(true)

    return () => {
      service.stop()
      setIsRunning(false)
    }
  }, [isSupported, httpClient, invalidateQueriesForTables])

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
    requiredVersion,
  }
}
