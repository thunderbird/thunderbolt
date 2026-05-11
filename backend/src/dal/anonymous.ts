/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// MUST use Drizzle's query builder for all SQL operations. Raw SQL or string
// interpolation is prohibited because `tablesToMigrate` names are not SQL-escaped.

import type { db as DbType } from '@/db/client'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '@/db/powersync-schema'
import type { PowerSyncTableName } from '@shared/powersync-tables'
import { count, eq, getTableName } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Tables excluded from anonymous-user data migration.
 * `devices` is excluded because anonymous sessions have no registered device
 * (the device record is created during full registration, not before).
 * Adding to this set REQUIRES an inline comment explaining why.
 */
export const excludedFromMigration = new Set<PowerSyncTableName>(['devices'] as const)

/**
 * Ordered list of PowerSync content tables to migrate from anonymous → real user.
 * This is the source of truth used by `migrateAnonymousUserData` and the
 * schema-drift test. Must stay in sync with `shared/powersync-tables.ts`.
 */
export const tablesToMigrate = [
  settingsTable,
  chatThreadsTable,
  chatMessagesTable,
  tasksTable,
  modelsTable,
  mcpServersTable,
  promptsTable,
  triggersTable,
  modesTable,
  modelProfilesTable,
] as const satisfies readonly AnyPgTable[]

// Typed helper to access userId on any table in our list.
type TableWithUserId = AnyPgTable & { userId: { name: string } }

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AnonymousRowCapExceededError extends Error {
  readonly tableName: string
  readonly count: number

  constructor(tableName: string, rowCount: number, cap: number) {
    super(`ANON_ROW_CAP_EXCEEDED: table "${tableName}" has ${rowCount} rows (cap=${cap})`)
    this.name = 'AnonymousRowCapExceededError'
    this.tableName = tableName
    this.count = rowCount
  }
}

// ---------------------------------------------------------------------------
// assertAnonymousRowCountUnderCap
// ---------------------------------------------------------------------------

/**
 * Assert that no registered table has more than `capPerTable` rows for `anonId`.
 *
 * Runs all COUNT queries in parallel via Promise.all for performance —
 * all 10 counts are independent reads, so there is no benefit to sequencing
 * them, and the parallel approach is sub-10ms even for tables near the cap.
 *
 * MUST be called inside the same migration transaction as `migrateAnonymousUserData`
 * for snapshot atomicity (per GLM Phase 2 N-3).
 *
 * Throws `AnonymousRowCapExceededError` if any table exceeds the cap.
 * This error is NOT retryable — see `isTransientDbError`.
 */
export const assertAnonymousRowCountUnderCap = async (
  tx: typeof DbType,
  anonId: string,
  capPerTable = 10000,
): Promise<void> => {
  const counts = await Promise.all(
    tablesToMigrate.map(async (table) => {
      const t = table as TableWithUserId
      const [row] = await tx
        .select({ total: count() })
        .from(table)
        .where(eq(t.userId as never, anonId))
      return { tableName: getTableName(table), total: row?.total ?? 0 }
    }),
  )

  for (const { tableName, total } of counts) {
    if (total > capPerTable) {
      throw new AnonymousRowCapExceededError(tableName, total, capPerTable)
    }
  }
}

// ---------------------------------------------------------------------------
// migrateAnonymousUserData
// ---------------------------------------------------------------------------

/**
 * Re-key all content rows from `fromAnonId` to `toRealId` in a single transaction.
 *
 * INVARIANT: Only callable from M3's `onLinkAccount`. Do not call directly from
 * API handlers — M3 owns the surrounding transaction and the anonymous user delete.
 *
 * @param tx   - Drizzle transaction (or db) already opened by the caller.
 * @param fromAnonId - The anonymous user's ID (non-empty string).
 * @param toRealId   - The real user's ID (non-empty string).
 */
export const migrateAnonymousUserData = async (
  tx: typeof DbType,
  fromAnonId: string,
  toRealId: string,
): Promise<void> => {
  if (!fromAnonId) {
    throw new Error('migrateAnonymousUserData: fromAnonId must be a non-empty string')
  }
  if (!toRealId) {
    throw new Error('migrateAnonymousUserData: toRealId must be a non-empty string')
  }

  for (const table of tablesToMigrate) {
    const t = table as TableWithUserId
    await tx
      .update(table)
      .set({ userId: toRealId } as never)
      .where(eq(t.userId as never, fromAnonId))
  }
}

// ---------------------------------------------------------------------------
// isTransientDbError
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` is a PG error that is safe to retry:
 * - 40001 — serialization failure
 * - 40P01 — deadlock detected
 * - 08006 — connection failure
 *
 * Returns false for domain errors (23505 PK violation, 23503 FK violation, etc.)
 * so that M3's retry loop falls through to the delete-new-user fallback.
 */
export const isTransientDbError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }
  const code = (err as Record<string, unknown>).code
  if (typeof code !== 'string') {
    return false
  }
  return code === '40001' || code === '40P01' || code === '08006'
}
