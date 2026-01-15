/**
 * Database result normalization utilities
 *
 * Drizzle's sqlite-proxy may return objects with all undefined values instead of
 * undefined/null when no rows are found. This is an inconsistency between different
 * SQLite implementations (libsql vs cr-sqlite, etc.).
 *
 * These utilities normalize results at the DAL level to ensure consistent behavior
 * regardless of which SQLite implementation is used.
 */

/**
 * Checks if an object is "empty" - has no properties or all properties are undefined.
 * This handles the Drizzle sqlite-proxy quirk where empty results may return objects
 * with all undefined values instead of undefined/null.
 */
export const isEmptyRow = (obj: unknown): boolean => {
  if (obj === null || obj === undefined) return true
  if (typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.length === 0 || keys.every((key) => (obj as Record<string, unknown>)[key] === undefined)
}

/**
 * Normalizes a single database row result.
 * Returns undefined if the row is "empty" (all undefined values).
 *
 * Use this when calling `.get()` queries to ensure consistent undefined returns.
 *
 * @example
 * ```ts
 * const result = await db.select().from(table).where(eq(table.id, id)).get()
 * return normalizeRow(result)
 * ```
 */
export const normalizeRow = <T>(row: T | undefined): T | undefined => {
  if (isEmptyRow(row)) return undefined
  return row
}

/**
 * Normalizes an array of database rows.
 * Filters out any "empty" rows that have all undefined values.
 *
 * Use this when calling `.all()` queries to ensure no phantom rows.
 *
 * @example
 * ```ts
 * const results = await db.select().from(table).where(eq(table.userId, id))
 * return normalizeRows(results)
 * ```
 */
export const normalizeRows = <T>(rows: T[]): T[] => {
  if (!Array.isArray(rows)) return rows
  return rows.filter((row) => !isEmptyRow(row))
}
