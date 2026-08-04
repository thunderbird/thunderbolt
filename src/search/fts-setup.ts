/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AbstractPowerSyncDatabase } from '@powersync/web'
// Import AppSchema from the schema module directly, NOT the `@/db/powersync`
// barrel: the barrel re-exports the connector/database SDK, and since this file
// is pulled into the entry bundle via `use-app-initialization`, the barrel
// import would drag the whole PowerSync SDK eager and defeat the dynamic import
// in `src/db/database.ts`.
import { AppSchema } from '@/db/powersync/schema'
import type { SearchEntityConfig } from './registry'
import { searchEntities, searchIndexVersion } from './registry'
import type { SearchEntityType } from './types'

/** The single unified FTS5 virtual table every search query runs against. */
const searchIndexTable = 'search_index'
/** Tiny bookkeeping table holding the built {@link searchIndexVersion}. */
const searchMetaTable = 'search_index_meta'
/** Column order shared by the create, trigger, and backfill statements. */
const indexColumns = 'id, entity_type, parent_id, title, body'
/**
 * Soft-delete column (snake_case DB name, as stored in the PowerSync `data`
 * blob). Rows whose `deleted_at` is non-null are excluded from the index;
 * tables without the column always index (json_extract yields NULL).
 */
const softDeleteColumn = 'deleted_at'

/** Deterministic trigger names so a rebuild can drop the previous generation. */
const triggerNames = (type: SearchEntityType) => ({
  insert: `search_index_ai_${type}`,
  update: `search_index_au_${type}`,
  delete: `search_index_ad_${type}`,
})

/** `json_extract` of a single field from a row's JSON `data` blob. */
const jsonExtract = (dataExpr: string, field: string): string => `json_extract(${dataExpr}, '$.${field}')`

/** Title column expression — the empty string when the entity declares no title field. */
const titleExpr = (cfg: SearchEntityConfig, dataExpr: string): string =>
  cfg.titleField === null ? `''` : jsonExtract(dataExpr, cfg.titleField)

/** Parent-id column expression — SQL `NULL` when the entity has no parent. */
const parentExpr = (cfg: SearchEntityConfig, dataExpr: string): string =>
  cfg.parentIdField === null ? 'NULL' : jsonExtract(dataExpr, cfg.parentIdField)

/**
 * Body column expression — every body field `json_extract`ed, coalesced to the
 * empty string (so one NULL field doesn't null the whole body) and joined by a
 * single space. The empty string when the entity declares no body fields.
 */
const bodyExpr = (cfg: SearchEntityConfig, dataExpr: string): string =>
  cfg.bodyFields.length === 0
    ? `''`
    : cfg.bodyFields.map((field) => `coalesce(${jsonExtract(dataExpr, field)}, '')`).join(` || ' ' || `)

/** Predicate that keeps only rows that are not soft-deleted. */
const notSoftDeleted = (dataExpr: string): string => `${jsonExtract(dataExpr, softDeleteColumn)} IS NULL`

/**
 * The `CREATE VIRTUAL TABLE` statement for the unified FTS5 index. `id`,
 * `entity_type`, and `parent_id` are UNINDEXED (stored, not tokenized); `title`
 * and `body` are tokenized with the porter stemmer over unicode61.
 */
export const buildCreateSql = (): string =>
  `CREATE VIRTUAL TABLE ${searchIndexTable} USING fts5(` +
  `id UNINDEXED, entity_type UNINDEXED, parent_id UNINDEXED, title, body, ` +
  `tokenize = 'porter unicode61')`

/**
 * The three `AFTER INSERT/UPDATE/DELETE` triggers that keep {@link searchIndexTable}
 * in sync with one entity's internal backing table. Rows are scoped by the
 * literal `entity_type` so deletes never touch another entity's hits. The insert
 * is conditional on {@link notSoftDeleted} (a `SELECT … WHERE` yields zero rows
 * for a soft-deleted record), so on UPDATE the delete-then-insert pair hard-deletes
 * the index entry when `deleted_at` becomes set, and re-adds it if it's cleared.
 * @param internalName - The `ps_data__*` / `ps_data_local__*` backing table.
 */
export const buildTriggerSql = (cfg: SearchEntityConfig, internalName: string): string[] => {
  const names = triggerNames(cfg.type)
  const insert =
    `INSERT INTO ${searchIndexTable}(${indexColumns}) SELECT ` +
    `NEW.id, '${cfg.type}', ${parentExpr(cfg, 'NEW.data')}, ${titleExpr(cfg, 'NEW.data')}, ${bodyExpr(cfg, 'NEW.data')} ` +
    `WHERE ${notSoftDeleted('NEW.data')}`
  const remove = `DELETE FROM ${searchIndexTable} WHERE id = OLD.id AND entity_type = '${cfg.type}'`
  return [
    `CREATE TRIGGER ${names.insert} AFTER INSERT ON ${internalName} BEGIN ${insert}; END`,
    `CREATE TRIGGER ${names.update} AFTER UPDATE ON ${internalName} BEGIN ${remove}; ${insert}; END`,
    `CREATE TRIGGER ${names.delete} AFTER DELETE ON ${internalName} BEGIN ${remove}; END`,
  ]
}

/**
 * The one-shot `INSERT … SELECT` that backfills existing rows of one entity,
 * skipping soft-deleted rows.
 */
export const buildBackfillSql = (cfg: SearchEntityConfig, internalName: string): string =>
  `INSERT INTO ${searchIndexTable}(${indexColumns}) SELECT ` +
  `id, '${cfg.type}', ${parentExpr(cfg, 'data')}, ${titleExpr(cfg, 'data')}, ${bodyExpr(cfg, 'data')} ` +
  `FROM ${internalName} WHERE ${notSoftDeleted('data')}`

/** Drops the previous index generation: every entity trigger, then the table. */
export const buildDropSql = (): string[] => {
  const dropTriggers = searchEntities.flatMap((cfg) => {
    const names = triggerNames(cfg.type)
    return [names.insert, names.update, names.delete].map((name) => `DROP TRIGGER IF EXISTS ${name}`)
  })
  return [...dropTriggers, `DROP TABLE IF EXISTS ${searchIndexTable}`]
}

/** Resolves an entity's PowerSync view name to its internal backing table. */
const resolveInternalName = (tableName: string): string => {
  const table = AppSchema.tables.find((candidate) => candidate.name === tableName)
  if (!table) {
    throw new Error(`[search] No PowerSync table registered for '${tableName}'`)
  }
  return table.internalName
}

/**
 * Idempotently builds the unified FTS5 search index and its sync triggers.
 *
 * Runs once at startup: if the index already exists at the current
 * {@link searchIndexVersion} it returns immediately. Otherwise it drops any
 * previous generation, recreates the virtual table, installs INSERT/UPDATE/DELETE
 * triggers on each entity's backing table, backfills existing rows, and records
 * the new version in {@link searchMetaTable}.
 */
export const createSearchIndex = async (powerSync: AbstractPowerSyncDatabase): Promise<void> => {
  await powerSync.execute(`CREATE TABLE IF NOT EXISTS ${searchMetaTable} (version INTEGER)`)

  const [meta] = await powerSync.getAll<{ version: number }>(`SELECT version FROM ${searchMetaTable} LIMIT 1`)
  const indexRows = await powerSync.getAll(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
    searchIndexTable,
  ])
  // Also confirm the per-entity triggers still exist: PowerSync can drop/recreate
  // its internal ps_data__* tables (resync, schema update), which silently takes
  // our triggers with them while the search_index table survives. Without this
  // check the version gate would short-circuit and the index would go stale.
  const triggerRows = await powerSync.getAll(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_index_a%'`,
  )
  const expectedTriggerCount = searchEntities.length * 3
  if (indexRows.length > 0 && meta?.version === searchIndexVersion && triggerRows.length === expectedTriggerCount) {
    return
  }

  for (const statement of buildDropSql()) {
    await powerSync.execute(statement)
  }
  await powerSync.execute(buildCreateSql())

  for (const cfg of searchEntities) {
    const internalName = resolveInternalName(cfg.tableName)
    for (const trigger of buildTriggerSql(cfg, internalName)) {
      await powerSync.execute(trigger)
    }
    await powerSync.execute(buildBackfillSql(cfg, internalName))
  }

  await powerSync.execute(`DELETE FROM ${searchMetaTable}`)
  await powerSync.execute(`INSERT INTO ${searchMetaTable} (version) VALUES (${searchIndexVersion})`)
}
