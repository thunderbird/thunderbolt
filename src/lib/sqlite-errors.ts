/** SQLite extended result codes for duplicate key / row conflicts */
const insertConflictCodes = new Set([
  1555, // SQLITE_CONSTRAINT_PRIMARYKEY
  2067, // SQLITE_CONSTRAINT_UNIQUE
  2579, // SQLITE_CONSTRAINT_ROWID
])

const insertConflictMessages = ['UNIQUE constraint failed', 'PRIMARY KEY constraint failed', 'UNIQUE constraint']

/**
 * Returns true if the error indicates an insert conflict (duplicate key/row).
 * Only these errors should trigger the insert-then-update fallback.
 * Other errors (disk full, corrupt, permission, etc.) must propagate.
 */
export const isInsertConflictError = (error: unknown): boolean => {
  if (!error) return false

  // Check cause first (DrizzleQueryError and similar wrappers store original error in cause)
  const errToCheck = (error as { cause?: unknown }).cause ?? error

  // Bun SQLite and similar: numeric errno or string code
  const err = errToCheck as { errno?: number; code?: string; message?: string }
  if (typeof err.errno === 'number' && insertConflictCodes.has(err.errno)) return true
  if (typeof err.code === 'string' && /SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY|ROWID)/.test(err.code)) return true

  // Message-based (wa-sqlite worker, PowerSync, generic)
  const msg = err.message ?? (errToCheck instanceof Error ? errToCheck.message : String(errToCheck))
  if (insertConflictMessages.some((m) => msg.includes(m))) return true

  // wa-sqlite: "Unexpected step result: 2067" (code in message)
  const match = msg.match(/Unexpected step result: (\d+)/)
  if (match && insertConflictCodes.has(Number(match[1]))) return true

  return false
}
