import { getTableColumns } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { encryptionConfig, type EncryptedTableName } from './config'

/** Derives shadow table name: 'tasks' → 'tasks_decrypted' */
export const shadowTableName = (sourceTableName: string) => `${sourceTableName}_decrypted`

/**
 * Auto-generated shadow tables for all encrypted tables.
 * Each has: id (PK) + one text column per encrypted column.
 * DB column names match the source table's DB column names for consistency.
 */
export const shadowTables = Object.fromEntries(
  Object.entries(encryptionConfig).map(([key, config]) => {
    const srcName = getTableConfig(config.table).name
    const srcCols = getTableColumns(config.table) as Record<string, { name: string }>
    const columns = Object.fromEntries([
      ['id', text('id').primaryKey()],
      ...config.columns.map((fieldName) => {
        const dbName = srcCols[fieldName].name
        return [fieldName, text(dbName)]
      }),
    ])
    return [key, sqliteTable(shadowTableName(srcName), columns)]
  }),
) as Record<EncryptedTableName, ReturnType<typeof sqliteTable>>

/** Type-safe accessor for a specific shadow table */
export const getShadowTable = <K extends EncryptedTableName>(key: K) => shadowTables[key]
