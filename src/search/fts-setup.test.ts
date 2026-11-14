/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { LockContext, type RawQueryResult, type SqliteRecord, type Transaction } from '@powersync/common'
import { AppSchema } from '@/db/powersync/schema'
import type { SearchEntityConfig } from './registry'
import {
  buildBackfillSql,
  buildCreateKeysSql,
  buildCreateSql,
  buildDropSql,
  buildTriggerSql,
  createSearchIndex,
} from './fts-setup'
import { searchEntities, searchIndexVersion } from './registry'

const configOf = (type: string): SearchEntityConfig => {
  const cfg = searchEntities.find((entity) => entity.type === type)
  if (!cfg) {
    throw new Error(`missing fixture config for '${type}'`)
  }
  return cfg
}

describe('buildCreateSql', () => {
  const sql = buildCreateSql()

  it('creates the single unified FTS5 virtual table', () => {
    expect(sql).toContain('CREATE VIRTUAL TABLE search_index USING fts5(')
  })

  it('marks id, entity_type, and parent_id UNINDEXED but leaves title/body tokenized', () => {
    expect(sql).toContain('id UNINDEXED')
    expect(sql).toContain('entity_type UNINDEXED')
    expect(sql).toContain('parent_id UNINDEXED')
    expect(sql).not.toContain('title UNINDEXED')
    expect(sql).not.toContain('body UNINDEXED')
  })

  it('uses a locale-independent, diacritic-folding unicode61 tokenizer', () => {
    expect(sql).toContain(`tokenize = 'unicode61 remove_diacritics 2'`)
  })

  it('does not stem: porter breaks prefix matching mid-word', () => {
    expect(sql).not.toContain('porter')
  })
})

describe('buildTriggerSql', () => {
  const removeOldChatRow = `DELETE FROM search_index WHERE rowid = (SELECT fts_rowid FROM search_index_keys WHERE entity_type = 'chat' AND id = OLD.id)`

  it('emits insert/update/delete triggers on the given internal table', () => {
    const [insert, update, remove, replace] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain('CREATE TRIGGER search_index_ai_chat AFTER INSERT ON ps_data__chat_threads')
    expect(insert).not.toContain('DELETE')
    expect(replace).toContain('CREATE TRIGGER search_index_bi_chat BEFORE INSERT ON ps_data__chat_threads WHEN EXISTS')
    expect(update).toContain('CREATE TRIGGER search_index_au_chat AFTER UPDATE ON ps_data__chat_threads')
    expect(remove).toContain('CREATE TRIGGER search_index_ad_chat AFTER DELETE ON ps_data__chat_threads')
  })

  it('inserts the literal entity_type and NEW.id', () => {
    const [insert] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain("SELECT 'chat', NEW.id")
    expect(insert).toContain("NEW.id, 'chat',")
  })

  it('guards insert and update re-insert against soft-deleted rows (deleted_at not null)', () => {
    const [insert, update] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain(`WHERE json_extract(NEW.data, '$.deleted_at') IS NULL`)
    // the update deletes then conditionally re-inserts, so setting deleted_at
    // hard-deletes the index row and clearing it re-adds the row
    expect(update).toContain(removeOldChatRow)
    expect(update).toContain(`WHERE json_extract(NEW.data, '$.deleted_at') IS NULL`)
  })

  it('maps the title field via json_extract on NEW.data', () => {
    const [insert] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain(`json_extract(NEW.data, '$.title')`)
  })

  it('uses an empty-string title when the entity has no title field (message)', () => {
    const [insert] = buildTriggerSql(configOf('message'), 'ps_data__chat_messages')
    // message has titleField null -> literal '' for title, no title json_extract
    expect(insert).not.toContain(`, json_extract(NEW.data, '$.title')`)
    expect(insert).toContain(`json_extract(NEW.data, '$.content')`)
  })

  it('maps parent_id via json_extract when the entity has a parent (message)', () => {
    const [insert] = buildTriggerSql(configOf('message'), 'ps_data__chat_messages')
    expect(insert).toContain(`json_extract(NEW.data, '$.chat_thread_id')`)
  })

  it('uses NULL for parent_id when the entity has no parent (chat)', () => {
    const [insert] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain('NULL')
    expect(insert).not.toContain(`json_extract(NEW.data, '$.chat_thread_id')`)
  })

  it('coalesces and space-joins multiple body fields (model)', () => {
    const [insert] = buildTriggerSql(configOf('model'), 'ps_data__models')
    expect(insert).toContain(
      `coalesce(json_extract(NEW.data, '$.description'), '') || ' ' || ` +
        `coalesce(json_extract(NEW.data, '$.vendor'), '') || ' ' || ` +
        `coalesce(json_extract(NEW.data, '$.model'), '')`,
    )
  })

  it('deletes through the key map, scoped to id AND the literal entity_type', () => {
    const [, update, remove] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(remove).toContain(removeOldChatRow)
    // update re-syncs by deleting the old row first, then inserting
    expect(update).toContain(removeOldChatRow)
    expect(update).toContain('INSERT INTO search_index')
    expect(remove).toContain("DELETE FROM search_index_keys WHERE entity_type = 'chat' AND id = OLD.id")
  })
})

describe('buildBackfillSql', () => {
  it('selects from the internal table into the index with the literal entity_type', () => {
    const [keys, sql] = buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')
    expect(keys).toContain(
      "INSERT INTO search_index_keys(entity_type, id) SELECT 'chat', id FROM ps_data__chat_threads",
    )
    expect(sql).toContain('INSERT INTO search_index(rowid, id, entity_type, parent_id, title, body) SELECT')
    expect(sql).toContain(`'chat'`)
    expect(sql).toContain('FROM ps_data__chat_threads')
  })

  it('reads fields from the bare data column (not NEW.data) in backfill', () => {
    const [, sql] = buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')
    expect(sql).toContain(`json_extract(data, '$.title')`)
    expect(sql).not.toContain('NEW.data')
  })

  it('skips soft-deleted rows in the backfill', () => {
    for (const sql of buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')) {
      expect(sql).toContain(`FROM ps_data__chat_threads WHERE json_extract(data, '$.deleted_at') IS NULL`)
    }
  })

  it('emits empty-string title and NULL parent for an entity lacking both (device)', () => {
    const [, sql] = buildBackfillSql(configOf('device'), 'ps_data__devices')
    expect(sql).toContain(`json_extract(data, '$.name')`)
    expect(sql).not.toContain('parentId')
    expect(sql).toContain('NULL')
  })
})

describe('buildDropSql', () => {
  const statements = buildDropSql()

  it('drops every trigger for every registered entity, then the key map and the table last', () => {
    for (const cfg of searchEntities) {
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_ai_${cfg.type}`)
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_au_${cfg.type}`)
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_ad_${cfg.type}`)
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_bi_${cfg.type}`)
    }
    expect(statements.slice(-2)).toEqual([
      'DROP TABLE IF EXISTS search_index_keys',
      'DROP TABLE IF EXISTS search_index',
    ])
  })

  it('drops 4 triggers per entity plus two table statements', () => {
    expect(statements).toHaveLength(searchEntities.length * 4 + 2)
  })
})

// End-to-end smoke test: run the generated SQL against a real SQLite handle so a
// regression in the create/trigger/backfill/query round-trip is caught — the
// string assertions above can't. Uses a fake backing table that mirrors the
// PowerSync internal shape (an `id` column + a JSON `data` blob) rather than a
// real `ps_data__*` table; it can't catch a PowerSync-internal shape change (see
// the coupling caveat in AGENTS.md), but it proves the SQL itself works.
describe('FTS SQL end-to-end against real SQLite', () => {
  const modelCfg = configOf('model') // multi body-field entity: name + description/vendor/model
  const internalName = 'ps_data__models'

  type IndexRow = { id: string; title: string; snippet: string }

  const makeDb = (installTriggers = true): Database => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE ${internalName} (id TEXT PRIMARY KEY, data TEXT)`)
    db.run(buildCreateSql())
    db.run(buildCreateKeysSql())
    if (installTriggers) {
      for (const statement of buildTriggerSql(modelCfg, internalName)) {
        db.run(statement)
      }
    }
    return db
  }

  const insertRow = (db: Database, id: string, data: Record<string, unknown>) => {
    db.run(`INSERT INTO ${internalName}(id, data) VALUES (?, ?)`, [id, JSON.stringify(data)])
  }

  const setData = (db: Database, id: string, data: Record<string, unknown>) => {
    db.run(`UPDATE ${internalName} SET data = ? WHERE id = ?`, [JSON.stringify(data), id])
  }

  const search = (db: Database, match: string): IndexRow[] =>
    db
      .query(
        `SELECT id, title, snippet(search_index, 4, '', '', '…', 15) AS snippet ` +
          `FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0), id`,
      )
      .all(match) as IndexRow[]

  it('indexes a row on insert and matches it by title and by every body field', () => {
    const db = makeDb()
    insertRow(db, 'gpt-4o', {
      name: 'GPT-4o',
      description: 'fast frontier model',
      vendor: 'openai',
      model: 'gpt-4o',
      deleted_at: null,
    })

    expect(search(db, 'gpt*').map((row) => row.id)).toEqual(['gpt-4o']) // title
    expect(search(db, 'frontier').map((row) => row.id)).toEqual(['gpt-4o']) // description body field
    expect(search(db, 'openai').map((row) => row.id)).toEqual(['gpt-4o']) // vendor body field
    db.close()
  })

  it('excludes soft-deleted rows from the index', () => {
    const db = makeDb()
    insertRow(db, 'live', { name: 'Live Model', deleted_at: null })
    insertRow(db, 'gone', { name: 'Gone Model', deleted_at: '2026-01-01T00:00:00Z' })

    expect(search(db, 'model*').map((row) => row.id)).toEqual(['live'])
    db.close()
  })

  it('re-syncs the index on update (a rename drops the old term and adds the new)', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Alpha', deleted_at: null })
    setData(db, 'm1', { name: 'Beta', deleted_at: null })

    expect(search(db, 'alpha')).toHaveLength(0)
    expect(search(db, 'beta').map((row) => row.id)).toEqual(['m1'])
    db.run(`UPDATE search_index SET body = 'untouched'`)
    setData(db, 'm1', { name: 'Beta', deleted_at: null, updated_at: 'now' })
    expect(search(db, 'untouched').map((row) => row.id)).toEqual(['m1'])
    setData(db, 'm1', { name: 'Beta', description: 'fresh' })
    expect(search(db, 'untouched')).toHaveLength(0)
    db.close()
  })

  it('does not write the FTS index when only non-searchable fields or equivalent empty body fields change', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Stable model', description: null, deleted_at: null })
    const totalChanges = () => (db.query('SELECT total_changes() AS count').get() as { count: number }).count
    const before = totalChanges()

    setData(db, 'm1', {
      name: 'Stable model',
      description: '',
      deleted_at: null,
      enabled: 0,
      metadata: { usage: { totalTokens: 1234 } },
      cache: { widget: 'cached result' },
    })

    // The backing row changes once; no writes reach the FTS shadow tables.
    expect(totalChanges() - before).toBe(1)
    expect(search(db, 'stable').map(({ id }) => id)).toEqual(['m1'])
    db.close()
  })

  it('keeps title and body updates searchable across NULL transitions', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Original', description: null, deleted_at: null })

    setData(db, 'm1', { name: null, description: 'Replacement body', deleted_at: null })
    expect(search(db, 'original')).toHaveLength(0)
    expect(search(db, 'replacement').map(({ id }) => id)).toEqual(['m1'])

    setData(db, 'm1', { name: 'Restored', description: null, deleted_at: null })
    expect(search(db, 'replacement')).toHaveLength(0)
    expect(search(db, 'restored').map(({ id }) => id)).toEqual(['m1'])
    db.close()
  })

  it('updates the indexed identity even when the row data is unchanged', () => {
    const db = makeDb()
    insertRow(db, 'before', { name: 'Stable', deleted_at: null })

    db.run(`UPDATE ${internalName} SET id = ? WHERE id = ?`, ['after', 'before'])

    expect(search(db, 'stable').map(({ id }) => id)).toEqual(['after'])
    db.close()
  })

  it('updates a message parent while skipping metadata-only writes', () => {
    const db = new Database(':memory:')
    const messageTable = 'ps_data__chat_messages'
    db.run(`CREATE TABLE ${messageTable} (id TEXT PRIMARY KEY, data TEXT)`)
    db.run(buildCreateSql())
    db.run(buildCreateKeysSql())
    for (const statement of buildTriggerSql(configOf('message'), messageTable)) {
      db.run(statement)
    }
    const insert = db.prepare(`INSERT INTO ${messageTable}(id, data) VALUES (?, ?)`)
    const update = db.prepare(`UPDATE ${messageTable} SET data = ? WHERE id = ?`)
    const data = { content: 'Searchable reply', chat_thread_id: 'first-chat', deleted_at: null }
    insert.run('message', JSON.stringify(data))
    const before = (db.query('SELECT total_changes() AS count').get() as { count: number }).count

    update.run(JSON.stringify({ ...data, metadata: { contextTokens: 1000 }, cache: { key: 'value' } }), 'message')
    expect((db.query('SELECT total_changes() AS count').get() as { count: number }).count - before).toBe(1)
    update.run(JSON.stringify({ ...data, chat_thread_id: 'second-chat' }), 'message')

    expect(db.query("SELECT id, parent_id FROM search_index WHERE search_index MATCH 'searchable'").all()).toEqual([
      { id: 'message', parent_id: 'second-chat' },
    ])
    db.close()
  })

  it('skips index writes when a deleted row only changes its deletion timestamp', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Deleted', deleted_at: 'first timestamp' })
    const before = (db.query('SELECT total_changes() AS count').get() as { count: number }).count

    setData(db, 'm1', { name: 'Deleted', deleted_at: 'later timestamp' })

    expect((db.query('SELECT total_changes() AS count').get() as { count: number }).count - before).toBe(1)
    expect(search(db, 'deleted')).toHaveLength(0)
    db.close()
  })

  it('drops the index row when a soft-delete lands via update and re-adds it when cleared', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Gamma', deleted_at: null })

    setData(db, 'm1', { name: 'Gamma', deleted_at: 'yes' })
    expect(search(db, 'gamma')).toHaveLength(0)

    setData(db, 'm1', { name: 'Gamma', deleted_at: null })
    expect(search(db, 'gamma').map((row) => row.id)).toEqual(['m1'])
    db.close()
  })

  it('removes the index row on delete', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Delta', deleted_at: null })
    db.run(`DELETE FROM ${internalName} WHERE id = ?`, ['m1'])

    expect(search(db, 'delta')).toHaveLength(0)
    db.close()
  })

  it('keeps the index in step with synced REPLACE (live → live, live → deleted, deleted → live) and a later delete', () => {
    const db = makeDb()
    insertRow(db, 'm1', { name: 'Alpha', deleted_at: null })
    // PowerSync applies a synced PUT as REPLACE INTO, which does not fire the DELETE trigger.
    db.run(`REPLACE INTO ${internalName}(id, data) VALUES (?, ?)`, ['m1', JSON.stringify({ name: 'Beta' })])

    expect(search(db, 'alpha')).toHaveLength(0)
    expect(search(db, 'beta').map((row) => row.id)).toEqual(['m1'])
    db.run(`REPLACE INTO ${internalName}(id, data) VALUES (?, ?)`, ['m1', '{"name":"Beta","deleted_at":"yes"}'])
    expect(search(db, 'beta')).toHaveLength(0)
    db.run(`REPLACE INTO ${internalName}(id, data) VALUES (?, ?)`, ['m1', JSON.stringify({ name: 'Beta' })])
    expect(search(db, 'beta').map((row) => row.id)).toEqual(['m1'])

    db.run(`DELETE FROM ${internalName} WHERE id = ?`, ['m1'])
    expect(search(db, 'beta')).toHaveLength(0)
    db.close()
  })

  it("leaves another entity's index row with the same id alone", () => {
    const db = makeDb()
    const skillTable = 'ps_data__skills'
    db.run(`CREATE TABLE ${skillTable} (id TEXT PRIMARY KEY, data TEXT)`)
    for (const statement of buildTriggerSql(configOf('skill'), skillTable)) {
      db.run(statement)
    }
    insertRow(db, 'shared', { name: 'Epsilon', deleted_at: null })
    db.run(`INSERT INTO ${skillTable}(id, data) VALUES (?, ?)`, ['shared', JSON.stringify({ name: 'Epsilon' })])

    setData(db, 'shared', { name: 'Epsilon', deleted_at: 'yes' })
    expect(db.query(`SELECT entity_type FROM search_index WHERE search_index MATCH 'epsilon'`).all()).toEqual([
      { entity_type: 'skill' },
    ])
    db.close()
  })

  // Every write to an indexed row runs these deletes. FTS5 can only seek by rowid
  // or MATCH, so a predicate on an UNINDEXED column scans the whole index — once
  // per written row, which made soft-deleting a large chat quadratic.
  it('finds the index row to remove by rowid instead of scanning the whole index', () => {
    const db = makeDb()
    const removals = buildTriggerSql(modelCfg, internalName).flatMap((trigger) =>
      trigger
        .slice(trigger.indexOf(' BEGIN ') + ' BEGIN '.length, trigger.lastIndexOf('; END'))
        .split('; ')
        .filter((statement) => statement.startsWith('DELETE FROM search_index ')),
    )

    for (const statement of removals) {
      const plan = db.query(`EXPLAIN QUERY PLAN ${statement.replace(/\b(?:OLD|NEW)\.id\b/g, "'m1'")}`).all() as {
        detail: string
      }[]
      const ftsStep = plan.find((step) => step.detail.startsWith('SCAN search_index VIRTUAL TABLE'))
      expect(ftsStep?.detail).toMatch(/:=$/) // FTS5 rowid-equality plan; a full scan ends in a bare ':'
    }
    expect(removals).toHaveLength(3) // insert (sync REPLACE), update, and delete triggers
    db.close()
  })

  it('backfills pre-existing rows, skips soft-deleted ones, then updates/deletes a backfilled row through the key map', () => {
    const db = makeDb(false) // rows pre-exist before any trigger — the backfill must catch them
    db.run(`INSERT INTO search_index_keys(fts_rowid, entity_type, id) VALUES (1, 'skill', 'unrelated')`)
    insertRow(db, 'keep', { name: 'Keeper', deleted_at: null })
    insertRow(db, 'skip', { name: 'Skipper', deleted_at: 'yes' })
    for (const statement of [...buildBackfillSql(modelCfg, internalName), ...buildTriggerSql(modelCfg, internalName)]) {
      db.run(statement)
    }

    expect(search(db, 'keep*').map((row) => row.id)).toEqual(['keep'])
    expect(search(db, 'skip*')).toHaveLength(0)

    setData(db, 'keep', { name: 'Renamed', deleted_at: null })
    expect(search(db, 'keep*')).toHaveLength(0)
    expect(search(db, 'renamed').map((row) => row.id)).toEqual(['keep'])

    db.run(`DELETE FROM ${internalName} WHERE id = ?`, ['keep'])
    expect(search(db, 'renamed')).toHaveLength(0)
    db.close()
  })
})

describe('createSearchIndex transactions', () => {
  /** Uses real SQLite rollback with a queue matching PowerSync's exclusive write-transaction contract. */
  const makeDatabase = (beforeExecute: (sql: string) => Promise<void>) => {
    const sqlite = new Database(':memory:')
    for (const cfg of searchEntities) {
      const table = AppSchema.tables.find((candidate) => candidate.name === cfg.tableName)!
      sqlite.run(`CREATE TABLE ${table.internalName} (id TEXT PRIMARY KEY, data TEXT)`)
    }
    const transaction = new (class extends LockContext implements Transaction {
      async executeRaw(sql: string, parameters: SQLQueryBindings[] = []): Promise<RawQueryResult> {
        await beforeExecute(sql)
        const statement = sqlite.query<SqliteRecord, SQLQueryBindings[]>(sql)
        const rows = statement.all(...parameters)
        const columnNames = statement.columnNames
        return { columnNames, rawRows: rows.map((row) => columnNames.map((name) => row[name])) }
      }
      async commit() {
        sqlite.run('COMMIT')
      }
      async rollback() {
        sqlite.run('ROLLBACK')
      }
    })()
    const queue: Promise<void>[] = []
    const powerSync: Parameters<typeof createSearchIndex>[0] = {
      writeTransaction: async <T>(callback: (tx: Transaction) => Promise<T>): Promise<T> => {
        const previous = queue.at(-1)
        const completion = Promise.withResolvers<void>()
        queue.push(completion.promise)
        await previous
        sqlite.run('BEGIN IMMEDIATE')
        try {
          const result = await callback(transaction)
          await transaction.commit()
          return result
        } catch (error) {
          await transaction.rollback()
          throw error
        } finally {
          completion.resolve()
        }
      },
    }
    return { sqlite, powerSync }
  }

  it('rolls back an interrupted same-version repair and retries without accepting a partial index', async () => {
    const lastEntity = searchEntities.at(-1)!
    const table = AppSchema.tables.find((candidate) => candidate.name === lastEntity.tableName)!
    const lastBackfill = buildBackfillSql(lastEntity, table.internalName).at(-1)
    const failure = { enabled: false }
    const { sqlite, powerSync } = makeDatabase(async (sql) => {
      if (failure.enabled && sql === lastBackfill) {
        throw new Error('Interrupted last backfill')
      }
    })
    const insert = (id: string) =>
      sqlite.run(`INSERT INTO ${table.internalName} (id, data) VALUES (?, ?)`, [id, JSON.stringify({ item: id })])
    const indexedIds = () => sqlite.query('SELECT id FROM search_index ORDER BY id').all()
    const triggerCount = () =>
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_index_%'").all().length
    try {
      insert('original')
      await createSearchIndex(powerSync)
      sqlite.run(`DROP TRIGGER search_index_ai_${lastEntity.type}`)
      insert('missed')
      failure.enabled = true

      await expect(createSearchIndex(powerSync)).rejects.toThrow('Interrupted last backfill')
      expect(indexedIds()).toEqual([{ id: 'original' }])
      expect(triggerCount()).toBe(searchEntities.length * 4 - 1)
      expect(sqlite.query('SELECT version FROM search_index_meta').all()).toEqual([{ version: searchIndexVersion }])

      failure.enabled = false
      await createSearchIndex(powerSync)
      expect(indexedIds()).toEqual([{ id: 'missed' }, { id: 'original' }])
      expect(triggerCount()).toBe(searchEntities.length * 4)
      insert('subsequent')
      expect(indexedIds()).toEqual([{ id: 'missed' }, { id: 'original' }, { id: 'subsequent' }])
    } finally {
      sqlite.close()
    }
  })

  it('rebuilds when the key map is missing so indexed writes stop failing', async () => {
    const entity = searchEntities[0]
    const table = AppSchema.tables.find((candidate) => candidate.name === entity.tableName)!
    const { sqlite, powerSync } = makeDatabase(async () => {})
    const insert = (id: string) =>
      sqlite.run(`INSERT INTO ${table.internalName} (id, data) VALUES (?, ?)`, [id, JSON.stringify({ item: id })])
    try {
      insert('original')
      await createSearchIndex(powerSync)
      sqlite.run('DROP TABLE search_index_keys')
      expect(() => insert('blocked')).toThrow('no such table')
      await createSearchIndex(powerSync)
      insert('subsequent')
      expect(sqlite.query('SELECT id FROM search_index ORDER BY id').all()).toEqual([
        { id: 'original' },
        { id: 'subsequent' },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('validates inside the write lock so concurrent callers build only once', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const creates: string[] = []
    const { sqlite, powerSync } = makeDatabase(async (sql) => {
      if (sql === buildCreateSql()) {
        creates.push(sql)
        entered.resolve()
        await release.promise
      }
    })
    try {
      const first = createSearchIndex(powerSync)
      const second = createSearchIndex(powerSync)
      await entered.promise
      expect(creates).toHaveLength(1)
      release.resolve()
      await Promise.all([first, second])

      expect(creates).toHaveLength(1)
      expect(sqlite.query('SELECT version FROM search_index_meta').all()).toEqual([{ version: searchIndexVersion }])
      expect(
        sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_index_%'").all(),
      ).toHaveLength(searchEntities.length * 4)
    } finally {
      release.resolve()
      sqlite.close()
    }
  })

  it('upgrades the previous index version once, preserving rows and installing the guarded triggers', async () => {
    const creates: string[] = []
    const { sqlite, powerSync } = makeDatabase(async (sql) => {
      if (sql === buildCreateSql()) {
        creates.push(sql)
      }
    })
    const config = configOf('chat')
    const table = AppSchema.tables.find((candidate) => candidate.name === config.tableName)!
    try {
      sqlite.run(`INSERT INTO ${table.internalName}(id, data) VALUES (?, ?)`, [
        'chat',
        JSON.stringify({ title: 'Existing title', deleted_at: null }),
      ])
      await createSearchIndex(powerSync)
      const updateTrigger = buildTriggerSql(config, table.internalName)[1]!
      sqlite.run('DROP TRIGGER search_index_au_chat')
      sqlite.run(updateTrigger.replace(/( AFTER UPDATE ON \S+) WHEN .+? BEGIN /, '$1 BEGIN '))
      sqlite.run('UPDATE search_index_meta SET version = ?', [searchIndexVersion - 1])

      await createSearchIndex(powerSync)
      await createSearchIndex(powerSync)

      expect(creates).toHaveLength(2)
      expect(sqlite.query('SELECT id, title FROM search_index').all()).toEqual([
        { id: 'chat', title: 'Existing title' },
      ])
      const before = (sqlite.query('SELECT total_changes() AS count').get() as { count: number }).count
      sqlite.run(`UPDATE ${table.internalName} SET data = json_set(data, '$.context_size', 500) WHERE id = 'chat'`)
      expect((sqlite.query('SELECT total_changes() AS count').get() as { count: number }).count - before).toBe(1)
      expect(sqlite.query('SELECT version FROM search_index_meta').all()).toEqual([{ version: searchIndexVersion }])
    } finally {
      sqlite.close()
    }
  })
})
