import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { DatabaseSingleton } from '@/db/singleton'

/**
 * Maps PowerSync table names to React Query cache keys.
 * When PowerSync detects changes in a table, we invalidate the corresponding queries.
 */
const TABLE_TO_QUERY_KEYS: Record<string, string[]> = {
  settings: ['settings'],
  chat_threads: ['chatThreads', 'chat-threads'],
  chat_messages: ['chatMessages', 'chat-messages', 'messageCache'],
  tasks: ['tasks'],
  models: ['models'],
  mcp_servers: ['mcp-servers', 'mcpServers'],
  prompts: ['prompts'],
  triggers: ['triggers', 'automations'],
}

/**
 * Hook that listens to PowerSync table changes and invalidates
 * the corresponding React Query caches for real-time UI updates.
 *
 * This ensures that when data syncs from another device or the backend,
 * the UI automatically refreshes to show the latest data.
 */
export const usePowerSyncQuerySync = () => {
  const queryClient = useQueryClient()
  const powerSyncDb = DatabaseSingleton.instance.powerSyncDatabase

  useEffect(() => {
    if (!powerSyncDb) {
      return
    }

    const unsubscribe = powerSyncDb.powerSync.onChange({
      onChange: (event) => {
        if (!event.changedTables?.length) {
          return
        }

        for (const tableName of event.changedTables) {
          const queryKeys = TABLE_TO_QUERY_KEYS[tableName]
          if (queryKeys) {
            for (const key of queryKeys) {
              queryClient.invalidateQueries({ queryKey: [key] })
            }
          }
        }
      },
    })

    return () => {
      unsubscribe()
    }
  }, [powerSyncDb, queryClient])
}
