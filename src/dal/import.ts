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
 */
const derivePkSpec = (tableName: string, table: SQLiteTable): PkSpec => {
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
  const entry = Object.entries(table as unknown as Record<string, unknown>).find(([, value]) => value === column)
  if (!entry) {
    throw new Error(`Could not derive JS field name for the primary key of "${tableName}".`)
  }
  return { column, field: entry[0] }
}

/**
 * Per-table primary-key spec, derived once at module load from the same
 * `includedTables` map the exporter walks. New tables in
 * `src/db/powersync/schema.ts` automatically pick up an import spec — no
 * duplicate hardcoded list to keep in sync.
 */
const tablePks = Object.fromEntries(
  (Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>).map(([name, table]) => [
    name,
    derivePkSpec(name, table),
  ]),
) as Record<IncludedTableName, PkSpec>

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
export const importUserData = async (db: AnyDrizzleDatabase, payload: unknown): Promise<ImportResult> => {
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
      const { column: pkColumn, field: pkField } = tablePks[tableName]

      for (const row of rows) {
        if (!isRecord(row)) {
          throw new ImportFormatError(`Row in table "${tableName}" is not an object.`)
        }
        const pkValue = row[pkField]
        if (typeof pkValue !== 'string') {
          throw new ImportFormatError(`Row in "${tableName}" is missing string primary key "${pkField}".`)
        }
        const existing = await tx.select({ pk: pkColumn }).from(table).where(eq(pkColumn, pkValue)).get()
        if (existing) {
          await tx.update(table).set(row).where(eq(pkColumn, pkValue))
        } else {
          await tx.insert(table).values(row)
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
