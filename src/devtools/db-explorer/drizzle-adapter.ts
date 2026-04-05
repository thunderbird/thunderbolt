import { sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { ColumnInfo, DbObject, QueryResult, SqliteExplorerAdapter } from './types'

const tempViewName = '__db_explorer_temp'

/** Escape a SQLite identifier (table/view name) */
const escapeId = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** Check if a SQL string is a SELECT-like statement (safe to create a view from) */
const isSelectStatement = (query: string): boolean => {
  const trimmed = query.trim().toUpperCase()
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')
}

/**
 * Read a value from a row that may be a positional array or a keyed object.
 * PowerSync returns objects, wa-sqlite returns arrays.
 */
const readRow = (row: unknown, index: number, key: string): unknown => {
  if (Array.isArray(row)) {
    return row[index]
  }
  if (row && typeof row === 'object') {
    return (row as Record<string, unknown>)[key]
  }
  return undefined
}

/**
 * Convert a row (object or array) to a positional array using the given column keys.
 */
const rowToArray = (row: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(row)) {
    return row
  }
  if (row && typeof row === 'object') {
    return keys.map((k) => (row as Record<string, unknown>)[k])
  }
  return []
}

/**
 * Parse PRAGMA table_info results.
 * PRAGMA table_info returns columns: cid, name, type, notnull, dflt_value, pk
 */
const parsePragmaRow = (row: unknown): ColumnInfo => ({
  name: String(readRow(row, 1, 'name')),
  type: String(readRow(row, 2, 'type') ?? 'TEXT'),
  notnull: readRow(row, 3, 'notnull') === 1,
  pk: readRow(row, 5, 'pk') === 1,
  defaultValue: readRow(row, 4, 'dflt_value') != null ? String(readRow(row, 4, 'dflt_value')) : null,
})

/**
 * Extract column names from an arbitrary SQL query using a temp view.
 * Creates a temp view from the query, reads its column info, then drops it.
 */
const getColumnsFromQuery = async (db: AnyDrizzleDatabase, query: string): Promise<string[]> => {
  try {
    await db.run(sql.raw(`DROP VIEW IF EXISTS ${escapeId(tempViewName)}`))
    await db.run(sql.raw(`CREATE TEMP VIEW ${escapeId(tempViewName)} AS ${query}`))
    const pragmaRows = await db.all(sql.raw(`PRAGMA table_info(${escapeId(tempViewName)})`))
    await db.run(sql.raw(`DROP VIEW IF EXISTS ${escapeId(tempViewName)}`))
    return pragmaRows.map((row) => String(readRow(row, 1, 'name')))
  } catch {
    try {
      await db.run(sql.raw(`DROP VIEW IF EXISTS ${escapeId(tempViewName)}`))
    } catch {
      // Ignore cleanup errors
    }
    return []
  }
}

/**
 * Create a SqliteExplorerAdapter for a Drizzle SQLite database.
 * Works with any Drizzle sqlite-proxy backend (wa-sqlite, bun-sqlite, libsql-tauri, powersync).
 */
export const createDrizzleExplorerAdapter = (db: AnyDrizzleDatabase): SqliteExplorerAdapter => ({
  async getObjects(): Promise<DbObject[]> {
    const rows = await db.all(sql.raw(`SELECT name, type, sql, tbl_name FROM sqlite_master ORDER BY type, name`))

    return rows.map((row) => ({
      name: String(readRow(row, 0, 'name')),
      type: String(readRow(row, 1, 'type')) as DbObject['type'],
      sqlDefinition: readRow(row, 2, 'sql') != null ? String(readRow(row, 2, 'sql')) : null,
      tblName: readRow(row, 3, 'tbl_name') != null ? String(readRow(row, 3, 'tbl_name')) : null,
    }))
  },

  async getColumns(objectName: string): Promise<ColumnInfo[]> {
    const rows = await db.all(sql.raw(`PRAGMA table_info(${escapeId(objectName)})`))
    return rows.map(parsePragmaRow)
  },

  async getRowCount(objectName: string): Promise<number> {
    const rows = await db.all(sql.raw(`SELECT COUNT(*) FROM ${escapeId(objectName)}`))
    return Number(readRow(rows[0], 0, 'COUNT(*)') ?? 0)
  },

  async execute(query: string): Promise<QueryResult> {
    if (!isSelectStatement(query)) {
      await db.run(sql.raw(query))
      return { columns: ['result'], rows: [['Statement executed successfully']] }
    }

    // Get column names via temp view approach
    const columns = await getColumnsFromQuery(db, query)

    // Execute the actual query
    const rawRows = await db.all(sql.raw(query))

    // Convert rows to arrays if they came back as objects
    const rows =
      columns.length > 0
        ? rawRows.map((row) => rowToArray(row, columns))
        : rawRows.map((row) => {
            if (Array.isArray(row)) {
              return row
            }
            if (row && typeof row === 'object') {
              return Object.values(row as Record<string, unknown>)
            }
            return [row]
          })

    // If temp view approach didn't yield columns, extract from first object row or generate indexed names
    const finalColumns =
      columns.length > 0
        ? columns
        : rawRows.length > 0 && rawRows[0] && typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0])
          ? Object.keys(rawRows[0] as Record<string, unknown>)
          : rows.length > 0
            ? Array.from({ length: rows[0].length }, (_, i) => `col_${i}`)
            : []

    return { columns: finalColumns, rows }
  },
})
