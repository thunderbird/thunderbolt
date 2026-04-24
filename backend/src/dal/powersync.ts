import type { db as DbType } from '@/db/client'
import {
  powersyncConflictTarget,
  powersyncDbNameToSchemaKey,
  powersyncPkColumn,
  powersyncTablesByName,
} from '@/db/powersync-schema'
import { type PowerSyncTableName, powersyncTableNames } from '@shared/powersync-tables'
import { and, eq } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'

const validTables = new Set<string>(powersyncTableNames)

/** DB column names that clients cannot set via PowerSync upload (server-managed fields). */
const uploadDenyColumns: Partial<Record<PowerSyncTableName, string[]>> = {
  devices: ['revoked_at', 'trusted', 'public_key', 'mlkem_public_key', 'approval_pending'],
}

/** Tables that cannot be deleted via PowerSync upload — must use dedicated API endpoints. */
const uploadDenyDelete = new Set<PowerSyncTableName>(['devices'])

type PowerSyncOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

/** DB column names that use Drizzle timestamp(); JSON sends them as ISO strings, so we convert to Date. */
const TIMESTAMP_DB_COLUMNS = new Set(['deleted_at', 'last_seen', 'created_at', 'revoked_at', 'updated_at'])

/**
 * Convert payload with DB column names to schema keys and filter to valid columns only.
 * Timestamp columns arrive as ISO strings from JSON; convert to Date for Drizzle.
 */
const toSchemaRecord = (
  dbRecord: Record<string, unknown>,
  validDbNames: Set<string>,
  dbNameToKey: Record<string, string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [dbName, value] of Object.entries(dbRecord)) {
    if (!validDbNames.has(dbName)) continue
    const schemaKey = dbNameToKey[dbName]
    if (schemaKey && value !== undefined) {
      let mapped = value
      if (TIMESTAMP_DB_COLUMNS.has(dbName) && typeof value === 'string') {
        const d = new Date(value)
        mapped = Number.isNaN(d.getTime()) ? value : d
      }
      out[schemaKey] = mapped
    }
  }
  return out
}

/**
 * Apply a single PowerSync operation using Drizzle's query builder (parameterized, no raw SQL).
 * The user_id is always set to the authenticated user to ensure data isolation.
 */
export const applyOperation = async (
  database: typeof DbType,
  op: PowerSyncOperation,
  userId: string,
): Promise<boolean> => {
  if (!validTables.has(op.type)) {
    return false
  }

  const tableName = op.type as PowerSyncTableName
  const table = powersyncTablesByName[tableName]
  const dbNameToKey = powersyncDbNameToSchemaKey[tableName]
  const pkColumn = powersyncPkColumn[tableName]
  const conflictTarget = powersyncConflictTarget[tableName]
  if (!table || !dbNameToKey || !pkColumn || !conflictTarget) return false

  const validDbNames = new Set(Object.keys(dbNameToKey))
  const tableWithUserId = table as AnyPgTable & { userId: typeof table.userId }

  switch (op.op) {
    case 'PUT': {
      const payload = { ...(op.data ?? {}) } as Record<string, unknown>
      delete payload.id
      delete payload.user_id
      for (const col of uploadDenyColumns[tableName] ?? []) delete payload[col]
      const rawData: Record<string, unknown> = { ...payload, id: op.id, user_id: userId }
      const schemaValues = toSchemaRecord(rawData, validDbNames, dbNameToKey)
      if (Object.keys(schemaValues).length === 0) return false

      const updateSet = { ...schemaValues }
      delete updateSet.id
      delete updateSet.key
      delete updateSet.userId

      const insertQuery = database.insert(table).values(schemaValues as never)
      if (Object.keys(updateSet).length > 0) {
        await insertQuery.onConflictDoUpdate({
          target: conflictTarget,
          set: updateSet as never,
          setWhere: eq(tableWithUserId.userId, userId),
        })
      } else {
        await insertQuery.onConflictDoNothing({ target: conflictTarget })
      }
      return true
    }
    case 'PATCH': {
      if (!op.data || Object.keys(op.data).length === 0) {
        return true
      }
      const patchPayload = { ...op.data } as Record<string, unknown>
      delete patchPayload.id
      delete patchPayload.user_id
      for (const col of uploadDenyColumns[tableName] ?? []) delete patchPayload[col]
      const schemaPatch = toSchemaRecord(patchPayload, validDbNames, dbNameToKey)
      if (Object.keys(schemaPatch).length === 0) return false

      const patched = await database
        .update(table)
        .set(schemaPatch as never)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      return patched.length > 0
    }
    case 'DELETE': {
      if (uploadDenyDelete.has(tableName)) return false

      const deleted = await database
        .delete(table)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      return deleted.length > 0
    }
  }
  return false
}
