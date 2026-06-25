/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  agentsTable,
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  settingsTable,
  tasksTable,
} from '@/db/tables'
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLocalDbMigration } from './local-db-migration'
import { setCompletionFlag } from './completion-flag'

const serverId = '00000000-0000-0000-0000-000000000aaa'
const otherServerId = '00000000-0000-0000-0000-000000000bbb'
const personalWorkspaceId = '00000000-0000-0000-0000-000000000ccc'

/**
 * Pre-Workspaces schema subset — every row-bearing table the migration touches,
 * with the columns that existed on the build immediately preceding Workspaces v1
 * (i.e. before `workspace_id` and `scope` were added). Used to seed the legacy
 * SQLite file the tests ATTACH onto the new DB.
 */
const legacySchemaSql = [
  `CREATE TABLE chat_threads (
     id TEXT PRIMARY KEY,
     title TEXT,
     is_encrypted INTEGER DEFAULT 0,
     deleted_at TEXT,
     user_id TEXT
   )`,
  `CREATE TABLE chat_messages (
     id TEXT PRIMARY KEY,
     content TEXT,
     role TEXT,
     chat_thread_id TEXT,
     deleted_at TEXT,
     user_id TEXT
   )`,
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     item TEXT,
     "order" INTEGER DEFAULT 0,
     is_complete INTEGER DEFAULT 0,
     deleted_at TEXT,
     user_id TEXT
   )`,
  `CREATE TABLE models (
     id TEXT PRIMARY KEY,
     provider TEXT,
     name TEXT,
     model TEXT,
     enabled INTEGER DEFAULT 1,
     deleted_at TEXT,
     user_id TEXT
   )`,
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     transport TEXT NOT NULL,
     url TEXT NOT NULL,
     enabled INTEGER DEFAULT 1 NOT NULL,
     deleted_at TEXT,
     user_id TEXT
   )`,
  `CREATE TABLE settings (
     id TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT,
     enabled INTEGER DEFAULT 1,
     deleted_at TEXT,
     user_id TEXT
   )`,
]

const seedLegacyDb = (path: string): void => {
  const legacy = new Database(path)
  for (const stmt of legacySchemaSql) {
    legacy.run(stmt)
  }
  legacy.run(`INSERT INTO chat_threads (id, title, user_id) VALUES ('t1', 'Thread 1', 'user-A')`)
  legacy.run(`INSERT INTO chat_threads (id, title, user_id) VALUES ('t2', 'Thread 2', 'user-A')`)
  legacy.run(
    `INSERT INTO chat_messages (id, content, role, chat_thread_id, user_id) VALUES ('m1', 'hi', 'user', 't1', 'user-A')`,
  )
  legacy.run(`INSERT INTO tasks (id, item, "order") VALUES ('task1', 'Buy milk', 1)`)
  legacy.run(`INSERT INTO models (id, provider, name, model, enabled) VALUES ('mdl1', 'openai', 'GPT-4', 'gpt-4', 1)`)
  legacy.run(
    `INSERT INTO agents (id, name, type, transport, url, enabled) VALUES ('ag1', 'Test agent', 'remote-acp', 'websocket', 'wss://x.example/acp', 1)`,
  )
  legacy.run(`INSERT INTO settings (id, value) VALUES ('theme', 'dark')`)
  legacy.run(`INSERT INTO mcp_servers (id, name, enabled) VALUES ('mcp1', 'GitHub MCP', 1)`)
  legacy.close()
}

describe('runLocalDbMigration', () => {
  let tmpDir: string
  let legacyPath: string

  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'thb-pre-ws-attach-'))
    legacyPath = join(tmpDir, 'thunderbolt-sync.db')
  })

  afterEach(async () => {
    localStorage.clear()
    rmSync(tmpDir, { recursive: true, force: true })
    await resetTestDatabase()
  })

  it('returns ranAttach=false and sets the flag when there is no legacy DB', async () => {
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: null,
    })

    expect(result.ranAttach).toBe(false)
    expect(result.rowsInsertedByTable).toEqual({})
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('short-circuits when the completion flag is already set (idempotent re-run)', async () => {
    setCompletionFlag(serverId)
    seedLegacyDb(legacyPath)

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })

    expect(result.ranAttach).toBe(false)
    const threads = await getDb().select().from(chatThreadsTable)
    expect(threads).toHaveLength(0)
  })

  it('copies rows from each legacy table and stamps workspace_id on the new schema', async () => {
    seedLegacyDb(legacyPath)

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })

    expect(result.ranAttach).toBe(true)
    expect(result.rowsInsertedByTable['chat_threads']).toBe(2)
    expect(result.rowsInsertedByTable['chat_messages']).toBe(1)
    expect(result.rowsInsertedByTable['tasks']).toBe(1)
    expect(result.rowsInsertedByTable['models']).toBe(1)
    expect(result.rowsInsertedByTable['agents']).toBe(1)
    expect(result.rowsInsertedByTable['settings']).toBe(1)
    expect(result.rowsInsertedByTable['mcp_servers']).toBe(1)

    const db = getDb()
    const threads = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't1'))
    expect(threads[0]?.workspaceId).toBe(personalWorkspaceId)
    expect(threads[0]?.userId).toBe('user-A')

    const messages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, 'm1'))
    expect(messages[0]?.workspaceId).toBe(personalWorkspaceId)
    expect(messages[0]?.chatThreadId).toBe('t1')

    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.id, 'task1'))
    expect(tasks[0]?.workspaceId).toBe(personalWorkspaceId)
    expect(tasks[0]?.item).toBe('Buy milk')

    const mcp = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, 'mcp1'))
    expect(mcp[0]?.workspaceId).toBe(personalWorkspaceId)
    expect(mcp[0]?.name).toBe('GitHub MCP')

    // Settings is not workspace-scoped — workspaceId column doesn't exist on it.
    const settingsRow = await db.select().from(settingsTable).where(eq(settingsTable.key, 'theme'))
    expect(settingsRow[0]?.value).toBe('dark')

    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('stamps scope=workspace on scope-aware tables (models / agents)', async () => {
    seedLegacyDb(legacyPath)

    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })

    const db = getDb()
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, 'mdl1'))
    expect(model[0]?.scope).toBe('workspace')
    expect(model[0]?.workspaceId).toBe(personalWorkspaceId)

    const agent = await db.select().from(agentsTable).where(eq(agentsTable.id, 'ag1'))
    expect(agent[0]?.scope).toBe('workspace')
    expect(agent[0]?.workspaceId).toBe(personalWorkspaceId)
  })

  it('preserves existing rows in the new DB on PK conflict (sync-already-pulled-them-down case)', async () => {
    seedLegacyDb(legacyPath)
    const db = getDb()
    // Simulate sync having pulled this thread down from BE before the migration ran.
    await db.insert(chatThreadsTable).values({
      id: 't1',
      title: 'SYNCED-from-BE',
      workspaceId: 'ws-from-sync',
      userId: 'user-A',
    })

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })

    // t1 already existed → INSERT OR IGNORE drops it; t2 still inserted.
    expect(result.rowsInsertedByTable['chat_threads']).toBe(1)
    const t1 = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't1'))
    expect(t1[0]?.title).toBe('SYNCED-from-BE')
    expect(t1[0]?.workspaceId).toBe('ws-from-sync')
  })

  it('skips tables that do not exist in the legacy DB without erroring', async () => {
    // Legacy DB that only has chat_threads — every other table in
    // `allLegacyTables` is absent. Migration must succeed and report 0 for
    // the missing tables.
    const legacy = new Database(legacyPath)
    legacy.run(`CREATE TABLE chat_threads (id TEXT PRIMARY KEY, title TEXT, user_id TEXT)`)
    legacy.run(`INSERT INTO chat_threads (id, title, user_id) VALUES ('only', 'Solo', 'u1')`)
    legacy.close()

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })

    expect(result.ranAttach).toBe(true)
    expect(result.rowsInsertedByTable['chat_threads']).toBe(1)
    expect(result.rowsInsertedByTable['tasks']).toBe(0)
    expect(result.rowsInsertedByTable['agents']).toBe(0)
  })

  it('namespaces the completion flag per serverId — second server still runs migration', async () => {
    seedLegacyDb(legacyPath)
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })
    await resetTestDatabase()
    // First server's flag is set; second server's isn't.
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${otherServerId}`)).toBeNull()

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId: otherServerId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })
    expect(result.ranAttach).toBe(true)
  })

  it('detaches the legacy DB so a second run on the same connection can ATTACH again', async () => {
    // ATTACH 'legacy' twice on the same connection without a DETACH in
    // between fails with "database legacy is already in use". Use two
    // serverIds (different flags) on the SAME `newDb` to verify the first
    // run released the alias.
    seedLegacyDb(legacyPath)
    const db = getDb()

    const first = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })
    expect(first.ranAttach).toBe(true)

    const second = await runLocalDbMigration({
      newDb: db,
      serverId: otherServerId,
      personalWorkspaceId,
      legacyDbAttachPath: legacyPath,
    })
    expect(second.ranAttach).toBe(true)
  })
})
