/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { localOnlyTables, syncedTables } from '@/db/powersync/schema'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

export const exportFormat = 'thunderbolt-export'
export const exportSchemaVersion = 1

/** Every table name PowerSync knows about — synced and local-only. */
type AllTableName = keyof typeof syncedTables | keyof typeof localOnlyTables

/**
 * Tables intentionally excluded from the user-data export:
 * - `devices`: per-device trust state, meaningless on the importing device.
 * - `integrations_secrets`: third-party OAuth tokens (Google / Microsoft).
 *   The importing user re-authenticates instead.
 * - `agents_system`: backend-hydrated catalog, not user content.
 *
 * Typed against {@link AllTableName} so a future schema rename/removal trips
 * the compiler. Anything not in this list is included.
 */
const excludedFromExport = [
  'devices',
  'integrations_secrets',
  'agents_system',
] as const satisfies readonly AllTableName[]
type ExcludedTableName = (typeof excludedFromExport)[number]
export type IncludedTableName = Exclude<AllTableName, ExcludedTableName>

const isExcluded = (name: string): name is ExcludedTableName => (excludedFromExport as readonly string[]).includes(name)

/**
 * Flat name → Drizzle table map for every table the export walks. Built from
 * the same source of truth PowerSync uses, so adding a new table in
 * `src/db/powersync/schema.ts` automatically picks it up here — it'll appear
 * in exports unless added to {@link excludedFromExport}.
 *
 * Exported so the importer ({@link src/dal/import.ts}) can iterate the same
 * set without redefining it.
 */
export const includedTables = Object.fromEntries(
  Object.entries({
    ...syncedTables,
    ...Object.fromEntries(Object.entries(localOnlyTables).map(([name, def]) => [name, def.tableDefinition])),
  }).filter(([name]) => !isExcluded(name)),
  // `Object.fromEntries` returns `{ [k: string]: SQLiteTable }`, which TS won't directly cast to
  // `Record<IncludedTableName, SQLiteTable>` (finite key union — TS can't prove each named key is
  // present from a string-indexed source). Hence the `unknown` hop, per TS's own recovery hint.
) as unknown as Record<IncludedTableName, SQLiteTable>

/**
 * Backup envelope produced by {@link exportUserData}. See
 * `docs/architecture/export-format.md` for the spec consumed by THU-597.
 *
 * `tables` is keyed by the precise included-table union (auto-derived from
 * the PowerSync schema minus {@link excludedFromExport}), so the importer
 * gets type-safe access to known buckets. Row shapes are intentionally
 * `unknown[]` — the envelope stays decoupled from future column additions.
 */
export type UserDataExport = {
  format: typeof exportFormat
  schemaVersion: typeof exportSchemaVersion
  exportedAt: string
  user: { id: string; email: string | null }
  tables: Record<IncludedTableName, unknown[]>
}

/**
 * Names of the tables included in the export envelope. Frozen at module
 * load so callers can iterate without risking accidental mutation.
 */
export const exportedTableNames: readonly IncludedTableName[] = Object.freeze(
  Object.keys(includedTables) as IncludedTableName[],
)

/**
 * Returns a structural snapshot of every row in the local DB that a user
 * would expect in a backup: synced user content + user-typed credentials.
 * Soft-deleted rows are included — restore logic decides what to do with
 * them.
 *
 * No `userId` filter is applied: the local SQLite file already contains
 * exactly one user's data (PowerSync only syncs down rows the JWT is allowed
 * to see, and anonymous / standalone DBs never see other users at all).
 *
 * `attributedTo` is stamped into the envelope's `user` field as metadata —
 * it does not scope the query in any way.
 */
export const exportUserData = async (
  db: AnyDrizzleDatabase,
  attributedTo: { id: string; email: string | null },
): Promise<UserDataExport> => {
  const entries = Object.entries(includedTables) as Array<[IncludedTableName, SQLiteTable]>
  const results = await Promise.all(
    entries.map(async ([name, table]) => [name, await db.select().from(table)] as const),
  )

  return {
    format: exportFormat,
    schemaVersion: exportSchemaVersion,
    exportedAt: new Date().toISOString(),
    user: { id: attributedTo.id, email: attributedTo.email },
    tables: Object.fromEntries(results) as Record<IncludedTableName, unknown[]>,
  }
}
