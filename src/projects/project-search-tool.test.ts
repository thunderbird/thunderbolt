/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { BunSQLiteDatabase } from '@/db/bun-sqlite-database'
import { buildCreateSql } from '@/search/fts-setup'
import { formatProjectChatHits, searchProjectChats, type ProjectChatHit } from './project-search-tool'

const hit = (chatTitle: string, excerpt: string): ProjectChatHit => ({
  chatThreadId: 'thread-1',
  chatTitle,
  excerpt,
})

// Runs against a real SQLite database through the same drizzle `sqlite-proxy`
// driver the app uses, because the row shape is the whole risk here: raw
// `db.all()` results come back positional, so reading them by column name
// compiles, type-checks, and silently returns nothing.
describe('searchProjectChats', () => {
  let database: BunSQLiteDatabase

  const indexMessage = (id: string, threadId: string, body: string) =>
    database.db.run(
      sql`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (${id}, 'message', ${threadId}, '', ${body})`,
    )

  beforeEach(async () => {
    database = new BunSQLiteDatabase()
    await database.initialize(':memory:')
    await database.db.run(sql.raw(buildCreateSql()))
  })

  afterEach(async () => {
    await database.close()
  })

  it('returns a hit from a sibling chat, titled from the caller’s map', async () => {
    await indexMessage('m1', 't1', 'we settled on a price of $29 per seat')

    const hits = await searchProjectChats(database.db, ['t1'], 'price', new Map([['t1', 'Pricing call']]))

    expect(hits).toHaveLength(1)
    expect(hits[0].chatThreadId).toBe('t1')
    expect(hits[0].chatTitle).toBe('Pricing call')
    expect(hits[0].excerpt).toContain('price')
  })

  it('falls back to a placeholder title for an untitled thread', async () => {
    await indexMessage('m1', 't1', 'budget discussion')

    const hits = await searchProjectChats(database.db, ['t1'], 'budget', new Map())

    expect(hits[0].chatTitle).toBe('Untitled chat')
  })

  it('searches only the threads it was given', async () => {
    await indexMessage('m1', 't1', 'shared roadmap notes')
    await indexMessage('m2', 't2', 'shared roadmap notes')

    const hits = await searchProjectChats(database.db, ['t1'], 'roadmap', new Map())

    expect(hits.map((hit) => hit.chatThreadId)).toEqual(['t1'])
  })

  it('ignores rows from other entity types', async () => {
    await database.db.run(
      sql`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES ('c1', 'chat', 't1', 'roadmap', 'roadmap')`,
    )

    const hits = await searchProjectChats(database.db, ['t1'], 'roadmap', new Map())

    expect(hits).toEqual([])
  })

  it('skips the query entirely when there is nothing to match on', async () => {
    await indexMessage('m1', 't1', 'anything')

    expect(await searchProjectChats(database.db, ['t1'], '   ', new Map())).toEqual([])
    expect(await searchProjectChats(database.db, [], 'anything', new Map())).toEqual([])
  })
})

describe('formatProjectChatHits', () => {
  it('attributes each excerpt to its source chat', () => {
    const output = formatProjectChatHits([hit('Pricing call', 'we settled on $29')], 'pricing')
    expect(output).toContain('From "Pricing call":')
    expect(output).toContain('we settled on $29')
  })

  it('separates multiple hits', () => {
    const output = formatProjectChatHits([hit('A', 'first'), hit('B', 'second')], 'q')
    expect(output).toContain('From "A":')
    expect(output).toContain('From "B":')
  })

  it('tells the model an empty result may be a vocabulary miss, not an absence', () => {
    const output = formatProjectChatHits([], 'how much should we charge')
    // The single most likely failure of a lexical index is the model concluding
    // "never discussed" when it simply used different words.
    expect(output).toContain('keyword search')
    expect(output).toContain('different wording')
    expect(output).toContain('how much should we charge')
  })
})
