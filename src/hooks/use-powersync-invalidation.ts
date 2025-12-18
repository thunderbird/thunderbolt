import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { DatabaseSingleton } from '@/db/singleton'

/**
 * Maps PowerSync table names to React Query cache keys that should be invalidated.
 * Add entries here as you add more tables/queries.
 */
const TABLE_TO_QUERY_KEYS: Record<string, string[][]> = {
  settings: [['settings']],
  chat_threads: [['chatThreads'], ['chat-threads']],
  chat_messages: [['chatMessages'], ['chat-messages'], ['messageCache']],
  tasks: [['tasks']],
  models: [['models']],
  mcp_servers: [['mcp-servers'], ['mcpServers']],
  prompts: [['prompts']],
  triggers: [['triggers'], ['automations']],
}

/**
 * Hook that listens to PowerSync sync events and invalidates
 * the corresponding React Query caches for real-time UI updates.
 *
 * This allows you to keep using your existing DAL + React Query setup
 * while getting real-time updates when PowerSync syncs data.
 *
 * How it works:
 * 1. PowerSync syncs data from backend/other devices
 * 2. PowerSync fires onChange events with list of changed tables
 * 3. This hook maps table names to React Query keys
 * 4. Invalidates those queries, causing React Query to refetch
 * 5. UI updates with fresh data
 */
export const usePowerSyncInvalidation = () => {
  const queryClient = useQueryClient()
  const powerSyncDb = DatabaseSingleton.instance.powerSyncDatabase

  useEffect(() => {
    // Only subscribe if PowerSync is being used
    if (!powerSyncDb) {
      return
    }

    // Subscribe to PowerSync changes
    const unsubscribe = powerSyncDb.powerSync.onChange({
      onChange: (event) => {
        if (!event.changedTables?.length) {
          return
        }

        console.log('event.changedTables', event.changedTables)

        // Invalidate React Query caches for changed tables
        for (const tableName of event.changedTables) {
          const queryKeys = TABLE_TO_QUERY_KEYS[tableName]
          if (queryKeys) {
            for (const queryKey of queryKeys) {
              queryClient.invalidateQueries({ queryKey })
            }
          }
        }
      },
    })

    return unsubscribe
  }, [powerSyncDb, queryClient])
}
