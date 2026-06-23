/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { eq } from 'drizzle-orm'
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { exportFormat, exportSchemaVersion, exportedTableNames, includedTables, type IncludedTableName } from './export'

type PkSpec = {
  /** Drizzle column reference, used in `WHERE` clauses. */
  column: SQLiteColumn
  /** JS/TypeScript field name on the row — sometimes differs from the SQL column name. */
  field: string
}

/**
 * Find the single primary-key column on a Drizzle table and the JS field name
 * that exposes it. Throws if the table doesn't have exactly one PK column —
 * every table in {@link includedTables} satisfies that today, and a future
 * composite-PK table would need bespoke import logic anyway.
 *
 * Exported for unit-test coverage of the failure branches; not part of the
 * public DAL API.
 */
export const derivePkSpec = (tableName: string, table: SQLiteTable): PkSpec => {
  const config = getTableConfig(table)
  const pkColumns = config.columns.filter((c) => c.primary)
  if (pkColumns.length !== 1) {
    throw new Error(
      `Table "${tableName}" must have exactly one primary-key column for import (found ${pkColumns.length}).`,
    )
  }
  const column = pkColumns[0] as SQLiteColumn
  // Drizzle exposes each column as an enumerable string-keyed property on the
  // table; match by reference to recover the JS field name (which can differ
  // from the SQL column name — e.g. `settingsTable.key` maps to SQL `id`).
  // Skip Drizzle's internal `_` config bag so it never collides with a column ref.
  const candidates = Object.entries(table as unknown as Record<string, unknown>).filter(([key]) => key !== '_')
  const entry = candidates.find(([, value]) => value === column)
  if (!entry) {
    throw new Error(`Could not derive JS field name for the primary key of "${tableName}".`)
  }
  return { column, field: entry[0] }
}

type TableImportSpec = {
  pk: PkSpec
  /** True when the table has a `user_id` column (every synced table; secret tables omit it). */
  hasUserId: boolean
}

/**
 * Per-table import spec, derived once at module load from the same
 * `includedTables` map the exporter walks. New tables in
 * `src/db/powersync/schema.ts` automatically pick up an import spec — no
 * duplicate hardcoded list to keep in sync.
 */
const tableImportSpecs = Object.fromEntries(
  (Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>).map(([name, table]) => [
    name,
    {
      pk: derivePkSpec(name, table),
      hasUserId: getTableConfig(table).columns.some((c) => c.name === 'user_id'),
    },
  ]),
) as Record<IncludedTableName, TableImportSpec>

export type ImportResult = {
  schemaVersion: typeof exportSchemaVersion
  /** Number of rows upserted per included table. Omitted tables had zero rows in the file. */
  tables: Partial<Record<IncludedTableName, { upserted: number }>>
  /** Table keys present in the file that the importer didn't recognize (forward-compat with future schemaVersions). */
  ignoredTableNames: string[]
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIncludedTableName = (name: string): name is IncludedTableName =>
  (exportedTableNames as readonly string[]).includes(name)

export type ExportSummary = {
  /** Total row count across every array-valued bucket in `tables`. */
  totalRows: number
  /** Locale-formatted `exportedAt`, or null if it's missing / unparseable. */
  exportedAtLabel: string | null
  /** Email of the exporting user, or null if it's missing / not a string. */
  sourceEmail: string | null
  /**
   * `true` when both `sourceEmail` and `currentUserEmail` are present and
   * differ (case-insensitively). The UI uses this to flag a cross-account
   * import in the confirm dialog. Stays `false` when either side is missing
   * — better to under-warn than to false-positive on legacy exports.
   */
  accountMismatch: boolean
}

/**
 * Read-only preview of an import envelope for the confirmation dialog.
 *
 * Returns `null` when the payload doesn't look like a valid v1 Thunderbolt
 * export (wrong shape, wrong format slug, wrong/unsupported `schemaVersion`,
 * or missing `tables`). The UI uses that to refuse the preview without
 * having to re-implement envelope checks; the full
 * {@link importUserData} validator covers the same ground at write time.
 *
 * Pass `currentUserEmail` to enable cross-account detection — the returned
 * `accountMismatch` flag is set when the envelope's email and the session
 * email both exist and differ. Email (not `user.id`) is the comparison
 * field: better-auth assigns a new id when an account is deleted and
 * recreated, but the same human's email stays stable.
 */
export const summarizeExportEnvelope = (
  payload: unknown,
  currentUserEmail: string | null = null,
): ExportSummary | null => {
  if (!isRecord(payload)) {
    return null
  }
  if (payload.format !== exportFormat) {
    return null
  }
  if (payload.schemaVersion !== exportSchemaVersion) {
    return null
  }
  if (!isRecord(payload.tables)) {
    return null
  }
  const totalRows = Object.values(payload.tables).reduce<number>(
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  )
  const exportedAtLabel =
    typeof payload.exportedAt === 'string'
      ? (() => {
          const parsed = new Date(payload.exportedAt)
          return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString()
        })()
      : null
  const sourceEmail = isRecord(payload.user) && typeof payload.user.email === 'string' ? payload.user.email : null
  const accountMismatch =
    sourceEmail !== null && currentUserEmail !== null && sourceEmail.toLowerCase() !== currentUserEmail.toLowerCase()
  return { totalRows, exportedAtLabel, sourceEmail, accountMismatch }
}

/**
 * Drop the file's `userId` and either re-stamp it from the current session
 * (tables with a `user_id` column) or omit it entirely (secret tables, which
 * have no such column). The file's value is never trusted: backups carry the
 * source user's id, but a tampered or cross-account file would otherwise
 * plant a foreign id in the local DB until backend reconciliation.
 *
 * The backend's PowerSync upload route enforces the same invariant from the
 * JWT (see `backend/src/dal/powersync.ts`).
 */
const sanitizeRowForImport = (
  row: Record<string, unknown>,
  hasUserId: boolean,
  currentUserId: string,
): Record<string, unknown> => {
  const { userId: _ignored, ...rest } = row
  return hasUserId ? { ...rest, userId: currentUserId } : rest
}

/**
 * Restore a previously-exported envelope into the local DB.
 *
 * Semantics:
 * - **Upsert.** Each row is written by checking for an existing PK row, then
 *   either `UPDATE` (imported file wins) or `INSERT`. Local rows whose PK is
 *   *not* in the file are left untouched. We deliberately avoid Drizzle's
 *   `onConflictDoUpdate`: PowerSync presents synced tables as SQLite views,
 *   and SQLite forbids `INSERT ... ON CONFLICT DO UPDATE` on a view ("cannot
 *   UPSERT a view"). The SELECT + UPDATE/INSERT split works on both real
 *   tables and PowerSync views.
 * - **`userId` re-stamped.** Tables with a `user_id` column have their
 *   row's `userId` overwritten with `currentUser.id`; the value in the file
 *   is never trusted. Tables without `user_id` (the secret tables) are
 *   unaffected.
 * - **Soft-deleted rows preserved.** `deletedAt` is written verbatim, so a
 *   row exported in the trash stays in the trash after import.
 * - **Atomic.** Wrapped in a single `db.transaction`; any per-row failure
 *   rolls back every preceding write in this call.
 * - **Forward-compatible.** Table keys the importer doesn't recognize (e.g.
 *   tables added in a future schemaVersion) are surfaced in
 *   `ignoredTableNames` but otherwise ignored.
 *
 * Throws {@link ImportFormatError} for envelope problems (wrong format,
 * unsupported schemaVersion, missing `tables`, missing/non-string primary
 * key on a row). Any other thrown error propagates as-is after rollback.
 */
export const importUserData = async (
  db: AnyDrizzleDatabase,
  payload: unknown,
  currentUser: { id: string },
): Promise<ImportResult> => {
  if (!isRecord(payload)) {
    throw new ImportFormatError('Import file is not a JSON object.')
  }
  if (payload.format !== exportFormat) {
    throw new ImportFormatError(
      `Import file is not a Thunderbolt export (expected format "${exportFormat}", got "${String(payload.format)}").`,
    )
  }
  if (payload.schemaVersion !== exportSchemaVersion) {
    throw new ImportFormatError(
      `Unsupported export schemaVersion ${String(payload.schemaVersion)}. This app reads version ${exportSchemaVersion}.`,
    )
  }
  if (!isRecord(payload.tables)) {
    throw new ImportFormatError('Import file is missing the `tables` object.')
  }

  const fileTables = payload.tables
  const ignoredTableNames: string[] = []
  const tableCounts: Partial<Record<IncludedTableName, { upserted: number }>> = {}

  await db.transaction(async (tx) => {
    for (const [tableName, rows] of Object.entries(fileTables)) {
      if (!isIncludedTableName(tableName)) {
        ignoredTableNames.push(tableName)
        continue
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        continue
      }

      const table = includedTables[tableName]
      const { pk, hasUserId } = tableImportSpecs[tableName]
      const { column: pkColumn, field: pkField } = pk

      for (const row of rows) {
        if (!isRecord(row)) {
          throw new ImportFormatError(`Row in table "${tableName}" is not an object.`)
        }
        const pkValue = row[pkField]
        if (typeof pkValue !== 'string') {
          throw new ImportFormatError(`Row in "${tableName}" is missing string primary key "${pkField}".`)
        }
        const sanitized = sanitizeRowForImport(row, hasUserId, currentUser.id)
        const existing = await tx.select({ pk: pkColumn }).from(table).where(eq(pkColumn, pkValue)).get()
        if (existing) {
          await tx.update(table).set(sanitized).where(eq(pkColumn, pkValue))
        } else {
          await tx.insert(table).values(sanitized)
        }
      }

      tableCounts[tableName] = { upserted: rows.length }
    }
  })

  return {
    schemaVersion: exportSchemaVersion,
    tables: tableCounts,
    ignoredTableNames,
  }
}
