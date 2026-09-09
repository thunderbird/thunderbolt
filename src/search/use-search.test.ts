/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { buildCreateSql } from './fts-setup'
import { planSearchQuery } from './query-plan'
import { buildSearchStatement } from './use-search'

describe('buildSearchStatement', () => {
  it('matches on the index and ranks by bm25 for a tokenizable query', () => {
    const statement = buildSearchStatement(planSearchQuery('hello'))

    expect(statement.sql).toContain('search_index MATCH ?')
    expect(statement.sql).toContain(`snippet(search_index, 4, '', '', '…', 15)`)
    expect(statement.sql).toContain('ORDER BY bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0), id')
    expect(statement.sql).not.toContain('LIKE')
    expect(statement.parameters).toEqual(['"hello"*'])
  })

  it('ANDs a substring term onto the MATCH for a mixed query', () => {
    const statement = buildSearchStatement(planSearchQuery('sao 天気'))

    expect(statement.sql).toContain(`search_index MATCH ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`)
    expect(statement.parameters).toEqual(['"sao"*', '%天気%', '%天気%'])
  })

  it('drops MATCH entirely and orders by id for a substring-only query', () => {
    const statement = buildSearchStatement(planSearchQuery('東京の天気'))

    expect(statement.sql).not.toContain('MATCH')
    expect(statement.sql).not.toContain('bm25')
    expect(statement.sql).toContain('ORDER BY id DESC')
    // Three snippet bindings of the first term, then two LIKE bindings per term.
    expect(statement.parameters).toEqual(['東京', '東京', '東京', '%東京%', '%東京%', '%天気%', '%天気%'])
  })

  it('stays valid SQL for an empty plan, which the hook never runs', () => {
    const statement = buildSearchStatement(planSearchQuery('   '))

    expect(statement.sql).toContain('search_index MATCH ?')
    expect(statement.parameters).toEqual([''])
  })
})

// End-to-end: run the generated statements against a real index built by
// `buildCreateSql`, so the tokenizer and the query planner are verified as one
// system. The string assertions above cannot catch a tokenizer regression.
describe('search statements end-to-end against real SQLite', () => {
  type Row = { id: string; title: string | null; snippet: string }

  /** UUIDv7-shaped ids: the substring path relies on them sorting by time. */
  const idAt = (suffix: string) => `01900000-0000-7000-8000-0000000000${suffix}`

  const makeDb = (): Database => {
    const db = new Database(':memory:')
    db.run(buildCreateSql())
    const insert = db.prepare('INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?,?,?,?,?)')
    insert.run(idAt('01'), 'message', 't1', '', '東京の天気はどうですか。明日は晴れです')
    insert.run(idAt('02'), 'chat', null, 'São Paulo trip', '')
    insert.run(idAt('03'), 'message', 't1', '', 'weather report for são paulo, running quickly to Köln')
    insert.run(idAt('04'), 'message', 't2', '', '会議はキャンセルされました')
    insert.run(idAt('05'), 'message', 't2', '', 'あ'.repeat(200) + '天気' + 'い'.repeat(200))
    return db
  }

  const search = (db: Database, query: string): Row[] => {
    const statement = buildSearchStatement(planSearchQuery(query))
    return db.query(statement.sql).all(...statement.parameters) as Row[]
  }

  const ids = (db: Database, query: string): string[] => search(db, query).map((row) => row.id.slice(-2))

  it('finds Japanese content, which unicode61 cannot tokenize', () => {
    const db = makeDb()
    // Two characters: too short for a trigram MATCH, which is why this path is
    // a LIKE rather than a second index.
    expect(ids(db, '天気')).toEqual(['05', '01'])
    expect(ids(db, '東京')).toEqual(['01'])
    expect(ids(db, 'キャンセル')).toEqual(['04'])
    db.close()
  })

  it('finds a segmented Japanese query with the particle omitted', () => {
    const db = makeDb()
    expect(ids(db, '東京天気')).toEqual(['01'])
    db.close()
  })

  it('folds diacritics, so unaccented typing finds accented content', () => {
    const db = makeDb()
    expect(ids(db, 'sao')).toEqual(['02', '03'])
    expect(ids(db, 'koln')).toEqual(['03'])
    db.close()
  })

  it('keeps matching at every prefix while a word is typed', () => {
    // The porter regression: `run` hit, `runn` missed, `running` hit again.
    const db = makeDb()
    for (const prefix of ['r', 'ru', 'run', 'runn', 'runni', 'runnin', 'running']) {
      expect(ids(db, prefix)).toContain('03')
    }
    db.close()
  })

  it('requires every term of a mixed query', () => {
    const db = makeDb()
    expect(ids(db, 'sao 天気')).toEqual([])
    expect(ids(db, 'weather são')).toEqual(['03'])
    db.close()
  })

  it('orders substring hits newest-first by UUIDv7 id', () => {
    const db = makeDb()
    expect(ids(db, '天気')).toEqual(['05', '01'])
    db.close()
  })

  it('centres the substring snippet on the hit and marks both cut ends', () => {
    const db = makeDb()
    const [deep] = search(db, '天気').filter((row) => row.id.endsWith('05'))

    expect(deep.snippet).toContain('天気')
    expect(deep.snippet.startsWith('…')).toBe(true)
    expect(deep.snippet.endsWith('…')).toBe(true)
    db.close()
  })

  it('shows the trailing ellipsis even when a single character is cut', () => {
    // `substr(body, S, 80)` covers S…S+79, so a body of exactly S+80 has one
    // unshown character and must still be marked truncated.
    const db = new Database(':memory:')
    db.run(buildCreateSql())
    const insert = db.prepare('INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?,?,?,?,?)')
    // Hit at position 1, so S = 1 and the window covers 1…80.
    insert.run(idAt('08'), 'message', 't4', '', `天${'あ'.repeat(79)}`) // exactly 80 — nothing cut
    insert.run(idAt('09'), 'message', 't4', '', `天${'あ'.repeat(80)}`) // exactly 81 — one char cut

    const byId = new Map(search(db, '天').map((row) => [row.id.slice(-2), row.snippet]))
    expect(byId.get('08')?.endsWith('…')).toBe(false)
    expect(byId.get('09')?.endsWith('…')).toBe(true)
    db.close()
  })

  it('leaves the snippet empty for a title-only substring hit', () => {
    const db = new Database(':memory:')
    db.run(buildCreateSql())
    db.run(`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?, 'chat', NULL, ?, '')`, [
      idAt('06'),
      '天気タイトル',
    ])

    const [hit] = search(db, '天気')
    expect(hit.title).toBe('天気タイトル')
    expect(hit.snippet).toBe('')
    db.close()
  })

  it('treats LIKE wildcards as literals rather than matching every row', () => {
    // Planned directly: the segmenter strips punctuation, so a wildcard only
    // reaches a LIKE pattern on the no-`Intl.Segmenter` fallback path.
    const db = makeDb()
    db.run(`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?, 'message', 't3', '', ?)`, [
      idAt('07'),
      '割引は50%です',
    ])
    const statement = buildSearchStatement({ match: null, substrings: ['50%で'] })

    const rows = db.query(statement.sql).all(...statement.parameters) as Row[]
    expect(rows.map((row) => row.id.slice(-2))).toEqual(['07'])
    db.close()
  })

  it('survives adversarial input without throwing or matching everything', () => {
    const db = makeDb()
    for (const query of ['%', '_', '100%', 'a:b', '-foo', '"quoted"', '。', '\\']) {
      expect(() => search(db, query)).not.toThrow()
      expect(search(db, query).length).toBeLessThan(5)
    }
    db.close()
  })
})
