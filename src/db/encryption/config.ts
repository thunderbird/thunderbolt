import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { tasksTable } from '../tables'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySQLiteTable = SQLiteTableWithColumns<any>

type EncryptedTableConfig<T extends AnySQLiteTable> = {
  table: T
  columns: readonly (keyof T['$inferSelect'] & string)[]
}

/** Type-safe helper — validates column names against the table's schema at compile time. */
const defineEncrypted = <T extends AnySQLiteTable>(config: EncryptedTableConfig<T>): EncryptedTableConfig<T> => config

/**
 * Single source of truth for all encrypted tables and their columns.
 * Adding a new entry here automatically generates:
 * - Shadow table (local-only, stores decoded values)
 * - Trigger-based decryption watcher
 * - CRUD upload encoding
 * - PowerSync schema registration
 */
export const encryptionConfig = {
  tasks: defineEncrypted({ table: tasksTable, columns: ['item'] }),
} as const

export type EncryptionConfig = typeof encryptionConfig
export type EncryptedTableName = keyof EncryptionConfig
