/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { BunSQLiteDatabase } from './bun-sqlite-database'

describe('BunSQLiteDatabase', () => {
  let database: BunSQLiteDatabase

  beforeEach(async () => {
    database = new BunSQLiteDatabase()
    await database.initialize(':memory:')
    await database.db.run(sql`CREATE TABLE pairs (key TEXT, value TEXT)`)
    await database.db.run(sql`INSERT INTO pairs VALUES ('a', 'one'), ('b', 'two')`)
  })

  afterEach(async () => {
    await database.close()
  })

  // PowerSync's driver returns `values()` rows positionally too, so code that must run
  // on both drivers reads raw queries this way.
  it('returns values() rows positionally', async () => {
    const rows = await database.db.values<[string, string]>(sql`SELECT key, value FROM pairs ORDER BY key`)

    expect(rows).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ])
  })
})
