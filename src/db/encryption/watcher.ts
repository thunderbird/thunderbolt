import type { TriggerRemoveCallback } from '@powersync/common'
import { DiffTriggerOperation } from '@powersync/common'
import type { PowerSyncDatabase } from '@powersync/web'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig } from './config'
import { shadowTableName } from './shadow-tables'
import { codec } from './codec'
import { isEncryptionEnabled } from './enabled'

/**
 * Sets up trigger-based decryption watchers for ALL encrypted tables.
 * Returns a single cleanup function that tears down all watchers.
 * No-op when encryption is disabled — shadow tables stay empty,
 * and DAL COALESCE queries naturally fall back to source columns.
 */
export const setupDecryptionWatchers = async (powerSync: PowerSyncDatabase): Promise<TriggerRemoveCallback> => {
  if (!isEncryptionEnabled()) {
    return async () => {}
  }

  const cleanups: TriggerRemoveCallback[] = []

  for (const config of Object.values(encryptionConfig)) {
    const srcTableName = getTableConfig(config.table).name
    const destTableName = shadowTableName(srcTableName)
    const fieldNames = config.columns as readonly string[]

    // Map Drizzle field names to DB column names for raw SQL
    const srcCols = getTableColumns(config.table) as Record<string, { name: string }>
    const dbNames = fieldNames.map((f) => srcCols[f].name)

    // Source table uses DB column names in SQL
    const srcColumnList = ['id', ...dbNames].join(', ')
    // Shadow table uses the same DB column names (matched in shadow-tables.ts)
    const destColumnList = srcColumnList
    const placeholders = ['id', ...dbNames].map(() => '?').join(', ')

    const decodeRow = (row: Record<string, string | null>) =>
      dbNames.map((dbName) => {
        const val = row[dbName]
        return val ? codec.decode(val) : val
      })

    const cleanup = await powerSync.triggers.trackTableDiff({
      source: srcTableName,
      columns: [...dbNames],
      when: {
        [DiffTriggerOperation.INSERT]: 'TRUE',
        [DiffTriggerOperation.UPDATE]: 'TRUE',
        [DiffTriggerOperation.DELETE]: 'TRUE',
      },
      hooks: {
        beforeCreate: async (ctx) => {
          const existing = await ctx.getAll<Record<string, string | null>>(
            `SELECT ${srcColumnList} FROM ${srcTableName}`,
          )
          for (const row of existing) {
            await ctx.execute(`INSERT OR REPLACE INTO ${destTableName} (${destColumnList}) VALUES (${placeholders})`, [
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
            await context.execute(
              `INSERT OR REPLACE INTO ${destTableName} (${destColumnList}) VALUES (${placeholders})`,
              [diff.id, ...decodeRow(diff)],
            )
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
