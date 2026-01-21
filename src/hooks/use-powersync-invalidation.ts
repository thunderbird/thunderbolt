import { DatabaseSingleton } from '@/db/singleton'
import type { PowerSyncDatabase } from '@powersync/web'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/**
 * Map of table names to their React Query keys that should be invalidated.
 * When a table changes (local write or sync), all associated query keys are invalidated.
 */
const TABLE_TO_QUERY_KEYS: Record<string, string[][]> = {
  settings: [['settings']],
  chat_threads: [['threads'], ['thread']],
  chat_messages: [['messages'], ['messageCache']],
  tasks: [['tasks']],
  models: [['models']],
  mcp_servers: [['mcp-servers']],
  prompts: [['prompts'], ['automations']],
  triggers: [['triggers'], ['automations']],
}

/**
 * Get PowerSync instance from singleton if available.
 * Returns null if not using PowerSync or not initialized.
 */
const getPowerSyncInstance = (): PowerSyncDatabase | null => {
  try {
    const database = DatabaseSingleton.instance.database
    // Check if it's a PowerSync database with the powerSyncInstance getter
    if ('powerSyncInstance' in database) {
      return (database as { powerSyncInstance: PowerSyncDatabase | null }).powerSyncInstance
    }
  } catch {
    // Not initialized or not PowerSync
  }
  return null
}

/**
 * Hook that watches PowerSync tables for changes and invalidates React Query cache.
 * This enables automatic UI updates when data changes from:
 * - Local writes (immediately)
 * - Sync from cloud (when new data arrives)
 *
 * @param tables - Array of table names to watch (defaults to all synced tables)
 *
 * @example
 * ```tsx
 * // Watch all tables (use in a top-level provider)
 * usePowerSyncInvalidation()
 *
 * // Watch specific tables
 * usePowerSyncInvalidation(['settings', 'models'])
 * ```
 */
export const usePowerSyncInvalidation = (tables?: string[]) => {
  const queryClient = useQueryClient()

  useEffect(() => {
    const powerSync = getPowerSyncInstance()
    if (!powerSync) {
      // Not using PowerSync, nothing to watch
      return
    }

    const tablesToWatch = tables ?? Object.keys(TABLE_TO_QUERY_KEYS)
    const unsubscribes: (() => void)[] = []

    for (const tableName of tablesToWatch) {
      const queryKeys = TABLE_TO_QUERY_KEYS[tableName]
      if (!queryKeys) continue

      // Watch the table for any changes
      const abortController = new AbortController()

      // Use PowerSync's onChange to detect table changes
      const watchTable = async () => {
        try {
          // PowerSync watch returns an async iterator
          for await (const _ of powerSync.watch(`SELECT 1 FROM ${tableName} LIMIT 1`, [], {
            signal: abortController.signal,
          })) {
            // Table changed - invalidate all associated query keys
            for (const queryKey of queryKeys) {
              queryClient.invalidateQueries({ queryKey })
            }
          }
        } catch (error) {
          // Aborted or error - ignore
          if (!(error instanceof Error && error.name === 'AbortError')) {
            console.warn(`PowerSync watch error for ${tableName}:`, error)
          }
        }
      }

      watchTable()
      unsubscribes.push(() => abortController.abort())
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [queryClient, tables])
}
