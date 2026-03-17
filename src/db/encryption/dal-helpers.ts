import { eq, getTableColumns, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

/**
 * COALESCE(shadow.col, source.col) — prefers decoded value, falls back to encoded.
 */
export const decryptedCol = (shadowTable: SQLiteTable, sourceTable: SQLiteTable, column: string): SQL<string> => {
  const shadowCols = getTableColumns(shadowTable)
  const sourceCols = getTableColumns(sourceTable)
  return sql<string>`COALESCE(${shadowCols[column]}, ${sourceCols[column]})`
}

/**
 * LEFT JOIN condition: source.id = shadow.id
 */
export const decryptedJoin = (sourceTable: SQLiteTable, shadowTable: SQLiteTable) => {
  const sourceCols = getTableColumns(sourceTable)
  const shadowCols = getTableColumns(shadowTable)
  return eq(sourceCols['id'], shadowCols['id'])
}

/**
 * Non-empty check on a decrypted column: col IS NOT NULL AND trim(col) != ''
 */
export const decryptedNotEmpty = (shadowTable: SQLiteTable, sourceTable: SQLiteTable, column: string): SQL => {
  const col = decryptedCol(shadowTable, sourceTable, column)
  return sql`${col} IS NOT NULL AND trim(${col}) != ''`
}
