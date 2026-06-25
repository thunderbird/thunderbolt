/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Step 3 of the pre-Workspaces v1 data migration. ATTACHes the legacy
 * `thunderbolt-sync.db` (or `thunderbolt.db`) onto the new `server-<id>.db`
 * and copies every row of every legacy table into the matching table on the
 * new DB, stamping `workspace_id = personalWorkspaceId` and (where the new
 * schema has it) `scope = 'workspace'` on the way in.
 *
 * INSERT OR IGNORE drops rows whose PK already exists in the new DB — this
 * handles two cases without special-casing them:
 *
 *   - sync-enabled users whose BE-side rows were re-stamped with `workspace_id`
 *     by Drizzle 0021 and sync'd down into the new DB before the migration ran,
 *     and
 *   - retry-after-partial-failure: the first half of a previous run already
 *     wrote some rows; the rerun finishes the rest.
 *
 * Column discovery is dynamic via `PRAGMA table_info`. The user may be coming
 * from a schema version older than the latest pre-Workspaces build (skipped
 * versions), so the migration intersects legacy + new columns and inserts only
 * the columns both schemas share.
 */

import { sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { isCompletionFlagSet, setCompletionFlag } from './completion-flag'
import { allLegacyTables, type LegacyTable } from './table-list'

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

const fetchColumnNames = async (
  db: AnyDrizzleDatabase,
  tableName: string,
  schemaPrefix?: 'legacy',
): Promise<string[]> => {
  const qualifier = schemaPrefix ? `${schemaPrefix}.` : ''
  // PRAGMA table_info returns rows shaped: [cid, name, type, notnull, dflt_value, pk]
  const rows = (await db.all(sql.raw(`PRAGMA ${qualifier}table_info(${quoteId(tableName)})`))) as readonly unknown[][]
  return rows.map((row) => row[1] as string)
}

const copyTable = async (db: AnyDrizzleDatabase, table: LegacyTable, personalWorkspaceId: string): Promise<number> => {
  const legacyCols = await fetchColumnNames(db, table.name, 'legacy')
  if (legacyCols.length === 0) {
    // Table doesn't exist in the legacy DB (added in a later schema version,
    // or never present on this user's install). Nothing to copy.
    return 0
  }
  const newCols = await fetchColumnNames(db, table.name)
  if (newCols.length === 0) {
    // New schema is missing the table — should never happen for entries in
    // `allLegacyTables`, but bail rather than emit malformed SQL.
    return 0
  }
  const newColsSet = new Set(newCols)
  const sharedCols = legacyCols.filter((c) => newColsSet.has(c))
  if (sharedCols.length === 0) {
    return 0
  }

  const insertCols: string[] = [...sharedCols]
  const selectExprs: string[] = sharedCols.map(quoteId)

  if (table.needsWorkspaceId && newColsSet.has('workspace_id') && !sharedCols.includes('workspace_id')) {
    insertCols.push('workspace_id')
    selectExprs.push(quoteLiteral(personalWorkspaceId))
  }
  if (table.needsScope && newColsSet.has('scope') && !sharedCols.includes('scope')) {
    insertCols.push('scope')
    selectExprs.push(quoteLiteral('workspace'))
  }

  // `RETURNING id` lets us count rows that actually persisted — INSERT OR
  // IGNORE silently drops PK conflicts and SQLite doesn't expose changes()
  // through the Drizzle sqlite-proxy reliably. Every FE table uses `id` as
  // its PK column name (see src/db/tables.ts).
  const insertColList = insertCols.map(quoteId).join(', ')
  const selectExprList = selectExprs.join(', ')
  const query = `INSERT OR IGNORE INTO ${quoteId(table.name)} (${insertColList}) SELECT ${selectExprList} FROM legacy.${quoteId(table.name)} RETURNING ${quoteId('id')}`
  const result = (await db.all(sql.raw(query))) as readonly unknown[][]
  return result.length
}

export type RunLocalDbMigrationOpts = {
  newDb: AnyDrizzleDatabase
  serverId: string
  personalWorkspaceId: string
  /**
   * Path / filename to pass to `ATTACH DATABASE`. In production this is the
   * basename returned by `findLegacyDbFilename()` (OPFS files live at the
   * root, so the basename IS the path). `null` means "no legacy DB on disk"
   * — the migration marks itself complete and skips ATTACH.
   *
   * Decoupled from `findLegacyDbFilename` so tests can point ATTACH at a
   * concrete file path (bun:sqlite uses the native filesystem, not OPFS).
   */
  legacyDbAttachPath: string | null
}

export type RunLocalDbMigrationResult = {
  /** True iff the migration actually ATTACHed the legacy DB and walked tables. */
  ranAttach: boolean
  durationMs: number
  /** Per-table count of rows that the INSERT OR IGNORE actually persisted. */
  rowsInsertedByTable: Record<string, number>
}

const emptyResult = (durationMs: number): RunLocalDbMigrationResult => ({
  ranAttach: false,
  durationMs,
  rowsInsertedByTable: {},
})

export const runLocalDbMigration = async ({
  newDb,
  serverId,
  personalWorkspaceId,
  legacyDbAttachPath,
}: RunLocalDbMigrationOpts): Promise<RunLocalDbMigrationResult> => {
  const startedAt = performance.now()

  if (isCompletionFlagSet(serverId)) {
    return emptyResult(0)
  }

  if (!legacyDbAttachPath) {
    // No legacy file on disk — flag complete so we don't re-probe every boot.
    setCompletionFlag(serverId)
    return emptyResult(performance.now() - startedAt)
  }

  await newDb.run(sql.raw(`ATTACH DATABASE ${quoteLiteral(legacyDbAttachPath)} AS legacy`))
  const rowsInsertedByTable: Record<string, number> = {}
  try {
    for (const table of allLegacyTables) {
      rowsInsertedByTable[table.name] = await copyTable(newDb, table, personalWorkspaceId)
    }
  } finally {
    // Detach even on failure so the next boot's ATTACH doesn't trip "alias
    // already in use". Swallowing DETACH errors here would mask the original
    // copy failure, so we let any error from DETACH itself propagate.
    await newDb.run(sql.raw(`DETACH DATABASE legacy`))
  }

  setCompletionFlag(serverId)
  return {
    ranAttach: true,
    durationMs: performance.now() - startedAt,
    rowsInsertedByTable,
  }
}
