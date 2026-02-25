import { getPowerSyncInstance } from '@/db/powersync'
import { type PowerSyncTableName, powersyncTableToQueryKeys } from '@shared/powersync-tables'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/** Maps PowerSync internal table names (with prefixes) back to base table names */
const toBaseTableName = (name: string): string => {
  if (name.startsWith('ps_data_local__')) return name.slice('ps_data_local__'.length)
  if (name.startsWith('ps_data__')) return name.slice('ps_data__'.length)
  return name
}

/**
 * Hook that watches PowerSync tables for changes and invalidates React Query cache.
 * Uses PowerSync's onChange (tablesUpdated) for batched notifications instead of
 * per-table watch queries.
 *
 * Enables automatic UI updates when data changes from:
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
 *
 * TODO: in the feature this hook should be removed and we should start using live queries from PowerSync for better performance.
 * See how to integrate useQuery (react-query) with drizzle and PowerSync.
 * A good ticket where this could be addressed is: https://linear.app/mozilla-thunderbolt/issue/THU-249/rearchitect-databaseinstancedb
 */
export const usePowerSyncInvalidation = (tables?: string[]) => {
  const queryClient = useQueryClient()

  useEffect(() => {
    const powerSync = getPowerSyncInstance()
    if (!powerSync) {
      return
    }

    const tablesToWatch = (tables ?? Object.keys(powersyncTableToQueryKeys)).filter(
      (t): t is PowerSyncTableName => t in powersyncTableToQueryKeys,
    )
    if (tablesToWatch.length === 0) return

    const dispose = powerSync.onChange(
      {
        onChange: (event) => {
          const changedBaseNames = new Set(event.changedTables.map(toBaseTableName))
          for (const tableName of changedBaseNames) {
            const queryKeys = powersyncTableToQueryKeys[tableName as PowerSyncTableName]
            if (!queryKeys) continue
            for (const queryKey of queryKeys) {
              queryClient.invalidateQueries({ queryKey })
            }
          }
        },
      },
      {
        tables: tablesToWatch,
        throttleMs: 50,
      },
    )

    return () => dispose()
  }, [queryClient, tables])
}
