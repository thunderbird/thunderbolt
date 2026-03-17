import { eq, getTableColumns, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { encryptionConfig, type EncryptedTableName } from './config'
import { getShadowTable } from './shadow-tables'

/**
 * COALESCE(shadow.col, source.col) — prefers decoded value, falls back to encoded.
 * Uses .mapWith(sourceCol) to preserve JSON parsing and type mappings.
 */
export const decryptedCol = (shadowTable: SQLiteTable, sourceTable: SQLiteTable, column: string): SQL => {
  const shadowCols = getTableColumns(shadowTable)
  const sourceCols = getTableColumns(sourceTable)
  return sql`COALESCE(${shadowCols[column]}, ${sourceCols[column]})`.mapWith(sourceCols[column])
}

/**
 * LEFT JOIN condition: source.id = shadow.id
 * Handles tables where the PK Drizzle field name differs from 'id'
 * (e.g., settingsTable.key → DB column 'id', modelProfilesTable.modelId → DB column 'id').
 */
export const decryptedJoin = (sourceTable: SQLiteTable, shadowTable: SQLiteTable) => {
  const sourceCols = getTableColumns(sourceTable)
  const shadowCols = getTableColumns(shadowTable)
  const sourceIdCol = Object.values(sourceCols).find((col) => col.name === 'id')!
  return eq(sourceIdCol, shadowCols['id'])
}

/**
 * Non-empty check on a decrypted column: col IS NOT NULL AND trim(col) != ''
 */
export const decryptedNotEmpty = (shadowTable: SQLiteTable, sourceTable: SQLiteTable, column: string): SQL => {
  const shadowCols = getTableColumns(shadowTable)
  const sourceCols = getTableColumns(sourceTable)
  const col = sql`COALESCE(${shadowCols[column]}, ${sourceCols[column]})`
  return sql`${col} IS NOT NULL AND trim(${col}) != ''`
}

/**
 * Generates a full select object for a table where encrypted columns use COALESCE
 * and non-encrypted columns use direct references. Preserves JSON parsing via .mapWith().
 *
 * Usage: db.select(decryptedSelectFor('models')).from(modelsTable).leftJoin(...)
 */
export const decryptedSelectFor = (tableName: EncryptedTableName) => {
  const config = encryptionConfig[tableName]
  const shadow = getShadowTable(tableName)
  const sourceCols = getTableColumns(config.table)
  const shadowCols = getTableColumns(shadow)
  const encryptedSet = new Set(config.columns as readonly string[])

  return Object.fromEntries(
    Object.entries(sourceCols).map(([key, col]) => {
      if (encryptedSet.has(key)) {
        return [key, sql`COALESCE(${shadowCols[key]}, ${col})`.mapWith(col)]
      }
      return [key, col]
    }),
  )
}
