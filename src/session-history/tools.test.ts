/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database as SQLite, type SQLQueryBindings } from 'bun:sqlite'
import { LockContext, type AbstractPowerSyncDatabase, type RawQueryResult } from '@powersync/common'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { applySchema } from '@/db/apply-schema'
import { BunSQLiteDatabase } from '@/db/bun-sqlite-database'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import * as schema from '@/db/schema'
import { updateSettings } from '@/dal/settings'
import { buildCreateSql } from '@/search/fts-setup'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import { createSessionHistoryTools, readSession, searchSessions, type SessionHistoryContext } from './tools'
import { clipJsonText, createSessionHistoryBudget, sessionHistoryLimits, utf8Bytes } from './limits'

type SearchResult = {
  results: {
    sessionId: string
    messageId: string | null
    title: string
    excerpt: string
    createdAt?: string
    url: string
  }[]
  truncated: boolean
}
type ReadResult = {
  url: string
  messages: { id: string; role: string; content: string; createdAt?: string }[]
  next: { start_message_id: string; offset: number } | null
}
const parseSearch = (text: string) => JSON.parse(text) as SearchResult
const parseRead = (text: string) => JSON.parse(text) as ReadResult

/** Use PowerSync's real row mapping, backed by Bun only for SQLite execution. */
class SQLiteLockContext extends LockContext {
  constructor(private readonly sqlite: SQLite) {
    super()
  }

  async executeRaw(query: string, params: SQLQueryBindings[] = []): Promise<RawQueryResult> {
    const statement = this.sqlite.prepare(query)
    return {
      rawRows: statement.values(...params),
      columnNames: statement.columnNames,
    }
  }
}

describe('PowerSync session-history driver', () => {
  it('searches and reads with the actual production driver that returns objects from raw all()', async () => {
    const sqlite = new SQLite(':memory:')
    const lock = new SQLiteLockContext(sqlite)
    const withLock = async <T>(callback: (context: LockContext) => Promise<T>) => callback(lock)
    const client = { readLock: withLock, writeLock: withLock } as unknown as AbstractPowerSyncDatabase
    const db = wrapPowerSyncWithDrizzle(client, { schema })
    try {
      await applySchema(db)
      await db.run(sql.raw(buildCreateSql()))
      await db.insert(settingsTable).values({ key: 'session_history_enabled', value: 'true' })
      await db.insert(chatThreadsTable).values([
        { id: 'earlier', title: 'Lantern-Kite launch', isEncrypted: 0 },
        { id: 'private', title: 'Confidential launch', isEncrypted: 1 },
      ])
      await db.insert(chatMessagesTable).values([
        { id: 'message', chatThreadId: 'earlier', role: 'user', content: 'Lantern-Kite ships on Friday.' },
        { id: 'secret', chatThreadId: 'private', role: 'user', content: 'Lantern-Kite private note.' },
      ])
      await db.run(sql`INSERT INTO search_index(id, entity_type, parent_id, title, body)
        VALUES ('earlier', 'chat', NULL, 'Lantern-Kite launch', ''),
          ('message', 'message', 'earlier', '', 'Lantern-Kite ships on Friday.'),
          ('secret', 'message', 'private', '', 'Lantern-Kite private note.')`)
      expect(await db.all(sql`SELECT id FROM chat_threads WHERE id = 'earlier'`)).toEqual([{ id: 'earlier' }])
      const tools = createSessionHistoryTools({ db, currentThreadId: 'current', allowPrivate: false })
      const options = { toolCallId: 'production-driver', messages: [] }
      const result = parseSearch((await tools.search_sessions.execute!({ query: 'Lantern-Kite' }, options)) as string)
      expect(result.results).toHaveLength(2)
      expect(result.results.every(({ sessionId }) => sessionId === 'earlier')).toBe(true)
      const hit = result.results.find(({ messageId }) => messageId === 'message')!
      expect(hit.excerpt).toContain('ships on Friday')
      expect(hit.url).toBe('/chats/earlier')
      const page = parseRead((await tools.read_session.execute!({ session_id: hit.sessionId }, options)) as string)
      expect(page.messages.map(({ content }) => content)).toEqual(['Lantern-Kite ships on Friday.'])
    } finally {
      sqlite.close()
    }
  })
})

describe('session history', () => {
  let database: BunSQLiteDatabase
  const context = (allowPrivate = false): SessionHistoryContext => ({
    db: database.db,
    currentThreadId: 'current',
    allowPrivate,
  })
  const thread = async (id: string, title = 'Planning', isEncrypted = 0) => {
    await database.db.insert(chatThreadsTable).values({ id, title, isEncrypted })
    await database.db.run(
      sql`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (${id}, 'chat', NULL, ${title}, '')`,
    )
  }
  const message = async (
    id: string,
    threadId: string,
    content: string,
    role: 'user' | 'assistant' | 'system' = 'user',
  ) => {
    await database.db.insert(chatMessagesTable).values({ id, chatThreadId: threadId, content, role })
    await database.db.run(
      sql`INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (${id}, 'message', ${threadId}, '', ${content})`,
    )
  }

  beforeEach(async () => {
    invalidateIdentityLifetime()
    database = new BunSQLiteDatabase()
    await database.initialize(':memory:')
    await applySchema(database.db)
    await database.db.run(sql.raw(buildCreateSql()))
  })

  afterEach(async () => database.close())

  it('searches titles and message text across projects with IDs for targeted reads', async () => {
    await thread('a', 'Roadmap decision')
    await thread('b', 'Budget')
    await message('01', 'b', 'The roadmap budget is $400.')
    const found = parseSearch(await searchSessions(context(), { query: 'roadmap' }))
    expect(found.results.map((hit) => hit.sessionId).sort()).toEqual(['a', 'b'])
    expect(found.results.find((hit) => hit.sessionId === 'b')?.messageId).toBe('01')
    expect(found.results.find((hit) => hit.sessionId === 'a')?.messageId).toBeNull()
    expect(found.results.find((hit) => hit.sessionId === 'a')?.url).toBe('/chats/a')
  })

  it('supplies exact UUIDv7 timestamps for temporal recall and omits unknown legacy dates', async () => {
    await thread('a')
    const id = uuidv7({ msecs: Date.UTC(2026, 0, 12, 12) })
    await message(id, 'a', 'budget $400')
    const hit = parseSearch(await searchSessions(context(), { query: 'budget' })).results[0]
    expect(hit.createdAt).toBe('2026-01-12T12:00:00.000Z')
    const page = parseRead(await readSession(context(), { session_id: 'a' }))
    expect(page.messages[0].createdAt).toBe(hit.createdAt)
    expect(page.url).toBe('/chats/a')
    expect(parseSearch(await searchSessions(context(), { query: 'Planning' })).results[0].createdAt).toBeUndefined()
  })

  it('enforces live parent/message deletion, current-chat exclusion, roles and confidentiality even with a stale index', async () => {
    for (const id of ['current', 'public', 'private', 'deleted-thread', 'deleted-message', 'system']) {
      await thread(id, 'Budget', id === 'private' ? 1 : 0)
      await message(`m-${id}`, id, 'budget $400', id === 'system' ? 'system' : 'user')
    }
    await database.db
      .update(chatThreadsTable)
      .set({ deletedAt: '2026-11-01' })
      .where(eq(chatThreadsTable.id, 'deleted-thread'))
    await database.db
      .update(chatMessagesTable)
      .set({ deletedAt: '2026-11-01' })
      .where(eq(chatMessagesTable.id, 'm-deleted-message'))
    const hits = parseSearch(await searchSessions(context(), { query: '$400' })).results
    expect(hits.map((hit) => hit.sessionId)).toEqual(['public'])
    const confidentialHits = parseSearch(await searchSessions(context(true), { query: '$400' })).results
    expect(confidentialHits.map((hit) => hit.sessionId).sort()).toEqual(['private', 'public'])
    for (const sessionId of ['private', 'deleted-thread', 'current', 'missing']) {
      expect(await readSession(context(), { session_id: sessionId })).toContain('Session unavailable')
    }
  })

  it('finds CJK and mixed-script messages without changing tokenizers', async () => {
    await thread('a')
    await message('01', 'a', '東京の会議 budget is $400')
    expect(parseSearch(await searchSessions(context(), { query: '会議' })).results).toHaveLength(1)
    expect(parseSearch(await searchSessions(context(), { query: '会議 budget' })).results).toHaveLength(1)
    expect(parseSearch(await searchSessions(context(), { query: '会議 missing' })).results).toHaveLength(0)
  })

  it('treats SQL/FTS syntax as query data and explains keyword misses', async () => {
    await thread('a')
    await message('01', 'a', 'budget')
    const response = await searchSessions(context(), { query: '" OR 1=1 --' })
    expect(parseSearch(response).results).toHaveLength(0)
    expect(response).toContain('synonym')
    expect(parseSearch(await searchSessions(context(), { query: '   ' })).results).toHaveLength(0)
  })

  it('bounds search output including unusually long Unicode and escaped strings', async () => {
    for (let index = 0; index < 12; index += 1) {
      await thread(`t${index}`, '予算💚"'.repeat(100))
      await message(`m${index}`, `t${index}`, 'budget '.repeat(1000))
    }
    const result = await searchSessions(context(), { query: 'budget' })
    expect(utf8Bytes(result)).toBeLessThanOrEqual(sessionHistoryLimits.searchBytes)
    expect(parseSearch(result).results).toHaveLength(8)
    expect(parseSearch(result).truncated).toBe(true)
  })

  it('reads only visible text, excludes deleted/system messages and respects the hit anchor', async () => {
    await thread('a')
    await message('01', 'a', 'earlier')
    await message('02', 'a', 'asked about budget')
    await message('03', 'a', '$400', 'assistant')
    await message('04', 'a', 'hidden prompt', 'system')
    await message('05', 'a', 'deleted')
    await database.db.update(chatMessagesTable).set({ deletedAt: '2026-11-01' }).where(eq(chatMessagesTable.id, '05'))
    const result = parseRead(await readSession(context(), { session_id: 'a', start_message_id: '02' }))
    expect(result.messages).toEqual([
      { id: '02', role: 'user', content: 'asked about budget' },
      { id: '03', role: 'assistant', content: '$400' },
    ])
    expect(result.next).toBeNull()
    expect(await readSession(context(), { session_id: 'a', start_message_id: '04' })).toContain('Session unavailable')
    expect(await readSession(context(), { session_id: 'a', offset: 10 })).toContain('requires start_message_id')
  })

  it('paginates giant Unicode messages without losing characters or exposing parts/metadata', async () => {
    await thread('a')
    const content = '東京💚"\n'.repeat(3500)
    await message('01', 'a', content)
    await database.db
      .update(chatMessagesTable)
      .set({ parts: [{ type: 'reasoning', text: 'secret chain' }], metadata: { modelId: 'secret metadata' } })
      .where(eq(chatMessagesTable.id, '01'))
    const chunks: string[] = []
    let cursor: ReadResult['next'] = null
    for (let page = 0; page < 20; page += 1) {
      const text = await readSession(context(), { session_id: 'a', ...cursor })
      expect(utf8Bytes(text)).toBeLessThanOrEqual(sessionHistoryLimits.readBytes)
      expect(text).not.toContain('secret')
      const result = parseRead(text)
      chunks.push(...result.messages.map((entry) => entry.content))
      cursor = result.next
      if (!cursor) {
        break
      }
    }
    expect(cursor).toBeNull()
    expect(chunks.join('')).toBe(content)
  })

  it('returns a continuation after the page message limit', async () => {
    await thread('a')
    for (let index = 0; index < 15; index += 1) {
      await message(String(index).padStart(2, '0'), 'a', 'text')
    }
    const first = parseRead(await readSession(context(), { session_id: 'a' }))
    expect(first.messages).toHaveLength(sessionHistoryLimits.messages)
    const second = parseRead(await readSession(context(), { session_id: 'a', ...first.next }))
    expect(second.messages).toHaveLength(3)
    expect(second.next).toBeNull()
  })

  it('revokes existing tools immediately when consent is disabled', async () => {
    await thread('a')
    await message('01', 'a', 'budget $400')
    const tools = createSessionHistoryTools(context())
    const options = { toolCallId: 'test', messages: [] }
    expect(await tools.search_sessions.execute!({ query: 'budget' }, options)).toContain('disabled')
    await updateSettings(database.db, { session_history_enabled: true })
    expect(await tools.search_sessions.execute!({ query: 'budget' }, options)).toContain('$400')
    await updateSettings(database.db, { session_history_enabled: false })
    expect(await tools.read_session.execute!({ session_id: 'a' }, options)).toContain('disabled')
  })

  it('passes bounded results and tool schemas through the production Pi bridge', async () => {
    await updateSettings(database.db, { session_history_enabled: true })
    await thread('a')
    await message('01', 'a', 'budget $400')
    const tools = await toPiAgentTools(createSessionHistoryTools(context()))
    const search = tools.find((entry) => entry.name === 'search_sessions')!
    expect(search.parameters).toMatchObject({ type: 'object', required: ['query'] })
    const result = await search.execute('call', { query: 'budget' }, new AbortController().signal)
    const block = result.content[0]
    expect(block.type).toBe('text')
    if (block.type !== 'text') {
      throw new Error('Expected text result')
    }
    expect(parseSearch(block.text).results[0].messageId).toBe('01')
    expect(utf8Bytes(block.text)).toBeLessThanOrEqual(sessionHistoryLimits.searchBytes)
  })

  it('retires tool closures when the signed-in identity changes', async () => {
    await updateSettings(database.db, { session_history_enabled: true })
    const tools = createSessionHistoryTools(context())
    invalidateIdentityLifetime()
    await expect(
      tools.read_session.execute!({ session_id: 'a' }, { toolCallId: 'test', messages: [] }),
    ).rejects.toThrow()
  })
})

describe('session retrieval budgets', () => {
  it('preserves Unicode and accounts for JSON escaping', () => {
    const clipped = clipJsonText('💚東京"\n'.repeat(100), 60)
    expect(utf8Bytes(JSON.stringify(clipped))).toBeLessThanOrEqual(60)
    expect(clipped).not.toContain('\uFFFD')
  })

  it('reserves concurrent calls before execution and bounds cumulative bytes', async () => {
    const budget = createSessionHistoryBudget()
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () => budget(sessionHistoryLimits.readBytes, async (bytes) => 'x'.repeat(bytes))),
    )
    const retrieved = outputs.filter((output) => output.startsWith('x'))
    expect(retrieved.reduce((sum, output) => sum + utf8Bytes(output), 0)).toBe(sessionHistoryLimits.turnBytes)
    expect(outputs.some((output) => output.includes('budget exhausted'))).toBe(true)
  })

  it('stops repeated empty searches even when their byte cost is small', async () => {
    const budget = createSessionHistoryBudget()
    for (let index = 0; index < sessionHistoryLimits.calls; index += 1) {
      expect(await budget(1000, async () => '{}')).toBe('{}')
    }
    expect(await budget(1000, async () => '{}')).toContain('budget exhausted')
  })
})
