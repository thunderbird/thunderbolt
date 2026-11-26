/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Database } from 'bun:sqlite'
import { AppSchema } from '@/db/powersync/schema'

/** Mirrors PowerSync's layout: a JSON backing table, a view that extracts each column, and expression indexes named `<backing table>__<index>`. */
const createPowerSyncTables = (sqlite: Database) => {
  for (const table of AppSchema.tables) {
    const backingTable = table.internalName
    sqlite.run(`CREATE TABLE "${backingTable}" (id TEXT PRIMARY KEY NOT NULL, data TEXT)`)
    const columns = table.columns.map(
      ({ name, type }) => `CAST(json_extract(data, '$.${name}') AS ${type}) AS "${name}"`,
    )
    sqlite.run(`CREATE VIEW "${table.name}" AS SELECT id, ${columns.join(', ')} FROM "${backingTable}"`)
    for (const index of table.indexes) {
      const expressions = index
        .toJSON(table)
        .columns.map(({ name, type }) => `CAST(json_extract(data, '$.${name}') AS ${type})`)
      sqlite.run(`CREATE INDEX "${backingTable}__${index.name}" ON "${backingTable}" (${expressions.join(', ')})`)
    }
  }
}

/**
 * `EXPLAIN QUERY PLAN` steps for a Drizzle query, run against PowerSync-shaped JSON views.
 * Plain test tables hide planner regressions: a join that is cheap on real columns can rescan
 * a whole JSON view per outer row. Use with `getTableReads` to assert a table is read through an index.
 *
 * @example
 * const plan = getPowerSyncQueryPlan(getAllChatThreads(getDb()))
 * expect(getTableReads(plan, 'chat_messages')).toEqual([expect.stringMatching(/^SEARCH /)])
 */
export const getPowerSyncQueryPlan = (query: { toSQL: () => { sql: string } }): string[] => {
  const sqlite = new Database(':memory:')
  try {
    createPowerSyncTables(sqlite)
    return sqlite
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${query.toSQL().sql}`)
      .all()
      .map(({ detail }) => detail)
  } finally {
    sqlite.close()
  }
}

/** Plan steps that read the PowerSync table `tableName` (`SEARCH` uses an index, `SCAN` reads every row). */
export const getTableReads = (plan: string[], tableName: string): string[] => {
  const backingTable = AppSchema.tables.find(({ name }) => name === tableName)?.internalName
  if (!backingTable) {
    throw new Error(`Unknown PowerSync table: ${tableName}`)
  }
  const read = new RegExp(`^(SCAN|SEARCH) ${backingTable}( |$)`)
  return plan.filter((detail) => read.test(detail))
}
