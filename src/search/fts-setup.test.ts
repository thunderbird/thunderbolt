/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import type { SearchEntityConfig } from './registry'
import { buildBackfillSql, buildCreateSql, buildDropSql, buildTriggerSql } from './fts-setup'
import { searchEntities } from './registry'

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
  it('emits insert/update/delete triggers on the given internal table', () => {
    const [insert, update, remove] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain('CREATE TRIGGER search_index_ai_chat AFTER INSERT ON ps_data__chat_threads')
    expect(update).toContain('CREATE TRIGGER search_index_au_chat AFTER UPDATE ON ps_data__chat_threads')
    expect(remove).toContain('CREATE TRIGGER search_index_ad_chat AFTER DELETE ON ps_data__chat_threads')
  })

  it('inserts the literal entity_type and NEW.id', () => {
    const [insert] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain("SELECT NEW.id, 'chat',")
  })

  it('guards insert and update re-insert against soft-deleted rows (deleted_at not null)', () => {
    const [insert, update] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(insert).toContain(`WHERE json_extract(NEW.data, '$.deleted_at') IS NULL`)
    // the update deletes then conditionally re-inserts, so setting deleted_at
    // hard-deletes the index row and clearing it re-adds the row
    expect(update).toContain(`DELETE FROM search_index WHERE id = OLD.id AND entity_type = 'chat'`)
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

  it('scopes the delete predicate to id AND the literal entity_type', () => {
    const [, update, remove] = buildTriggerSql(configOf('chat'), 'ps_data__chat_threads')
    expect(remove).toContain(`DELETE FROM search_index WHERE id = OLD.id AND entity_type = 'chat'`)
    // update re-syncs by deleting the old row first, then inserting
    expect(update).toContain(`DELETE FROM search_index WHERE id = OLD.id AND entity_type = 'chat'`)
    expect(update).toContain('INSERT INTO search_index')
  })
})

describe('buildBackfillSql', () => {
  it('selects from the internal table into the index with the literal entity_type', () => {
    const sql = buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')
    expect(sql).toContain('INSERT INTO search_index(id, entity_type, parent_id, title, body) SELECT')
    expect(sql).toContain(`'chat'`)
    expect(sql).toContain('FROM ps_data__chat_threads')
  })

  it('reads fields from the bare data column (not NEW.data) in backfill', () => {
    const sql = buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')
    expect(sql).toContain(`json_extract(data, '$.title')`)
    expect(sql).not.toContain('NEW.data')
  })

  it('skips soft-deleted rows in the backfill', () => {
    const sql = buildBackfillSql(configOf('chat'), 'ps_data__chat_threads')
    expect(sql).toContain(`FROM ps_data__chat_threads WHERE json_extract(data, '$.deleted_at') IS NULL`)
  })

  it('emits empty-string title and NULL parent for an entity lacking both (device)', () => {
    const sql = buildBackfillSql(configOf('device'), 'ps_data__devices')
    expect(sql).toContain(`json_extract(data, '$.name')`)
    expect(sql).not.toContain('parentId')
    expect(sql).toContain('NULL')
  })
})

describe('buildDropSql', () => {
  const statements = buildDropSql()

  it('drops every trigger for every registered entity, then the table last', () => {
    for (const cfg of searchEntities) {
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_ai_${cfg.type}`)
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_au_${cfg.type}`)
      expect(statements).toContain(`DROP TRIGGER IF EXISTS search_index_ad_${cfg.type}`)
    }
    expect(statements.at(-1)).toBe('DROP TABLE IF EXISTS search_index')
  })

  it('drops 3 triggers per entity plus one table statement', () => {
    expect(statements).toHaveLength(searchEntities.length * 3 + 1)
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

  it('backfills pre-existing rows and skips soft-deleted ones', () => {
    const db = makeDb(false) // rows pre-exist before any trigger — the backfill must catch them
    insertRow(db, 'keep', { name: 'Keeper', deleted_at: null })
    insertRow(db, 'skip', { name: 'Skipper', deleted_at: 'yes' })
    db.run(buildBackfillSql(modelCfg, internalName))

    expect(search(db, 'keep*').map((row) => row.id)).toEqual(['keep'])
    expect(search(db, 'skip*')).toHaveLength(0)
    db.close()
  })
})
