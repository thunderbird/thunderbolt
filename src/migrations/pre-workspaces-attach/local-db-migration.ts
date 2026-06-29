/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Step 3 of the pre-Workspaces v1 data migration. Reads the legacy
 * `thunderbolt-sync.db` (or `thunderbolt.db`) through a separate wa-sqlite
 * engine and copies every row of every legacy table into the matching table
 * on the new `server-<id>.db`, stamping `workspace_id = personalWorkspaceId`
 * and (where the new schema has it) `scope = 'workspace'` on the way in.
 *
 * Why a separate engine instead of ATTACH:
 *   The PowerSync wa-sqlite engine's VFS state is per-engine. ATTACH'ing the
 *   legacy file silently no-ops on the IDB-backed cohort (Chrome / Firefox /
 *   Edge web) — see docs/workspaces-v1-data-migration-plan-v2.md for the
 *   live diagnosis. Opening the legacy file from a fresh engine sidesteps
 *   the collision entirely.
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
 * Column discovery is dynamic. The user may be coming from a schema version
 * older than the latest pre-Workspaces build (skipped versions), so the
 * migration intersects legacy + new columns and inserts only the columns
 * both schemas share.
 */

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
import {
  isCompletionFlagSet,
  isDataCompletionFlagSet,
  isGlobalCompletionFlagSet,
  setCompletionFlag,
  setDataCompletionFlag,
  setGlobalCompletionFlag,
} from './completion-flag'
import type { LegacyBackend, LegacyReader } from './legacy-reader'
import { openLegacyReader as defaultOpenLegacyReader } from './legacy-reader'
import { allLegacyTables, type LegacyTable } from './table-list'

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * Read column index 1 ("name") from a `PRAGMA table_info` row. The shape
 * depends on the underlying driver: bun-sqlite (tests) hands back arrays
 * like `[cid, name, type, ...]`; PowerSync's Drizzle wrapper (production)
 * hands back records like `{cid, name, type, ...}`. Handle both.
 */
const readPragmaName = (row: unknown): string | null => {
  if (Array.isArray(row)) {
    return typeof row[1] === 'string' ? row[1] : null
  }
  if (row && typeof row === 'object') {
    const value = (row as Record<string, unknown>).name
    return typeof value === 'string' ? value : null
  }
  return null
}

const fetchColumnNames = async (db: AnyDrizzleDatabase, tableName: string): Promise<string[]> => {
  // PRAGMA table_info rows: [cid, name, type, notnull, dflt_value, pk]
  const rows = (await db.all(sql.raw(`PRAGMA table_info(${quoteId(tableName)})`))) as readonly unknown[]
  const names: string[] = []
  for (const row of rows) {
    const name = readPragmaName(row)
    if (name !== null) {
      names.push(name)
    }
  }
  return names
}

const countRows = async (db: AnyDrizzleDatabase, tableName: string): Promise<number> => {
  // Alias the count column so we have a stable key when the driver returns
  // records keyed by column name (PowerSync) rather than positional arrays
  // (bun-sqlite). Same dual-shape concern as readPragmaName above.
  const rows = (await db.all(sql.raw(`SELECT count(*) AS c FROM ${quoteId(tableName)}`))) as readonly unknown[]
  const row = rows[0]
  if (Array.isArray(row)) {
    return Number(row[0] ?? 0)
  }
  if (row && typeof row === 'object') {
    return Number((row as Record<string, unknown>).c ?? 0)
  }
  return 0
}

type CopyTableOutcome = {
  /** Net new rows in the table (after - before). */
  persisted: number
  /** Rows the migration attempted to insert (excludes "nothing to copy" cases). */
  attempted: number
  /** Rows that threw inside the INSERT OR IGNORE statement (catch-block hits). */
  drops: number
}

const emptyOutcome: CopyTableOutcome = { persisted: 0, attempted: 0, drops: 0 }

const copyTableViaReader = async (
  reader: LegacyReader,
  db: AnyDrizzleDatabase,
  table: LegacyTable,
  personalWorkspaceId: string,
): Promise<CopyTableOutcome> => {
  if (!(await reader.hasTable(table.name))) {
    return emptyOutcome
  }
  const legacyCols = await reader.columnNames(table.name)
  if (legacyCols.length === 0) {
    return emptyOutcome
  }
  const newCols = await fetchColumnNames(db, table.name)
  if (newCols.length === 0) {
    return emptyOutcome
  }
  const newColsSet = new Set(newCols)
  const sharedCols = legacyCols.filter((c) => newColsSet.has(c))
  if (sharedCols.length === 0) {
    return emptyOutcome
  }

  // Build the column list inserted per row: shared columns first (positionally
  // aligned with the legacy row), then any synthetic columns the new schema
  // requires that the legacy schema lacked (workspace_id, scope).
  const insertCols: string[] = [...sharedCols]
  const extraValues: unknown[] = []
  if (table.needsWorkspaceId && newColsSet.has('workspace_id') && !sharedCols.includes('workspace_id')) {
    insertCols.push('workspace_id')
    extraValues.push(personalWorkspaceId)
  }
  if (table.needsScope && newColsSet.has('scope') && !sharedCols.includes('scope')) {
    insertCols.push('scope')
    extraValues.push('workspace')
  }

  const rows = await reader.selectAll(table.name)
  if (rows.length === 0) {
    return emptyOutcome
  }

  // Cache the index of each shared column in the legacy row tuple so the
  // per-row inner loop is O(sharedCols) rather than O(sharedCols * legacyCols).
  const sharedColIndices = sharedCols.map((c) => legacyCols.indexOf(c))

  const colListSql = sql.raw(insertCols.map(quoteId).join(', '))

  // PowerSync exposes synced tables as SQLite views with INSTEAD OF INSERT
  // triggers. Going through Drizzle's `sql` template (bound parameters) routes
  // the write through those triggers, which queue the row for upload via
  // `INSERT INTO ps_crud(tx_id, data)`. Wrapping every row of this table in a
  // single Drizzle transaction makes them all share one SQLite `tx_id`, which
  // PowerSync's `getNextCrudTransaction()` groups into a single HTTP upload —
  // turning N HTTP requests per table into 1. Scoping the transaction to the
  // table (rather than the whole migration) bounds blast radius if one row
  // fails: only that table rolls back, the rest of the migration still lands.
  // The per-row try/catch lets a single malformed legacy row drop without
  // killing the rest of the table's progress; INSERT OR IGNORE already
  // handles the common conflict case silently.
  const before = await countRows(db, table.name)
  let drops = 0
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const values: unknown[] = sharedColIndices.map((i) => row[i])
      for (const v of extraValues) {
        values.push(v)
      }
      const placeholders = sql.join(
        values.map((v) => sql`${v}`),
        sql.raw(', '),
      )
      try {
        await tx.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table.name)} (${colListSql}) VALUES (${placeholders})`)
      } catch (err) {
        // Surface the drop so a buggy migration doesn't silently lose rows in
        // production with no signal beyond a count mismatch. The catch itself
        // is intentional (see block comment above): one malformed row must
        // not kill the rest of the table's progress.
        drops += 1
        console.warn(`[pre-workspaces-attach] dropping row from "${table.name}":`, err)
      }
    }
  })
  const after = await countRows(db, table.name)
  return { persisted: Math.max(0, after - before), attempted: rows.length, drops }
}

/**
 * Stamp `models.api_key` from the legacy `models_secrets.api_key` for the
 * migrated personal-workspace rows. Returns the number of rows updated.
 *
 * THU-505 stored api keys in a local-only `models_secrets` table; THU-579
 * reverted that and moved the column back onto the synced `models` table.
 * Existing users still have a populated `models_secrets` in their legacy DB —
 * this copies those values into the new schema before the reader is closed.
 *
 * Strictly non-clobbering:
 *   - Only writes rows whose `models.api_key` is currently NULL.
 *   - Only reads legacy rows whose `api_key` is non-NULL — never overwrites
 *     a populated value with NULL.
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
const stampModelApiKeysFromLegacyReader = async (
  reader: LegacyReader,
  db: AnyDrizzleDatabase,
  personalWorkspaceId: string,
): Promise<number> => {
  if (!(await reader.hasTable('models_secrets'))) {
    return 0
  }
  const cols = await reader.columnNames('models_secrets')
  const idIdx = cols.indexOf('id')
  const apiKeyIdx = cols.indexOf('api_key')
  if (idIdx === -1 || apiKeyIdx === -1) {
    return 0
  }
  const rows = await reader.selectAll('models_secrets')
  let updated = 0
  // Same batching rationale as `copyTableViaReader`: one Drizzle transaction
  // wrapping every per-model update so all the resulting `ps_crud` rows
  // share one tx_id and PowerSync uploads them as a single HTTP request.
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const apiKey = row[apiKeyIdx]
      if (typeof apiKey !== 'string') {
        // NULL or non-string — skip rather than clobber the new column with NULL.
        continue
      }
      const id = row[idIdx] as string
      const result = await tx
        .update(modelsTable)
        .set({ apiKey })
        .where(
          and(eq(modelsTable.id, id), eq(modelsTable.workspaceId, personalWorkspaceId), isNull(modelsTable.apiKey)),
        )
        .returning({ id: modelsTable.id })
      updated += result.length
    }
  })
  return updated
}

/**
 * Replace the new DB's `ps_crud` queue with the legacy DB's. PowerSync writes
 * one `ps_crud` row per local mutation, then uploads them in batches keyed by
 * `tx_id`. The data-copy step above mutates every legacy row through synced
 * views, which queues one `ps_crud` entry per row — for sync-enabled users
 * those rows are *already on the BE*, and re-uploading them is wasted traffic
 * (the BE handler upserts cleanly so it's harmless, just expensive).
 *
 * Carrying forward the legacy queue keeps only what the legacy build had
 * legitimately pending: rows the user authored offline (sync-disabled) or
 * mutated between the last upload and the upgrade (sync-enabled). The BE's
 * workspace-scoped handler already falls back to `computePersonalWorkspaceId`
 * when an upload payload lacks `workspace_id` (added during the THU-622
 * rollout), so legacy entries flow through with no schema awareness needed.
 *
 * Order requirement: must run BEFORE `stampModelApiKeysFromLegacyReader`. The
 * api-key UPDATE generates new `ps_crud` entries that *must* upload (the BE
 * has no api_key value otherwise — `models_secrets` was local-only on the
 * legacy build). Running the queue replacement *after* the api-key stamp would
 * wipe those entries and the BE would never learn the keys.
 *
 * Skips cleanly when the new DB doesn't have a `ps_crud` table — that's the
 * case in unit tests on bun-sqlite which doesn't initialise PowerSync's
 * internal schema.
 *
 * INTERNAL-SCHEMA COUPLING: reads/writes `ps_crud` and `ps_tx`, both private
 * tables created by `@powersync/web`. Validated against `@powersync/web`
 * 1.38.1 (`@powersync/common` 1.53.1). Verify the table names + `ps_tx.id = 1`
 * single-row invariant + `next_tx` column still hold on upgrade — a rename
 * here would not produce a TypeScript error.
 */
const replacePsCrudFromLegacy = async (reader: LegacyReader, db: AnyDrizzleDatabase): Promise<number> => {
  const newCols = await fetchColumnNames(db, 'ps_crud')
  if (newCols.length === 0) {
    return 0
  }
  if (!(await reader.hasTable('ps_crud'))) {
    // Pre-PowerSync legacy build (`thunderbolt.db`) — nothing to copy. Still
    // wipe the queue so the user doesn't re-upload our data-copy's churn.
    await db.run(sql.raw(`DELETE FROM ps_crud`))
    return 0
  }
  const legacyCols = await reader.columnNames('ps_crud')
  const newColsSet = new Set(newCols)
  const sharedCols = legacyCols.filter((c) => newColsSet.has(c))
  if (sharedCols.length === 0) {
    // Legacy / new `ps_crud` schemas share no columns (the table shape drifted
    // across PowerSync versions). We still MUST wipe the queue — the data-copy
    // step above has just churned it with re-uploads of rows the BE already
    // owns, and leaving them in place means sync-enabled users re-upload every
    // migrated row on first connect. Skipping the legacy queue import here is
    // the lesser harm; the BE's workspace-scoped handler tolerates re-uploads.
    await db.run(sql.raw(`DELETE FROM ps_crud`))
    return 0
  }
  const sharedColIndices = sharedCols.map((c) => legacyCols.indexOf(c))
  const rows = await reader.selectAll('ps_crud')
  const colListSql = sql.raw(sharedCols.map(quoteId).join(', '))

  await db.transaction(async (tx) => {
    // Wipe the entries the data-copy step queued. Inside the same transaction
    // so the replacement is atomic — a crash mid-way leaves either the old
    // state or the new, never a half-imported queue.
    await tx.run(sql.raw(`DELETE FROM ps_crud`))
    for (const row of rows) {
      const values = sharedColIndices.map((i) => row[i])
      const placeholders = sql.join(
        values.map((v) => sql`${v}`),
        sql.raw(', '),
      )
      await tx.run(sql`INSERT INTO ps_crud (${colListSql}) VALUES (${placeholders})`)
    }
    // Bump `ps_tx.next_tx` past the largest imported tx_id so subsequent ops
    // (the api-key stamp below, plus normal app traffic) don't collide with
    // an imported tx_id. SQLite's scalar `max(a, b)` returns the larger of
    // the two, falling back to the current `next_tx` when ps_crud is empty.
    await tx.run(
      sql.raw(`UPDATE ps_tx SET next_tx = max(next_tx, coalesce((SELECT max(tx_id) FROM ps_crud), 0)) WHERE id = 1`),
    )
  })
  return rows.length
}

/**
 * Where the legacy file lives. Mirrors `LegacyDbProbeResult` so callers can
 * pass the result of `findLegacyDbFilename()` straight through.
 */
export type LegacyDbHandle = {
  filename: string
  backend: LegacyBackend
}

export type RunLocalDbMigrationOpts = {
  newDb: AnyDrizzleDatabase
  serverId: string
  personalWorkspaceId: string
  /**
   * Location of the legacy SQLite file (filename + VFS backend). `null` means
   * "no legacy DB on disk" — the migration marks itself complete and returns
   * without reading anything.
   */
  legacyDb: LegacyDbHandle | null
  /**
   * Factory that opens the legacy file. Defaults to the production reader
   * (which spins up a second wa-sqlite engine). Tests inject a fake reader so
   * they don't have to stand up wa-sqlite — see local-db-migration.test.ts.
   */
  openReader?: (filename: string, backend: LegacyBackend) => Promise<LegacyReader>
}

export type RunLocalDbMigrationResult = {
  /** True iff the migration actually opened the legacy DB and walked tables. */
  ranMigration: boolean
  durationMs: number
  /** Per-table count of rows that the INSERT OR IGNORE actually persisted. */
  rowsInsertedByTable: Record<string, number>
  /**
   * Count of `models.api_key` cells stamped from the legacy `models_secrets`
   * table (THU-579: api keys live on the synced `models` table again).
   * Zero if the legacy DB never had the secrets table.
   */
  modelApiKeysCopied: number
  /**
   * Count of `ps_crud` rows imported from the legacy DB (after wiping the
   * entries the data-copy step queued). For sync-enabled users this is the
   * size of the legacy upload backlog; for sync-disabled users it's their
   * entire local-mutation history. Zero in tests (bun-sqlite has no
   * `ps_crud`) and on pre-PowerSync legacy DBs.
   */
  legacyPsCrudCopied: number
}

const emptyResult = (durationMs: number): RunLocalDbMigrationResult => ({
  ranMigration: false,
  durationMs,
  rowsInsertedByTable: {},
  modelApiKeysCopied: 0,
  legacyPsCrudCopied: 0,
})

export const runLocalDbMigration = async ({
  newDb,
  serverId,
  personalWorkspaceId,
  legacyDb,
  openReader = defaultOpenLegacyReader,
}: RunLocalDbMigrationOpts): Promise<RunLocalDbMigrationResult> => {
  const startedAt = performance.now()

  if (isCompletionFlagSet(serverId)) {
    return emptyResult(0)
  }

  // Differentiate "this server already consumed the legacy state" (had a
  // partial-failure boot and still owes the idempotent api-key stamp) from
  // "another server consumed it" (this server must stay out — would bleed
  // account A's local rows into account B's workspace). Only the latter
  // short-circuits.
  const thisServerConsumed = isDataCompletionFlagSet(serverId)
  if (isGlobalCompletionFlagSet() && !thisServerConsumed) {
    setCompletionFlag(serverId)
    return emptyResult(0)
  }

  if (!legacyDb) {
    // No legacy file on disk — flag both per-server and global so we don't
    // re-probe every boot or risk a transient probe failure on the SAME
    // server triggering an unwanted re-run.
    setDataCompletionFlag(serverId)
    setCompletionFlag(serverId)
    setGlobalCompletionFlag()
    return emptyResult(performance.now() - startedAt)
  }

  const reader = await openReader(legacyDb.filename, legacyDb.backend)
  const rowsInsertedByTable: Record<string, number> = {}
  // `!` (definite-assignment): the finally re-throws any error, so the only
  // path that reaches the return below is the one where the assignment
  // executed. TypeScript's flow analysis can't model finally-rethrow.
  let modelApiKeysCopied!: number
  let legacyPsCrudCopied = 0
  try {
    // Destructive steps (table copy + ps_crud replacement) run at most once.
    // Gated on `data_completion` so a partial-failure retry — where the api-key
    // stamp below threw on the previous boot — doesn't re-run the queue wipe
    // and clobber rows the user authored in the failed-state interim.
    if (!thisServerConsumed) {
      const totalFailures: string[] = []
      for (const table of allLegacyTables) {
        const outcome = await copyTableViaReader(reader, newDb, table, personalWorkspaceId)
        rowsInsertedByTable[table.name] = outcome.persisted
        // Systematic failure: rows existed in legacy, every attempt threw, none
        // persisted. Distinguishes a real bug (schema drift, type mismatch) from
        // the legitimate "all conflicts" case (rows already synced down from BE).
        // Refuse the flag so the next boot retries — silently marking complete
        // here would orphan the entire table's worth of legacy data.
        if (outcome.attempted > 0 && outcome.drops === outcome.attempted && outcome.persisted === 0) {
          totalFailures.push(`${table.name} (${outcome.attempted} rows, all dropped)`)
        }
      }
      if (totalFailures.length > 0) {
        throw new Error(
          `pre-Workspaces local DB migration: every insert dropped for ${totalFailures.join(', ')} — refusing to mark complete so the next boot retries`,
        )
      }
      // Replace the new DB's `ps_crud` with the legacy queue. Drops the entries
      // our data-copy step just generated (already on the BE for sync-enabled
      // users) and carries forward only what legacy had legitimately pending.
      // Must run BEFORE the api-key stamp — that stamp's UPDATEs queue new
      // `ps_crud` entries that *do* need to upload, and any wipe afterward
      // would lose them.
      legacyPsCrudCopied = await replacePsCrudFromLegacy(reader, newDb)
      // Pin BOTH data-completion (per-server) and global flags the instant the
      // destructive part lands. The global flag must be here, not at the end —
      // otherwise an api-key stamp failure below would leave the device-global
      // legacy state unflagged-as-consumed, and signing into a DIFFERENT
      // server would re-import it into the other account's workspace (bleed).
      setDataCompletionFlag(serverId)
      setGlobalCompletionFlag()
    }
    // Must run AFTER `models` has been copied (PK lookup on new `models`
    // rows) and AFTER the ps_crud replacement (otherwise its writes would
    // be wiped). Independently idempotent (`isNull(modelsTable.apiKey)` guard),
    // so retrying after a failed boot is safe even though the data steps above
    // are now skipped.
    modelApiKeysCopied = await stampModelApiKeysFromLegacyReader(reader, newDb, personalWorkspaceId)
  } finally {
    await reader.close()
  }

  setCompletionFlag(serverId)
  return {
    ranMigration: true,
    durationMs: performance.now() - startedAt,
    rowsInsertedByTable,
    modelApiKeysCopied,
    legacyPsCrudCopied,
  }
}
