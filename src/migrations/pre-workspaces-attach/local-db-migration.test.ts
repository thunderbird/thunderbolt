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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import type { LegacyBackend, LegacyReader } from './legacy-reader'
import { runLocalDbMigration } from './local-db-migration'
import {
  isDataCompletionFlagSet,
  isGlobalCompletionFlagSet,
  setCompletionFlag,
  setDataCompletionFlag,
  setGlobalCompletionFlag,
} from './completion-flag'

const serverId = '00000000-0000-0000-0000-000000000aaa'
const otherServerId = '00000000-0000-0000-0000-000000000bbb'
const personalWorkspaceId = '00000000-0000-0000-0000-000000000ccc'

/**
 * In-memory stand-in for the production `LegacyReader`. The production reader
 * spins up a fresh wa-sqlite engine against IDB or OPFS — neither of which
 * exists under bun's test runtime. Decoupling the migration's unit tests from
 * the wa-sqlite plumbing keeps the migration logic itself in scope while
 * leaving the wa-sqlite path to be exercised in a real browser (see
 * docs/workspaces-v1-data-migration-plan-v2.md, follow-up B).
 */
type FakeLegacyTable = {
  columns: readonly string[]
  rows: readonly unknown[][]
}

type FakeLegacySchema = Record<string, FakeLegacyTable>

const makeFakeReader = (schema: FakeLegacySchema): LegacyReader & { closed: boolean } => {
  const tables = new Map(Object.entries(schema))
  const reader = {
    closed: false,
    hasTable: async (name: string) => tables.has(name),
    columnNames: async (name: string) => [...(tables.get(name)?.columns ?? [])],
    selectAll: async (name: string) => (tables.get(name)?.rows ?? []).map((r) => [...r]),
    close: async () => {
      reader.closed = true
    },
  }
  return reader
}

const openReaderFor = (schema: FakeLegacySchema) => {
  return async (_filename: string, _backend: LegacyBackend) => makeFakeReader(schema)
}

const legacyDbHandle = { filename: 'thunderbolt-sync.db', backend: 'idb' as const }

/**
 * Pre-Workspaces schema — every row-bearing table the migration touches, with
 * the columns that existed on the build immediately preceding Workspaces v1
 * (i.e. before `workspace_id` and `scope` were added).
 */
const fullLegacySeed = (): FakeLegacySchema => ({
  chat_threads: {
    columns: ['id', 'title', 'is_encrypted', 'deleted_at', 'user_id'],
    rows: [
      ['t1', 'Thread 1', 0, null, 'user-A'],
      ['t2', 'Thread 2', 0, null, 'user-A'],
    ],
  },
  chat_messages: {
    columns: ['id', 'content', 'role', 'chat_thread_id', 'deleted_at', 'user_id'],
    rows: [['m1', 'hi', 'user', 't1', null, 'user-A']],
  },
  tasks: {
    columns: ['id', 'item', 'order', 'is_complete', 'deleted_at', 'user_id'],
    rows: [['task1', 'Buy milk', 1, 0, null, null]],
  },
  models: {
    columns: ['id', 'provider', 'name', 'model', 'enabled', 'deleted_at', 'user_id'],
    rows: [['mdl1', 'openai', 'GPT-4', 'gpt-4', 1, null, null]],
  },
  agents: {
    columns: ['id', 'name', 'type', 'transport', 'url', 'enabled', 'deleted_at', 'user_id'],
    rows: [['ag1', 'Test agent', 'remote-acp', 'websocket', 'wss://x.example/acp', 1, null, null]],
  },
  settings: {
    columns: ['id', 'value'],
    rows: [['theme', 'dark']],
  },
  mcp_servers: {
    columns: ['id', 'name', 'enabled', 'deleted_at', 'user_id'],
    rows: [['mcp1', 'GitHub MCP', 1, null, null]],
  },
  // Legacy local-only table from THU-505. THU-579 reverts it; the migration
  // copies api_key values into the new models.api_key column on the way in.
  models_secrets: {
    columns: ['id', 'api_key'],
    rows: [['mdl1', 'sk-legacy']],
  },
})

describe('runLocalDbMigration', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    localStorage.clear()
    await resetTestDatabase()
  })

  it('returns ranMigration=false and sets the flag when there is no legacy DB', async () => {
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: null,
    })

    expect(result.ranMigration).toBe(false)
    expect(result.rowsInsertedByTable).toEqual({})
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('short-circuits when the completion flag is already set (idempotent re-run)', async () => {
    setCompletionFlag(serverId)

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })

    expect(result.ranMigration).toBe(false)
    const threads = await getDb().select().from(chatThreadsTable)
    expect(threads).toHaveLength(0)
  })

  it('copies rows from each legacy table and stamps workspace_id on the new schema', async () => {
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })

    expect(result.ranMigration).toBe(true)
    expect(result.rowsInsertedByTable['chat_threads']).toBe(2)
    expect(result.rowsInsertedByTable['chat_messages']).toBe(1)
    expect(result.rowsInsertedByTable['tasks']).toBe(1)
    expect(result.rowsInsertedByTable['models']).toBe(1)
    expect(result.rowsInsertedByTable['agents']).toBe(1)
    expect(result.rowsInsertedByTable['settings']).toBe(1)
    expect(result.rowsInsertedByTable['mcp_servers']).toBe(1)
    expect(result.modelApiKeysCopied).toBe(1)

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

    // THU-579: api_key now lives on models, copied from legacy.models_secrets.
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, 'mdl1'))
    expect(model[0]?.apiKey).toBe('sk-legacy')

    // Settings is not workspace-scoped — workspaceId column doesn't exist on it.
    const settingsRow = await db.select().from(settingsTable).where(eq(settingsTable.key, 'theme'))
    expect(settingsRow[0]?.value).toBe('dark')

    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('stamps scope=workspace on scope-aware tables (models / agents)', async () => {
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
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
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })

    // t1 already existed → INSERT OR IGNORE drops it; t2 still inserted.
    expect(result.rowsInsertedByTable['chat_threads']).toBe(1)
    const t1 = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 't1'))
    expect(t1[0]?.title).toBe('SYNCED-from-BE')
    expect(t1[0]?.workspaceId).toBe('ws-from-sync')
  })

  it('skips tables that do not exist in the legacy DB without erroring', async () => {
    // Sparse legacy DB — only chat_threads is present. Migration must succeed,
    // report 0 for the missing tables, and stamp 0 api keys.
    const sparseSeed: FakeLegacySchema = {
      chat_threads: {
        columns: ['id', 'title', 'user_id'],
        rows: [['only', 'Solo', 'u1']],
      },
    }

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(sparseSeed),
    })

    expect(result.ranMigration).toBe(true)
    expect(result.rowsInsertedByTable['chat_threads']).toBe(1)
    expect(result.rowsInsertedByTable['tasks']).toBe(0)
    expect(result.rowsInsertedByTable['agents']).toBe(0)
    expect(result.modelApiKeysCopied).toBe(0)
  })

  it('does not overwrite a pre-existing models.api_key from a sync download (cross-workspace)', async () => {
    // Sync brought the same model down from BE before the migration ran — it
    // already has an api_key. INSERT OR IGNORE on `models` skips the legacy
    // row, so workspace_id stays whatever sync set. The api-key UPDATE filters
    // on `workspace_id = personalWorkspaceId`, so a row living in a DIFFERENT
    // workspace must not be touched.
    const db = getDb()
    await db.insert(modelsTable).values({
      id: 'mdl1',
      provider: 'openai',
      name: 'GPT-4',
      model: 'gpt-4',
      enabled: 1,
      workspaceId: 'ws-from-sync',
      apiKey: 'sk-from-sync',
    })

    await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })

    const fromSync = await db
      .select()
      .from(modelsTable)
      .where(and(eq(modelsTable.id, 'mdl1'), eq(modelsTable.workspaceId, 'ws-from-sync')))
    expect(fromSync[0]?.apiKey).toBe('sk-from-sync')
  })

  it('does not overwrite a same-workspace api_key already set on the new build', async () => {
    // Re-run / partial-migration scenario: the personal-workspace row already
    // has an api_key (user pasted it in on the new build before migration ran;
    // or a previous migration pass left a sync-pulled value). Legacy holds a
    // different value — migration must NOT clobber.
    const db = getDb()
    await db.insert(modelsTable).values({
      id: 'mdl1',
      provider: 'openai',
      name: 'GPT-4',
      model: 'gpt-4',
      enabled: 1,
      workspaceId: personalWorkspaceId,
      apiKey: 'sk-already-set',
    })

    const seed = fullLegacySeed()
    seed.models_secrets = {
      columns: ['id', 'api_key'],
      rows: [['mdl1', 'sk-legacy-should-be-ignored']],
    }

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(seed),
    })

    expect(result.modelApiKeysCopied).toBe(0)
    const model = await db
      .select()
      .from(modelsTable)
      .where(and(eq(modelsTable.id, 'mdl1'), eq(modelsTable.workspaceId, personalWorkspaceId)))
    expect(model[0]?.apiKey).toBe('sk-already-set')
  })

  it('does not write NULL into models.api_key when the legacy secret value is NULL', async () => {
    // Pathological legacy row: a models_secrets entry exists but its api_key
    // is NULL (user opened the settings page and never typed anything, say).
    // Migration must leave the new row's api_key untouched — currently NULL,
    // it stays NULL; we don't UPDATE...SET api_key = NULL pointlessly.
    const seed = fullLegacySeed()
    seed.models_secrets = {
      columns: ['id', 'api_key'],
      rows: [['mdl1', null]],
    }

    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(seed),
    })

    expect(result.modelApiKeysCopied).toBe(0)
    const model = await getDb().select().from(modelsTable).where(eq(modelsTable.id, 'mdl1'))
    expect(model[0]?.apiKey).toBeNull()
  })

  it('short-circuits on a second server once the global flag is set — legacy data does not bleed across accounts', async () => {
    // Sign-in on server A: migration consumes the device-global legacy file.
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })
    expect(isGlobalCompletionFlagSet()).toBe(true)
    await resetTestDatabase()

    // Sign-in on server B (same device): the per-server flag is unset, BUT the
    // device-global flag is set. The migration MUST short-circuit so user A's
    // local rows don't bleed into user B's workspace, and must still mark the
    // per-server `completed` flag so the dedicated path is satisfied for B too.
    let openedAnything = false
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId: otherServerId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: async () => {
        openedAnything = true
        return makeFakeReader(fullLegacySeed())
      },
    })

    expect(result.ranMigration).toBe(false)
    expect(openedAnything).toBe(false)
    const threads = await getDb().select().from(chatThreadsTable)
    expect(threads).toHaveLength(0)
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${otherServerId}`)).toBe('1')
  })

  it('sets the global completion flag after a successful run', async () => {
    expect(isGlobalCompletionFlagSet()).toBe(false)
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })
    expect(isGlobalCompletionFlagSet()).toBe(true)
  })

  it('sets the global completion flag even when there is no legacy DB on disk', async () => {
    // First-time install on the new build (no legacy file): no migration to
    // run, but mark global done so subsequent server boots short-circuit
    // without paying the filesystem probe.
    expect(isGlobalCompletionFlagSet()).toBe(false)
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: null,
    })
    expect(isGlobalCompletionFlagSet()).toBe(true)
  })

  it('wipes new ps_crud even when legacy ps_crud columns share nothing with the new schema', async () => {
    // ps_crud shape drifted across PowerSync versions: legacy and new have no
    // shared columns. We must still DELETE the data-copy step's churn —
    // otherwise sync-enabled users re-upload every migrated row on first
    // connect. Schema mismatch means we can't import the legacy queue, but
    // the wipe is independent of the import.
    const db = getDb()
    await db.run(sql.raw(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, tx_id INTEGER, data TEXT)`))
    await db.run(sql.raw(`CREATE TABLE ps_tx (id INTEGER PRIMARY KEY, next_tx INTEGER)`))
    await db.run(sql.raw(`INSERT INTO ps_tx (id, next_tx) VALUES (1, 0)`))
    await db.run(sql.raw(`INSERT INTO ps_crud (id, tx_id, data) VALUES (999, 99, '{"churn":true}')`))

    const seed = fullLegacySeed()
    // Legacy ps_crud with totally different column names — no overlap with
    // the new schema's (id, tx_id, data).
    seed.ps_crud = {
      columns: ['legacy_pk', 'legacy_payload'],
      rows: [[1, '{"old":true}']],
    }

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(seed),
    })

    expect(result.legacyPsCrudCopied).toBe(0)
    const remaining = (await db.all(sql.raw(`SELECT count(*) AS c FROM ps_crud`))) as readonly unknown[]
    const row = remaining[0]
    const count = Array.isArray(row) ? Number(row[0]) : Number((row as Record<string, unknown>).c)
    expect(count).toBe(0)
  })

  it('skips ps_crud replacement when the new DB has no ps_crud table (test env / pre-PowerSync)', async () => {
    // bun-sqlite in tests doesn't initialise PowerSync's internal schema, so
    // there's no `ps_crud` table. The migration must still complete and
    // report 0 imported.
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })
    expect(result.legacyPsCrudCopied).toBe(0)
  })

  it('imports legacy ps_crud rows and wipes the data-copy churn when both DBs have ps_crud', async () => {
    // Stand up an ad-hoc `ps_crud` table in the test DB so the migration's
    // INSERT/DELETE path is exercised end-to-end. Includes `ps_tx` because
    // the bump query at the end of replacePsCrudFromLegacy targets it.
    const db = getDb()
    await db.run(sql.raw(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, tx_id INTEGER, data TEXT)`))
    await db.run(sql.raw(`CREATE TABLE ps_tx (id INTEGER PRIMARY KEY, next_tx INTEGER)`))
    await db.run(sql.raw(`INSERT INTO ps_tx (id, next_tx) VALUES (1, 5)`))
    // Pre-seed a stray new-DB ps_crud row to confirm the wipe runs.
    await db.run(sql.raw(`INSERT INTO ps_crud (id, tx_id, data) VALUES (999, 99, '{"churn":true}')`))

    const seed = fullLegacySeed()
    seed.ps_crud = {
      columns: ['id', 'tx_id', 'data'],
      rows: [
        [1, 7, '{"op":"PUT","type":"chat_threads","id":"t1"}'],
        [2, 8, '{"op":"PATCH","type":"models","id":"mdl1"}'],
      ],
    }

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(seed),
    })

    expect(result.legacyPsCrudCopied).toBe(2)
    const remaining = (await db.all(sql.raw(`SELECT id, tx_id FROM ps_crud ORDER BY id`))) as readonly unknown[]
    // The data-copy step's churn row (id=999) is gone; only the two imported
    // legacy rows remain.
    expect(remaining).toHaveLength(2)
    // ps_tx.next_tx should be bumped to the max imported tx_id (8) so
    // subsequent ops don't collide.
    const tx = (await db.all(sql.raw(`SELECT next_tx FROM ps_tx WHERE id = 1`))) as readonly unknown[]
    const txRow = tx[0]
    const nextTx = Array.isArray(txRow) ? Number(txRow[0]) : Number((txRow as Record<string, unknown>).next_tx)
    expect(nextTx).toBe(8)
  })

  it('closes the legacy reader after a successful run', async () => {
    let opened: ReturnType<typeof makeFakeReader> | null = null
    await runLocalDbMigration({
      newDb: getDb(),
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: async () => {
        opened = makeFakeReader(fullLegacySeed())
        return opened
      },
    })
    expect(opened).not.toBeNull()
    expect(opened!.closed).toBe(true)
  })

  it('throws and leaves the migration unflagged when every row of a table is dropped', async () => {
    // Systematic failure: legacy rows exist but the table type's INSERT
    // fails for every one (simulated by an unparseable column). Migration
    // must refuse to mark complete so the next boot retries — silently
    // marking complete here would orphan the entire table's data.
    //
    // We trigger drops via a legacy column whose value cannot be bound by
    // SQLite (a function): every INSERT throws inside the catch.
    const unbindable = (() => () => {})()
    const seed: FakeLegacySchema = {
      chat_threads: {
        columns: ['id', 'title', 'is_encrypted', 'deleted_at', 'user_id'],
        // Three rows, each with an unbindable `title` → every insert throws.
        rows: [
          ['t1', unbindable, 0, null, 'u1'],
          ['t2', unbindable, 0, null, 'u1'],
          ['t3', unbindable, 0, null, 'u1'],
        ],
      },
    }

    await expect(
      runLocalDbMigration({
        newDb: getDb(),
        serverId,
        personalWorkspaceId,
        legacyDb: legacyDbHandle,
        openReader: openReaderFor(seed),
      }),
    ).rejects.toThrow(/every insert dropped for chat_threads/)

    expect(isDataCompletionFlagSet(serverId)).toBe(false)
    expect(isGlobalCompletionFlagSet()).toBe(false)
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBeNull()
  })

  it('sets the data-completion flag and leaves the overall flag unset when the api-key stamp throws', async () => {
    // First boot: data copy + ps_crud replacement succeed, but the api-key
    // stamp blows up. The data flag must land so the next boot's retry
    // doesn't re-run the destructive queue replacement and clobber any
    // interim user writes.
    const db = getDb()
    await db.run(sql.raw(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, tx_id INTEGER, data TEXT)`))
    await db.run(sql.raw(`CREATE TABLE ps_tx (id INTEGER PRIMARY KEY, next_tx INTEGER)`))
    await db.run(sql.raw(`INSERT INTO ps_tx (id, next_tx) VALUES (1, 0)`))

    const base = makeFakeReader(fullLegacySeed())
    const erroringReader: LegacyReader = {
      hasTable: (name) => {
        // Make the api-key stamp's models_secrets lookup throw — every earlier
        // step (table copies + ps_crud replacement) goes through this same
        // hasTable hook on the names below.
        if (name === 'models_secrets') {
          throw new Error('boom')
        }
        return base.hasTable(name)
      },
      columnNames: base.columnNames,
      selectAll: base.selectAll,
      close: base.close,
    }

    await expect(
      runLocalDbMigration({
        newDb: db,
        serverId,
        personalWorkspaceId,
        legacyDb: legacyDbHandle,
        openReader: async () => erroringReader,
      }),
    ).rejects.toThrow('boom')

    expect(isDataCompletionFlagSet(serverId)).toBe(true)
    // Global flag MUST land with the data flag — otherwise signing into a
    // second server in the failed-state window would re-read the device-global
    // legacy file and bleed this server's rows into the other account.
    expect(isGlobalCompletionFlagSet()).toBe(true)
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBeNull()
  })

  it('short-circuits on a second server after a partial-failure boot on the first (no bleed via api-key throw)', async () => {
    // Boot 1 on server A: data copy + ps_crud replacement succeed, api-key
    // stamp throws. The global flag must land alongside the data flag — if it
    // only landed after the api-key stamp, signing into server B at this point
    // would re-import the device-global legacy file into B's workspace.
    const db = getDb()
    await db.run(sql.raw(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, tx_id INTEGER, data TEXT)`))
    await db.run(sql.raw(`CREATE TABLE ps_tx (id INTEGER PRIMARY KEY, next_tx INTEGER)`))
    await db.run(sql.raw(`INSERT INTO ps_tx (id, next_tx) VALUES (1, 0)`))

    const baseA = makeFakeReader(fullLegacySeed())
    const erroringReader: LegacyReader = {
      hasTable: (name) => {
        if (name === 'models_secrets') {
          throw new Error('boom')
        }
        return baseA.hasTable(name)
      },
      columnNames: baseA.columnNames,
      selectAll: baseA.selectAll,
      close: baseA.close,
    }

    await expect(
      runLocalDbMigration({
        newDb: db,
        serverId,
        personalWorkspaceId,
        legacyDb: legacyDbHandle,
        openReader: async () => erroringReader,
      }),
    ).rejects.toThrow('boom')
    expect(isGlobalCompletionFlagSet()).toBe(true)
    await resetTestDatabase()

    // Server B sign-in: the data flag for B isn't set, but the global flag is.
    // Migration must short-circuit without opening the reader so A's rows do
    // not bleed into B's local DB.
    let openedAnything = false
    const result = await runLocalDbMigration({
      newDb: getDb(),
      serverId: otherServerId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: async () => {
        openedAnything = true
        return makeFakeReader(fullLegacySeed())
      },
    })

    expect(result.ranMigration).toBe(false)
    expect(openedAnything).toBe(false)
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${otherServerId}`)).toBe('1')
  })

  it('retries the api-key stamp on the same server even when the global flag is already set', async () => {
    // Same server as the previous test scenario, second boot. data_completed
    // and global_completed are set; the per-server completion flag is not. The
    // destructive steps must stay skipped (data_completed gates them) BUT the
    // idempotent api-key stamp must still run — otherwise the "global set"
    // short-circuit would orphan the api keys forever on this server.
    const db = getDb()
    await db.insert(modelsTable).values({
      id: 'mdl1',
      provider: 'openai',
      name: 'GPT-4',
      model: 'gpt-4',
      enabled: 1,
      workspaceId: personalWorkspaceId,
    })

    setDataCompletionFlag(serverId)
    setGlobalCompletionFlag()

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(fullLegacySeed()),
    })

    expect(result.ranMigration).toBe(true)
    expect(result.rowsInsertedByTable).toEqual({})
    expect(result.modelApiKeysCopied).toBe(1)
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, 'mdl1'))
    expect(model[0]?.apiKey).toBe('sk-legacy')
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('skips data copy and ps_crud replacement on retry when the data-completion flag is set', async () => {
    // Simulates the second-boot half of the partial-failure scenario above.
    // Pre-set the data flag, pre-seed a "user-authored after the failed boot"
    // ps_crud row, then run the migration: the destructive steps must be
    // skipped (the interim row stays, ps_crud isn't re-replaced) and the
    // api-key stamp still runs to completion.
    const db = getDb()
    await db.run(sql.raw(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY, tx_id INTEGER, data TEXT)`))
    await db.run(sql.raw(`CREATE TABLE ps_tx (id INTEGER PRIMARY KEY, next_tx INTEGER)`))
    await db.run(sql.raw(`INSERT INTO ps_tx (id, next_tx) VALUES (1, 0)`))
    await db.run(sql.raw(`INSERT INTO ps_crud (id, tx_id, data) VALUES (42, 10, '{"interim":"user-write"}')`))
    // Seed a personal-workspace model row so the api-key stamp has somewhere
    // to land — the data-copy step is skipped this run.
    await db.insert(modelsTable).values({
      id: 'mdl1',
      provider: 'openai',
      name: 'GPT-4',
      model: 'gpt-4',
      enabled: 1,
      workspaceId: personalWorkspaceId,
    })

    setDataCompletionFlag(serverId)

    const seed = fullLegacySeed()
    seed.ps_crud = {
      columns: ['id', 'tx_id', 'data'],
      rows: [[1, 7, '{"op":"PUT"}']],
    }

    const result = await runLocalDbMigration({
      newDb: db,
      serverId,
      personalWorkspaceId,
      legacyDb: legacyDbHandle,
      openReader: openReaderFor(seed),
    })

    expect(result.ranMigration).toBe(true)
    // Destructive steps skipped → no per-table counts and no ps_crud import.
    expect(result.rowsInsertedByTable).toEqual({})
    expect(result.legacyPsCrudCopied).toBe(0)
    // Interim user-authored ps_crud row must still be there.
    const remaining = (await db.all(sql.raw(`SELECT id FROM ps_crud ORDER BY id`))) as readonly unknown[]
    expect(remaining).toHaveLength(1)
    // The api-key stamp still runs — independently idempotent — and lands on
    // the seeded personal-workspace row.
    expect(result.modelApiKeysCopied).toBe(1)
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, 'mdl1'))
    expect(model[0]?.apiKey).toBe('sk-legacy')
    expect(localStorage.getItem(`pre_workspaces_attach_completed__${serverId}`)).toBe('1')
  })

  it('closes the legacy reader even if a copy step throws', async () => {
    // Reader whose hasTable starts failing midway through the table walk.
    // The migration's try/finally must still call close() so the next boot
    // doesn't leak the wa-sqlite engine handle.
    const base = makeFakeReader(fullLegacySeed())
    let calls = 0
    const erroringReader: LegacyReader = {
      hasTable: async (name) => {
        calls++
        if (calls > 2) {
          throw new Error('boom')
        }
        return base.hasTable(name)
      },
      columnNames: base.columnNames,
      selectAll: base.selectAll,
      close: base.close,
    }

    await expect(
      runLocalDbMigration({
        newDb: getDb(),
        serverId,
        personalWorkspaceId,
        legacyDb: legacyDbHandle,
        openReader: async () => erroringReader,
      }),
    ).rejects.toThrow('boom')
    expect(base.closed).toBe(true)
  })
})
