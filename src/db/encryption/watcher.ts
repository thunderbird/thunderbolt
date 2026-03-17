import type { TriggerRemoveCallback } from '@powersync/common'
import { DiffTriggerOperation } from '@powersync/common'
import type { PowerSyncDatabase } from '@powersync/web'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig } from './config'
import { shadowTableName } from './shadow-tables'
import { codec } from './codec'

/**
 * Sets up trigger-based decryption watchers for ALL encrypted tables.
 * Returns a single cleanup function that tears down all watchers.
 */
export const setupDecryptionWatchers = async (powerSync: PowerSyncDatabase): Promise<TriggerRemoveCallback> => {
  const cleanups: TriggerRemoveCallback[] = []

  for (const config of Object.values(encryptionConfig)) {
    const srcTableName = getTableConfig(config.table).name
    const destTableName = shadowTableName(srcTableName)
    const columns = config.columns as readonly string[]

    const columnList = ['id', ...columns].join(', ')
    const placeholders = ['id', ...columns].map(() => '?').join(', ')

    const decodeRow = (row: Record<string, string | null>) =>
      columns.map((col) => {
        const val = row[col]
        return val ? codec.decode(val) : val
      })

    const cleanup = await powerSync.triggers.trackTableDiff({
      source: srcTableName,
      columns: [...columns],
      when: {
        [DiffTriggerOperation.INSERT]: 'TRUE',
        [DiffTriggerOperation.UPDATE]: 'TRUE',
        [DiffTriggerOperation.DELETE]: 'TRUE',
      },
      hooks: {
        beforeCreate: async (ctx) => {
          const existing = await ctx.getAll<Record<string, string | null>>(`SELECT ${columnList} FROM ${srcTableName}`)
          for (const row of existing) {
            await ctx.execute(`INSERT OR REPLACE INTO ${destTableName} (${columnList}) VALUES (${placeholders})`, [
              row.id,
              ...decodeRow(row),
            ])
          }
        },
      },
      onChange: async (context) => {
        type DiffRow = Record<string, string | null> & { __operation: string }
        const diffs = await context.withExtractedDiff<DiffRow>('SELECT * FROM DIFF')

        for (const diff of diffs) {
          if (diff.__operation === DiffTriggerOperation.DELETE) {
            await context.execute(`DELETE FROM ${destTableName} WHERE id = ?`, [diff.id])
          } else {
            await context.execute(`INSERT OR REPLACE INTO ${destTableName} (${columnList}) VALUES (${placeholders})`, [
              diff.id,
              ...decodeRow(diff),
            ])
          }
        }
      },
    })

    cleanups.push(cleanup)
  }

  return async () => {
    for (const cleanup of cleanups) {
      await cleanup()
    }
  }
}
