/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import {
  powersyncConflictTarget,
  powersyncDbNameToSchemaKey,
  powersyncPkColumn,
  powersyncTablesByName,
} from '@/db/powersync-schema'
import { type PowerSyncTableName, legacyPowerSyncTableNames, powersyncTableNames } from '@shared/powersync-tables'
import { and, eq } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import { bridgeDeviceIdPrefix, cliDeviceIdPrefix } from './devices'

const validTables = new Set<string>(powersyncTableNames)
const legacyTables = new Set<string>(legacyPowerSyncTableNames)

/** DB column names that clients cannot set via PowerSync upload (server-managed fields). */
const uploadDenyColumns: Partial<Record<PowerSyncTableName, string[]>> = {
  devices: [
    'revoked_at',
    'trusted',
    'public_key',
    'mlkem_public_key',
    'approval_pending',
    'app_version',
    // device_type discriminates a bridge from a normal device and drives the account allowlist
    // (bridges auto-trust same-account peers). Only the bridge-registration route may set it, so a
    // client can't relabel its own device a 'bridge' via a raw PowerSync upload.
    'device_type',
    // node_id binds a device to a P2P identity — trust-sensitive. Writers are the canary-gated
    // POST /devices/:id/node-id route for trusted-device administration and the session-pinned
    // POST /devices/me/node-id route for self-enrollment, never a raw PowerSync upload.
    'node_id',
    'node_id_attested_at',
  ],
}

/** Tables that cannot be deleted via PowerSync upload — must use dedicated API endpoints. */
const uploadDenyDelete = new Set<PowerSyncTableName>(['devices'])

/**
 * Bridge and CLI device IDs are written exclusively by their server routes. Reserving both
 * prefixes from every upload operation prevents clients from creating or overwriting those rows.
 */
const isReservedDeviceId = (tableName: PowerSyncTableName, id: string) =>
  tableName === 'devices' && (id.startsWith(bridgeDeviceIdPrefix) || id.startsWith(cliDeviceIdPrefix))

type PowerSyncOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
  /**
   * Create-only PUT: insert the row when it is absent, never overwrite an
   * existing one. Clients set it on writes queued before the device completed
   * its first sync (GH #1299).
   *
   * Only PUT honours it, because PUT is the op with no user intent behind it —
   * constraining PATCH would swallow deliberate offline edits, including
   * resetting a setting to its default.
   *
   * Full rationale, the safety properties, and the known gaps:
   * docs/architecture/powersync-account-devices.md — "Create-only writes".
   */
  ifAbsent?: boolean
}

/** DB column names that use Drizzle timestamp(); JSON sends them as ISO strings, so we convert to Date. */
const timestampDbColumns = new Set(['deleted_at', 'last_seen', 'created_at', 'revoked_at', 'updated_at'])

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
    if (!validDbNames.has(dbName)) {
      continue
    }
    const schemaKey = dbNameToKey[dbName]
    if (schemaKey && value !== undefined) {
      let mapped = value
      if (timestampDbColumns.has(dbName) && typeof value === 'string') {
        const d = new Date(value)
        mapped = Number.isNaN(d.getTime()) ? value : d
      }
      out[schemaKey] = mapped
    }
  }
  return out
}

/**
 * A PATCH or DELETE whose row does not exist for this user.
 *
 * Accepted rather than rejected, for the same reason as the empty-patch no-op
 * below: a 4xx here stops the client calling `complete()`, so the operation is
 * retried forever, the CRUD queue never drains, and — because PowerSync defers
 * applying a checkpoint while local writes are pending — the device stops
 * syncing in *both* directions with no client-side recovery. Dropping one
 * unapplicable write is strictly better than bricking the account.
 *
 * It should not happen under current clients: every local row either arrived
 * from the server or has a preceding PUT in the same queue. It does happen for
 * devices carrying rows left behind by the pre-GH-#1299 `DELETE FROM ps_crud`,
 * which removed the seeding PUTs while keeping the rows — those devices upload
 * PATCHes for rows the account has never held. Logged so that population stays
 * visible rather than silently discarded.
 */
const logMissingTarget = (op: PowerSyncOperation, userId: string): void => {
  console.warn(
    `[powersync] ${op.op} on ${op.type}/${op.id} matched no row for user ${userId}; accepting so the upload queue can drain`,
  )
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
  // A table dropped from the synced schema: nothing to apply. Accept so an old
  // client's queued legacy op drains instead of looping on a 400 — same reason
  // as the empty-patch no-op below.
  if (legacyTables.has(op.type)) {
    return true
  }

  if (!validTables.has(op.type)) {
    return false
  }

  const tableName = op.type as PowerSyncTableName
  const table = powersyncTablesByName[tableName]
  const dbNameToKey = powersyncDbNameToSchemaKey[tableName]
  const pkColumn = powersyncPkColumn[tableName]
  const conflictTarget = powersyncConflictTarget[tableName]
  if (!table || !dbNameToKey || !pkColumn || !conflictTarget) {
    return false
  }

  if (isReservedDeviceId(tableName, op.id)) {
    return false
  }

  const validDbNames = new Set(Object.keys(dbNameToKey))
  const tableWithUserId = table as AnyPgTable & { userId: typeof table.userId }

  switch (op.op) {
    case 'PUT': {
      const payload = { ...(op.data ?? {}) } as Record<string, unknown>
      delete payload.id
      delete payload.user_id
      for (const col of uploadDenyColumns[tableName] ?? []) {
        delete payload[col]
      }
      const rawData: Record<string, unknown> = { ...payload, id: op.id, user_id: userId }
      const schemaValues = toSchemaRecord(rawData, validDbNames, dbNameToKey)
      if (Object.keys(schemaValues).length === 0) {
        return false
      }

      const updateSet = { ...schemaValues }
      delete updateSet.id
      delete updateSet.key
      delete updateSet.userId

      const insertQuery = database.insert(table).values(schemaValues as never)
      if (op.ifAbsent || Object.keys(updateSet).length === 0) {
        await insertQuery.onConflictDoNothing({ target: conflictTarget })
      } else {
        await insertQuery.onConflictDoUpdate({
          target: conflictTarget,
          set: updateSet as never,
          setWhere: eq(tableWithUserId.userId, userId),
        })
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
      for (const col of uploadDenyColumns[tableName] ?? []) {
        delete patchPayload[col]
      }
      const schemaPatch = toSchemaRecord(patchPayload, validDbNames, dbNameToKey)
      // Empty patch after stripping server-managed and unknown columns is a
      // harmless no-op (e.g. a buggy client that only sent `{ user_id: null }`).
      // Accept it so the client's CRUD queue can drain instead of looping on a
      // 400 — refusing it would block every subsequent upload behind a write
      // that has nothing to apply anyway.
      if (Object.keys(schemaPatch).length === 0) {
        return true
      }

      const patched = await database
        .update(table)
        .set(schemaPatch as never)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      if (patched.length === 0) {
        logMissingTarget(op, userId)
      }
      return true
    }
    case 'DELETE': {
      if (uploadDenyDelete.has(tableName)) {
        return false
      }

      const deleted = await database
        .delete(table)
        .where(and(eq(pkColumn, op.id), eq(tableWithUserId.userId, userId)))
        .returning()

      // A delete whose row is already gone has reached its intended end state.
      if (deleted.length === 0) {
        logMissingTarget(op, userId)
      }
      return true
    }
  }
  return false
}
