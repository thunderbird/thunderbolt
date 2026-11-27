/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { createModel as createAiModel } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { generateText } from 'ai'
import {
  agentsTable,
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsSecretsTable,
  modelsTable,
  settingsTable,
  tasksTable,
} from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { exportFormat, exportSchemaVersion } from './export'
import { derivePkSpec, ImportFormatError, importUserData, summarizeExportEnvelope } from './import'
import {
  getMcpServerCredentialRows,
  getMcpServerCredentialsFor,
  parseMcpCredentialSummary,
  setMcpServerCredentials,
} from './mcp-secrets'
import { getChatMessages, getLastMessage } from './chat-messages'
import { createMcpServerWithCredentials } from './mcp-servers'
import { createModel, getModel } from './models'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const currentUser = { id: 'current-user', email: null, deviceId: 'device-1' }
const signedOut = { id: null, email: null, deviceId: 'device-1' }

/** Exported by the importing account unless `user` says otherwise, so a single-chat file keeps its ids. */
const envelope = (
  tables: Record<string, unknown[]>,
  user: { id: string; email: string | null } = { id: currentUser.id, email: 'u1@example.com' },
): unknown => ({
  format: exportFormat,
  schemaVersion: exportSchemaVersion,
  exportedAt: '2026-06-16T00:00:00.000Z',
  user,
  tables,
})

describe('Import DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('envelope validation', () => {
    it('rejects non-object payloads', async () => {
      await expect(importUserData(getDb(), null, currentUser)).rejects.toBeInstanceOf(ImportFormatError)
      await expect(importUserData(getDb(), 'not-json', currentUser)).rejects.toBeInstanceOf(ImportFormatError)
      await expect(importUserData(getDb(), [], currentUser)).rejects.toBeInstanceOf(ImportFormatError)
    })

    it('rejects unrecognized format strings', async () => {
      await expect(
        importUserData(getDb(), { format: 'something-else', schemaVersion: 1, tables: {} }, currentUser),
      ).rejects.toBeInstanceOf(ImportFormatError)
    })

    it('rejects unsupported schemaVersion', async () => {
      await expect(
        importUserData(getDb(), { format: exportFormat, schemaVersion: 99, tables: {} }, currentUser),
      ).rejects.toBeInstanceOf(ImportFormatError)
    })

    it('rejects when `tables` is missing or not an object', async () => {
      await expect(
        importUserData(getDb(), { format: exportFormat, schemaVersion: 1 }, currentUser),
      ).rejects.toBeInstanceOf(ImportFormatError)
      await expect(
        importUserData(getDb(), { format: exportFormat, schemaVersion: 1, tables: 'nope' }, currentUser),
      ).rejects.toBeInstanceOf(ImportFormatError)
    })
  })

  describe('upsert semantics', () => {
    it('inserts rows from a fresh DB', async () => {
      const result = await importUserData(
        getDb(),
        envelope({
          chat_threads: [
            { id: 'thread-1', title: 'One' },
            { id: 'thread-2', title: 'Two' },
          ],
          tasks: [{ id: 'task-1', item: 'do this' }],
        }),
        currentUser,
      )

      expect(result.schemaVersion).toBe(1)
      expect(result.tables.chat_threads).toEqual({ upserted: 2 })
      expect(result.tables.tasks).toEqual({ upserted: 1 })
      expect(result.ignoredTableNames).toEqual([])

      const threads = await getDb().select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.find((t) => t.id === 'thread-1')?.title).toBe('One')
    })

    it('imported row wins on PK collision (replace mode)', async () => {
      const db = getDb()
      await db.insert(chatThreadsTable).values({ id: 'thread-1', title: 'Local value' })

      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-1', title: 'Imported value' }],
        }),
        currentUser,
      )

      const row = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-1')).get()
      expect(row?.title).toBe('Imported value')
    })

    it('leaves local rows whose PK is not in the file untouched', async () => {
      const db = getDb()
      await db.insert(chatThreadsTable).values([
        { id: 'thread-keep', title: 'Local only' },
        { id: 'thread-collide', title: 'Local value' },
      ])

      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-collide', title: 'Imported value' }],
        }),
        currentUser,
      )

      const rows = await db.select().from(chatThreadsTable)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.id === 'thread-keep')?.title).toBe('Local only')
      expect(rows.find((r) => r.id === 'thread-collide')?.title).toBe('Imported value')
    })

    it('preserves soft-deleted rows verbatim (deletedAt written through)', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          chat_threads: [
            { id: 'thread-active', title: 'Active' },
            { id: 'thread-trash', title: 'Trash', deletedAt: '2026-06-01T00:00:00.000Z' },
          ],
        }),
        currentUser,
      )

      const trash = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-trash')).get()
      expect(trash?.deletedAt).toBe('2026-06-01T00:00:00.000Z')
    })

    it('round-trips chat_messages JSON columns (parts / metadata) without losing structure', async () => {
      const db = getDb()
      const parts = [{ type: 'text', text: 'hello' }]
      const metadata = { modelId: 'model-x' }
      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-1', title: 't' }],
          chat_messages: [{ id: 'msg-1', chatThreadId: 'thread-1', role: 'user', parts, metadata, cache: {} }],
        }),
        currentUser,
      )

      const row = (await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, 'msg-1')).get()) as
        | { parts: unknown; metadata: unknown }
        | undefined
      expect(row?.parts).toEqual(parts)
      expect(row?.metadata).toEqual(metadata)
    })

    it('upserts settings by their `key` PK', async () => {
      const db = getDb()
      await db.insert(settingsTable).values({ key: 'theme', value: 'light' })

      await importUserData(
        db,
        envelope({
          settings: [
            { key: 'theme', value: 'dark' },
            { key: 'preferred_name', value: 'Alice' },
          ],
        }),
        currentUser,
      )

      const all = await db.select().from(settingsTable)
      expect(all.find((s) => s.key === 'theme')?.value).toBe('dark')
      expect(all.find((s) => s.key === 'preferred_name')?.value).toBe('Alice')
    })

    it('upserts secrets via the parent table id (models_secrets)', async () => {
      const db = getDb()
      await db.insert(modelsTable).values({ id: 'model-1', provider: 'custom', name: 'Mine' })
      await db.insert(modelsSecretsTable).values({ modelId: 'model-1', apiKey: 'sk-local' })

      await importUserData(
        db,
        envelope({
          models_secrets: [{ modelId: 'model-1', apiKey: 'sk-imported' }],
        }),
        currentUser,
      )

      const row = await db.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, 'model-1')).get()
      expect(row?.apiKey).toBe('sk-imported')
    })
  })

  describe('credential destinations', () => {
    /** Runs one completion through the production AI client and reports where it went and with what key. */
    const sendThroughAiClient = async (model: Model) => {
      const sent = { url: '', authorization: null as string | null }
      const capture: FetchFn = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.url = String(input)
          sent.authorization = new Headers(init?.headers).get('authorization')
          return Response.json({
            id: 'completion',
            object: 'chat.completion',
            created: 0,
            model: 'llama',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: async () => false },
      )
      await generateText({ model: await createAiModel(model, () => capture), prompt: 'hi' })
      return sent
    }

    const goodUrl = 'https://llm.example.com/v1'
    const evilUrl = 'https://evil.example.com/v1'
    const mcpUrl = 'https://mcp.example.com/mcp'
    const evilMcpUrl = 'https://evil.example.com/mcp'

    it('a backup that moves a model id to another URL without its key leaves the local key behind', async () => {
      const db = getDb()
      await createModel(db, {
        id: 'model-1',
        provider: 'custom',
        name: 'Mine',
        model: 'llama',
        url: goodUrl,
        apiKey: 'sk-mine',
      })

      await importUserData(db, envelope({ models: [{ id: 'model-1', provider: 'custom', url: evilUrl }] }), currentUser)

      const model = await getModel(db, 'model-1')
      expect(model?.url).toBe(evilUrl)
      expect(model?.apiKey).toBeNull()
      const sent = await sendThroughAiClient(model!)
      expect(sent.url).toBe(`${evilUrl}/chat/completions`)
      expect(sent.authorization).toBeNull()
    })

    it('still authenticates a model whose destination did not change', async () => {
      const db = getDb()
      await createModel(db, {
        id: 'model-1',
        provider: 'custom',
        name: 'Mine',
        model: 'llama',
        url: goodUrl,
        apiKey: 'sk-mine',
      })

      const sent = await sendThroughAiClient((await getModel(db, 'model-1'))!)

      expect(sent).toEqual({ url: `${goodUrl}/chat/completions`, authorization: 'Bearer sk-mine' })
    })

    it('a backup that moves an MCP server id to another URL without its credential leaves it behind', async () => {
      const db = getDb()
      await createMcpServerWithCredentials(
        db,
        { id: 'mcp-1', name: 'Mine', type: 'http', url: mcpUrl, enabled: 1 },
        { type: 'bearer', token: 'mine' },
      )

      await importUserData(db, envelope({ mcp_servers: [{ id: 'mcp-1', url: evilMcpUrl }] }), currentUser)

      expect(await getMcpServerCredentialsFor(db, 'mcp-1', evilMcpUrl)).toBeNull()
      expect((await getMcpServerCredentialRows(db)).map(parseMcpCredentialSummary)).toEqual([null])
    })

    it('a partial secret row cannot keep the local key while rebinding it', async () => {
      const db = getDb()
      await createModel(db, {
        id: 'model-1',
        provider: 'custom',
        name: 'Mine',
        model: 'llama',
        url: goodUrl,
        apiKey: 'sk-mine',
      })

      await importUserData(
        db,
        envelope({
          models: [{ id: 'model-1', url: evilUrl }],
          models_secrets: [{ modelId: 'model-1', provider: 'custom', url: evilUrl }],
        }),
        currentUser,
      )

      expect((await getModel(db, 'model-1'))?.apiKey).toBeNull()
      const row = await db.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, 'model-1')).get()
      expect(row?.apiKey).toBeNull()
    })

    it('binds a local key saved before binding to its own URL, not the one the backup brings', async () => {
      const db = getDb()
      await db
        .insert(modelsTable)
        .values({ id: 'model-1', provider: 'custom', name: 'Mine', model: 'llama', url: goodUrl })
      await db.insert(modelsSecretsTable).values({ modelId: 'model-1', apiKey: 'sk-legacy' })
      await db.insert(mcpServersTable).values({ id: 'mcp-1', name: 'Mine', type: 'http', url: mcpUrl, enabled: 1 })
      await setMcpServerCredentials(db, 'mcp-1', { type: 'bearer', token: 'legacy' })

      await importUserData(
        db,
        envelope({ models: [{ id: 'model-1', url: evilUrl }], mcp_servers: [{ id: 'mcp-1', url: evilMcpUrl }] }),
        currentUser,
      )

      expect((await getModel(db, 'model-1'))?.apiKey).toBeNull()
      expect(await getMcpServerCredentialsFor(db, 'mcp-1', evilMcpUrl)).toBeNull()
      expect(await getMcpServerCredentialsFor(db, 'mcp-1', mcpUrl)).toMatchObject({ token: 'legacy' })
    })

    it('restores the keys of a backup written before binding against the restored URLs', async () => {
      const db = getDb()

      await importUserData(
        db,
        envelope({
          models: [{ id: 'model-1', provider: 'custom', name: 'Mine', model: 'llama', url: goodUrl }],
          models_secrets: [{ modelId: 'model-1', apiKey: 'sk-backup' }],
          mcp_servers: [{ id: 'mcp-1', name: 'Mine', type: 'http', url: mcpUrl, enabled: 1 }],
          mcp_secrets: [{ id: 'mcp-1', credentials: JSON.stringify({ type: 'bearer', token: 'backup' }) }],
        }),
        currentUser,
      )

      expect((await getModel(db, 'model-1'))?.apiKey).toBe('sk-backup')
      expect(await getMcpServerCredentialsFor(db, 'mcp-1', mcpUrl)).toMatchObject({ token: 'backup' })
    })

    it('keeps the local key when the backup re-spells the same URL', async () => {
      const db = getDb()
      await createModel(db, {
        id: 'model-1',
        provider: 'custom',
        name: 'Mine',
        model: 'llama',
        url: goodUrl,
        apiKey: 'sk-mine',
      })

      await importUserData(
        db,
        envelope({ models: [{ id: 'model-1', url: 'HTTPS://LLM.example.com:443/v1/' }] }),
        currentUser,
      )

      expect((await getModel(db, 'model-1'))?.apiKey).toBe('sk-mine')
    })

    it('keeps the local key when the backup leaves the destination alone', async () => {
      const db = getDb()
      await createModel(db, {
        id: 'model-1',
        provider: 'custom',
        name: 'Mine',
        model: 'llama',
        url: goodUrl,
        apiKey: 'sk-mine',
      })

      await importUserData(db, envelope({ models: [{ id: 'model-1', name: 'Renamed', url: goodUrl }] }), currentUser)

      expect((await getModel(db, 'model-1'))?.apiKey).toBe('sk-mine')
    })
  })

  describe('forward-compat & robustness', () => {
    it('silently skips table keys the importer does not recognize', async () => {
      const result = await importUserData(
        getDb(),
        envelope({
          chat_threads: [{ id: 'thread-1', title: 'One' }],
          future_table_v2: [{ id: 'x' }],
          another_unknown: [],
        }),
        currentUser,
      )

      expect(result.ignoredTableNames.sort()).toEqual(['another_unknown', 'future_table_v2'])
      const threads = await getDb().select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('routes deliberately-excluded tables (devices / integrations_secrets / agents_system) into ignoredTableNames', async () => {
      // Tampered or hand-crafted files might contain these even though our
      // exporter never produces them — they must be skipped, not written.
      const result = await importUserData(
        getDb(),
        envelope({
          devices: [{ id: 'd-1', userId: 'user-1' }],
          integrations_secrets: [{ provider: 'google', credentials: '{}' }],
          agents_system: [{ id: 'sys-1', name: 'X' }],
        }),
        currentUser,
      )

      expect(result.ignoredTableNames.sort()).toEqual(['agents_system', 'devices', 'integrations_secrets'])
    })

    it('skips empty table arrays without counting them', async () => {
      const result = await importUserData(
        getDb(),
        envelope({
          chat_threads: [],
          tasks: [{ id: 'task-1', item: 'go' }],
        }),
        currentUser,
      )
      expect(result.tables.chat_threads).toBeUndefined()
      expect(result.tables.tasks).toEqual({ upserted: 1 })
    })

    it('rolls the whole transaction back when any row fails', async () => {
      const db = getDb()
      // Seed something we can verify survives a rolled-back import.
      await db.insert(chatThreadsTable).values({ id: 'thread-prior', title: 'Was here first' })

      // Two threads succeed; agent row violates NOT NULL on `name` → throws inside the tx.
      // (`userId` is no longer a candidate — the importer stamps it from the session.)
      const payload = envelope({
        chat_threads: [
          { id: 'thread-good-1', title: 'Good 1' },
          { id: 'thread-good-2', title: 'Good 2' },
        ],
        agents: [{ id: 'agent-broken', type: 'remote-acp', transport: 'websocket', url: 'wss://x' }],
        tasks: [{ id: 'task-after-bad', item: 'should not exist' }],
      })

      await expect(importUserData(db, payload, currentUser)).rejects.toBeDefined()

      // The two 'thread-good' inserts must have been rolled back.
      const threads = await db.select().from(chatThreadsTable)
      expect(threads.map((t) => t.id).sort()).toEqual(['thread-prior'])
      const tasks = await db.select().from(tasksTable)
      expect(tasks).toEqual([])
      const agents = await db.select().from(agentsTable)
      expect(agents).toEqual([])
    })

    it('throws ImportFormatError when a row inside an included table is not an object', async () => {
      await expect(
        importUserData(
          getDb(),
          envelope({
            chat_threads: ['not an object'],
          }),
          currentUser,
        ),
      ).rejects.toBeInstanceOf(ImportFormatError)
    })
  })

  describe('userId re-stamping', () => {
    it.each(['insert', 'replace'])('keeps signed-out %s imports unowned', async (operation) => {
      const db = getDb()
      if (operation === 'replace') {
        await db.insert(tasksTable).values({ id: 'task-1', item: 'Old', userId: 'previous-owner' })
      }
      await importUserData(
        db,
        envelope({ tasks: [{ id: 'task-1', item: 'Restored', userId: 'exported-owner' }] }, { id: '', email: null }),
        signedOut,
      )

      const row = await db.select().from(tasksTable).where(eq(tasksTable.id, 'task-1')).get()
      expect(row?.item).toBe('Restored')
      expect(row?.userId).toBeNull()
    })

    it('overwrites the file-provided userId with the current session user on synced tables', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-1', title: 'T', userId: 'attacker-user' }],
        }),
        currentUser,
      )

      const row = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-1')).get()
      expect(row?.userId).toBe(currentUser.id)
    })

    it('stamps userId even when the imported row omits it', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-1', title: 'T' }],
        }),
        currentUser,
      )

      const row = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-1')).get()
      expect(row?.userId).toBe(currentUser.id)
    })

    it('does not add a userId column to tables that lack one (e.g. models_secrets)', async () => {
      const db = getDb()
      await db.insert(modelsTable).values({ id: 'model-1', provider: 'custom', name: 'Mine' })

      await importUserData(
        db,
        envelope({
          models_secrets: [{ modelId: 'model-1', apiKey: 'sk-imported' }],
        }),
        currentUser,
      )

      const row = await db.select().from(modelsSecretsTable).where(eq(modelsSecretsTable.modelId, 'model-1')).get()
      expect(row?.apiKey).toBe('sk-imported')
    })

    it('re-stamps userId on the UPDATE path too (PK collision)', async () => {
      const db = getDb()
      await db.insert(chatThreadsTable).values({ id: 'thread-1', title: 'Local', userId: currentUser.id })

      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'thread-1', title: 'Imported', userId: 'attacker-user' }],
        }),
        currentUser,
      )

      const row = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-1')).get()
      expect(row?.title).toBe('Imported')
      expect(row?.userId).toBe(currentUser.id)
    })
  })

  describe('single-chat files', () => {
    const otherAccount = { id: 'other-user', email: 'other@example.com' }
    const chat = {
      chat_threads: [{ id: 'thread-1', title: 'Shared', projectId: 'project-1', deletedAt: null }],
      chat_messages: [
        { id: 'm1', chatThreadId: 'thread-1', role: 'user', parentId: null, content: 'hi' },
        { id: 'm2', chatThreadId: 'thread-1', role: 'assistant', parentId: 'm1', content: 'hello' },
      ],
    }

    it('keeps the ids of a chat exported by the same account', async () => {
      const db = getDb()
      await db.insert(chatThreadsTable).values({ id: 'thread-1', title: 'Old', deletedAt: '2026-06-01' })
      await importUserData(db, envelope(chat), currentUser)

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]).toMatchObject({ id: 'thread-1', title: 'Shared', projectId: 'project-1', deletedAt: null })
    })

    it('gives a chat from another account ids of its own, keeping the message tree', async () => {
      const db = getDb()
      await importUserData(db, envelope(chat, otherAccount), currentUser)

      const [thread] = await db.select().from(chatThreadsTable)
      expect(thread.id).toBe('673ee6ac-8f18-5962-a6ed-42c4858dcdab')
      expect(thread).toMatchObject({ title: 'Shared', projectId: null, userId: currentUser.id })
      const rows = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, thread.id))
      const first = rows.find((row) => row.content === 'hi')
      const second = rows.find((row) => row.content === 'hello')
      expect(first?.id).not.toBe('m1')
      expect(first?.parentId).toBeNull()
      expect(second?.parentId).toBe(first?.id)
    })

    it('keeps the ids of a chat exported under the same email by a recreated account', async () => {
      const db = getDb()
      await importUserData(db, envelope(chat, { id: 'deleted-account', email: 'Me@example.com' }), {
        ...currentUser,
        email: 'me@example.com',
      })

      expect((await db.select().from(chatThreadsTable)).map((row) => row.id)).toEqual(['thread-1'])
    })

    it.each([
      ['a signed-out export imported signed in', { id: '', email: null }, currentUser],
      ['a signed-in export imported signed out', { id: currentUser.id, email: 'me@example.com' }, signedOut],
      ['a signed-out export imported signed out', { id: '', email: null }, signedOut],
    ])('copies %s, since no account ties the two', async (_case, exportedBy, importer) => {
      const db = getDb()
      await importUserData(db, envelope(chat, exportedBy), importer)

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0].id).not.toBe('thread-1')
    })

    it('keys a chat copied in while signed out to this device', async () => {
      const db = getDb()
      await importUserData(db, envelope(chat, { id: '', email: null }), signedOut)

      const [thread] = await db.select().from(chatThreadsTable)
      expect(thread.id).toBe('20f44588-4c37-5d65-aa52-0053ed697756')
      expect(thread.userId).toBeNull()
    })

    it('copies a chat from a file that names no exporting account', async () => {
      const db = getDb()
      await importUserData(db, { format: exportFormat, schemaVersion: exportSchemaVersion, tables: chat }, currentUser)

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0].id).not.toBe('thread-1')
    })

    it('copies a chat from another email even when the user ids match', async () => {
      const db = getDb()
      await importUserData(db, envelope(chat, { id: currentUser.id, email: 'other@example.com' }), {
        ...currentUser,
        email: 'me@example.com',
      })

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0].id).not.toBe('thread-1')
    })

    it.each([
      ['from another account', otherAccount],
      ['from this account', { id: currentUser.id, email: null }],
    ])('writes only the chat of a marked chat file %s, ignoring its other tables', async (_case, exportedBy) => {
      const db = getDb()
      await db.insert(modelsTable).values({ id: 'model-1', name: 'Mine', provider: 'custom', url: 'https://mine.test' })
      const marked = {
        format: exportFormat,
        schemaVersion: exportSchemaVersion,
        kind: 'chat',
        user: exportedBy,
        tables: {
          ...chat,
          tasks: [{ id: 'task-1', item: 'Extra' }],
          models: [{ id: 'model-1', name: 'Hijacked', provider: 'custom', url: 'https://attacker.test' }],
        },
      }
      const result = await importUserData(db, marked, currentUser)

      expect(await db.select().from(chatThreadsTable)).toHaveLength(1)
      expect(await db.select().from(tasksTable)).toHaveLength(0)
      expect((await db.select().from(modelsTable).where(eq(modelsTable.id, 'model-1')).get())?.url).toBe(
        'https://mine.test',
      )
      expect(result.ignoredTableNames.sort()).toEqual(['models', 'tasks'])
      expect(Object.keys(result.tables).sort()).toEqual(['chat_messages', 'chat_threads'])
    })

    it('lists a copied chat in its original order, continuing from its last message', async () => {
      const db = getDb()
      // uuid v7 ids, as the app writes them: the copy must keep their time order.
      const ids = [
        '019a1b2c-3d4e-7000-8000-00000000000a',
        '019a1b2c-3d4e-7001-8000-000000000001',
        '019a1b2c-3d4f-7000-8000-000000000005',
      ]
      const threadId = '019a1b2c-3d4d-7000-8000-000000000000'
      const ordered = {
        chat_threads: [{ id: threadId, title: 'Ordered', deletedAt: null }],
        chat_messages: ids.map((id, index) => ({
          id,
          chatThreadId: threadId,
          role: index % 2 ? 'assistant' : 'user',
          parentId: ids[index - 1] ?? null,
          content: `message ${index}`,
          deletedAt: null,
        })),
      }
      await importUserData(db, envelope(ordered, otherAccount), currentUser)

      const [thread] = await db.select().from(chatThreadsTable)
      const messages = await getChatMessages(db, thread.id)
      expect(messages.map((message) => message.content)).toEqual(['message 0', 'message 1', 'message 2'])
      expect((await getLastMessage(db, thread.id))?.id).toBe(messages[2].id)
    })

    it('updates the copy when the same foreign chat is imported again', async () => {
      const db = getDb()
      await importUserData(db, envelope(chat, otherAccount), currentUser)
      await importUserData(db, envelope(chat, otherAccount), currentUser)

      expect(await db.select().from(chatThreadsTable)).toHaveLength(1)
      expect(await db.select().from(chatMessagesTable)).toHaveLength(2)
    })

    it('keeps the ids of a full backup from another account', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({ ...chat, tasks: [{ id: 'task-1', item: 'Do it' }] }, otherAccount),
        currentUser,
      )

      const threads = await db.select().from(chatThreadsTable)
      expect(threads.map((row) => row.id)).toEqual(['thread-1'])
    })
  })

  describe('summarizeExportEnvelope', () => {
    it('returns null for non-envelope payloads', () => {
      expect(summarizeExportEnvelope(null)).toBeNull()
      expect(summarizeExportEnvelope('not-json')).toBeNull()
      expect(summarizeExportEnvelope([])).toBeNull()
      expect(summarizeExportEnvelope({})).toBeNull()
    })

    it('returns null when the format slug is wrong', () => {
      expect(summarizeExportEnvelope({ format: 'something-else', schemaVersion: 1, tables: {} })).toBeNull()
    })

    it('returns null on unsupported schemaVersion (matching importUserData)', () => {
      expect(summarizeExportEnvelope({ format: exportFormat, schemaVersion: 99, tables: {} })).toBeNull()
    })

    it('returns null when `tables` is missing or not an object', () => {
      expect(summarizeExportEnvelope({ format: exportFormat, schemaVersion: exportSchemaVersion })).toBeNull()
      expect(
        summarizeExportEnvelope({ format: exportFormat, schemaVersion: exportSchemaVersion, tables: 'nope' }),
      ).toBeNull()
    })

    it('counts every array-valued bucket and ignores non-array values', () => {
      const summary = summarizeExportEnvelope(
        envelope({
          chat_threads: [{ id: 'a' }, { id: 'b' }],
          tasks: [{ id: 'c' }],
          settings: [],
          // @ts-expect-error – deliberately a non-array bucket
          junk: 'not an array',
        }),
      )
      expect(summary?.totalRows).toBe(3)
    })

    it('extracts the source email when present', () => {
      const summary = summarizeExportEnvelope(envelope({}))
      expect(summary?.sourceEmail).toBe('u1@example.com')
    })

    it('returns sourceEmail = null when user / email are missing or not strings', () => {
      const payload = {
        format: exportFormat,
        schemaVersion: exportSchemaVersion,
        exportedAt: '2026-06-16T00:00:00.000Z',
        user: { id: 'user-1', email: null },
        tables: {},
      }
      expect(summarizeExportEnvelope(payload)?.sourceEmail).toBeNull()
      expect(summarizeExportEnvelope({ ...payload, user: undefined })?.sourceEmail).toBeNull()
    })

    it('formats exportedAt to a locale date and returns null on garbage', () => {
      const summary = summarizeExportEnvelope(envelope({}))
      // A literal rather than a second call to the formatter, so the assertion
      // pins the format: an unambiguous medium-style date, not a locale-ordered
      // numeric one. `bun test` runs in UTC, so the day doesn't drift.
      expect(summary?.exportedAtLabel).toBe('Jun 16, 2026')

      const bad = summarizeExportEnvelope({
        format: exportFormat,
        schemaVersion: exportSchemaVersion,
        exportedAt: 'not-a-date',
        user: { id: 'user-1', email: 'u1@example.com' },
        tables: {},
      })
      expect(bad?.exportedAtLabel).toBeNull()
    })

    it('describes a single-chat file and leaves a full backup without a chat', () => {
      const chatFile = envelope({
        chat_threads: [{ id: 'thread-1', title: 'Shared' }],
        chat_messages: [{ id: 'm1', chatThreadId: 'thread-1' }],
      })
      expect(summarizeExportEnvelope(chatFile, currentUser)?.chat).toEqual({
        title: 'Shared',
        messageCount: 1,
        isCopy: false,
      })
      expect(summarizeExportEnvelope(chatFile, { id: 'someone-else', email: null })?.chat?.isCopy).toBe(true)
      expect(
        summarizeExportEnvelope(envelope({ chat_threads: [{ id: 'thread-1' }], tasks: [{ id: 'task-1' }] }))?.chat,
      ).toBeNull()
    })

    describe('accountMismatch', () => {
      it('is false when the importing user has no email', () => {
        expect(summarizeExportEnvelope(envelope({}))?.accountMismatch).toBe(false)
      })

      it('is false when the envelope has no sourceEmail (legacy export)', () => {
        const payload = {
          format: exportFormat,
          schemaVersion: exportSchemaVersion,
          exportedAt: '2026-06-16T00:00:00.000Z',
          user: { id: 'user-1', email: null },
          tables: {},
        }
        expect(summarizeExportEnvelope(payload, { id: null, email: 'someone@example.com' })?.accountMismatch).toBe(
          false,
        )
      })

      it('is false when the emails match (case-insensitively)', () => {
        expect(summarizeExportEnvelope(envelope({}), { id: null, email: 'u1@example.com' })?.accountMismatch).toBe(
          false,
        )
        expect(summarizeExportEnvelope(envelope({}), { id: null, email: 'U1@Example.COM' })?.accountMismatch).toBe(
          false,
        )
      })

      it('is true when both emails are present and differ', () => {
        expect(
          summarizeExportEnvelope(envelope({}), { id: null, email: 'someone-else@example.com' })?.accountMismatch,
        ).toBe(true)
      })
    })
  })

  describe('derivePkSpec', () => {
    // Suppress drizzle's "no PK" warning in stderr; we expect the throw.
    const silenceConsoleWarn = (fn: () => void) => {
      const original = console.warn
      console.warn = () => undefined
      try {
        fn()
      } finally {
        console.warn = original
      }
    }

    it('throws when a table has no primary-key column', () => {
      const noPk = sqliteTable('no_pk', { a: text('a'), b: text('b') })
      silenceConsoleWarn(() => {
        expect(() => derivePkSpec('no_pk', noPk)).toThrow(/exactly one/)
      })
    })

    it('throws when a table has multiple primary-key columns', () => {
      const multiPk = sqliteTable('multi_pk', {
        a: text('a').primaryKey(),
        b: text('b').primaryKey(),
      })
      silenceConsoleWarn(() => {
        expect(() => derivePkSpec('multi_pk', multiPk)).toThrow(/exactly one/)
      })
    })

    it('recovers the JS field name even when it differs from the SQL column name', () => {
      const aliased = sqliteTable('aliased', {
        externalId: text('id').primaryKey(),
        payload: text('payload').default(sql`''`),
      })
      const spec = derivePkSpec('aliased', aliased)
      expect(spec.field).toBe('externalId')
      expect(spec.column).toBe(aliased.externalId)
    })
  })
})
