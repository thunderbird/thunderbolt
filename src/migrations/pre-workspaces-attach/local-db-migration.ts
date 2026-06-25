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

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
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
  /**
   * Count of `models.api_key` cells stamped from the legacy `models_secrets`
   * table (THU-579: api keys live on the synced `models` table again).
   * Zero if the legacy DB never had the secrets table.
   */
  modelApiKeysCopied: number
}

const emptyResult = (durationMs: number): RunLocalDbMigrationResult => ({
  ranAttach: false,
  durationMs,
  rowsInsertedByTable: {},
  modelApiKeysCopied: 0,
})

/**
 * Stamp `models.api_key` from `legacy.models_secrets.api_key` for the migrated
 * personal-workspace rows. Returns the number of rows updated.
 *
 * THU-505 stored api keys in a local-only `models_secrets` table; THU-579
 * reverted that and moved the column back onto the synced `models` table.
 * Existing users still have a populated `models_secrets` in their legacy DB —
 * this copies those values into the new schema before the legacy DB is
 * detached.
 *
 * Strictly non-clobbering:
 *   - Only writes rows whose `models.api_key` is currently NULL.
 *   - Only reads legacy rows whose `api_key` is non-NULL — never overwrites
 *     a populated value with NULL.
 *
 * Either guard alone would be enough for the common rollout case, but together
 * they make the migration safe to re-run against any partially-migrated state:
 * a sync that pulled the key down before the migration ran, a user who set the
 * key on the new build before the legacy file was processed, etc.
 *
 * No-op when the legacy DB never had the secrets table (very old builds, or
 * a user who never set an api key).
 *
 * Each row is updated through Drizzle (`db.update()`) one at a time rather
 * than as a single UPDATE-with-correlated-subquery. The synced `models` table
 * is exposed by PowerSync as a SQLite view backed by `INSTEAD OF UPDATE`
 * triggers; per-row Drizzle updates are the path the rest of the FE DAL uses
 * and the one that reliably registers the change in `ps_oplog` for upload.
 * The raw correlated-subquery form did the local UPDATE but skipped the
 * upload, so on first sync the BE-side NULL would clobber the local value
 * (THU-622 rollout observation).
 */
const stampModelApiKeysFromLegacy = async (db: AnyDrizzleDatabase, personalWorkspaceId: string): Promise<number> => {
  const legacyCols = await fetchColumnNames(db, 'models_secrets', 'legacy')
  if (legacyCols.length === 0) {
    return 0
  }
  const selectQuery = `SELECT ${quoteId('id')}, ${quoteId('api_key')} FROM legacy.${quoteId('models_secrets')} WHERE ${quoteId('api_key')} IS NOT NULL`
  const rows = (await db.all(sql.raw(selectQuery))) as readonly unknown[][]

  let updated = 0
  for (const row of rows) {
    const id = row[0] as string
    const apiKey = row[1] as string
    const result = await db
      .update(modelsTable)
      .set({ apiKey })
      .where(and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, personalWorkspaceId), isNull(modelsTable.apiKey)))
      .returning({ id: modelsTable.id })
    updated += result.length
  }
  return updated
}

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
  // `!` (definite-assignment assertion) because the try/finally guarantees
  // assignment on the success path — finally re-throws any error, so the
  // return below is unreachable until the await on the last line of the try
  // resolves. TypeScript's flow analysis can't model finally-rethrow, so we
  // assert.
  let modelApiKeysCopied!: number
  try {
    for (const table of allLegacyTables) {
      rowsInsertedByTable[table.name] = await copyTable(newDb, table, personalWorkspaceId)
    }
    // Must run AFTER `models` has been copied — the UPDATE matches by PK on
    // the new `models` rows, which only exist after the table walk above.
    modelApiKeysCopied = await stampModelApiKeysFromLegacy(newDb, personalWorkspaceId)
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
    modelApiKeysCopied,
  }
}
