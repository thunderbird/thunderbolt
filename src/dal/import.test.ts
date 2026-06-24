/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import {
  agentsTable,
  chatMessagesTable,
  chatThreadsTable,
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
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const envelope = (tables: Record<string, unknown[]>): unknown => ({
  format: exportFormat,
  schemaVersion: exportSchemaVersion,
  exportedAt: '2026-06-16T00:00:00.000Z',
  user: { id: 'user-1', email: 'u1@example.com' },
  tables,
})

const currentUser = { id: 'current-user' }

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
      expect(summary?.exportedAtLabel).toBe(new Date('2026-06-16T00:00:00.000Z').toLocaleDateString())

      const bad = summarizeExportEnvelope({
        format: exportFormat,
        schemaVersion: exportSchemaVersion,
        exportedAt: 'not-a-date',
        user: { id: 'user-1', email: 'u1@example.com' },
        tables: {},
      })
      expect(bad?.exportedAtLabel).toBeNull()
    })

    describe('accountMismatch', () => {
      it('is false when no currentUserEmail is provided', () => {
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
        expect(summarizeExportEnvelope(payload, 'someone@example.com')?.accountMismatch).toBe(false)
      })

      it('is false when the emails match (case-insensitively)', () => {
        expect(summarizeExportEnvelope(envelope({}), 'u1@example.com')?.accountMismatch).toBe(false)
        expect(summarizeExportEnvelope(envelope({}), 'U1@Example.COM')?.accountMismatch).toBe(false)
      })

      it('is true when both emails are present and differ', () => {
        expect(summarizeExportEnvelope(envelope({}), 'someone-else@example.com')?.accountMismatch).toBe(true)
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
