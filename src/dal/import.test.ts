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
  triggersTable,
  workspaceMembershipsTable,
  workspacePermissionsTable,
  workspacesTable,
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

// Same-account fixture: `id` matches `envelope.user.id` so tests exercise
// the preserve-structure path (re-import of the user's own backup) without
// triggering the cross-account remap / id mint. Use `crossAccountUser`
// below when a test specifically wants to exercise the cross-account flow.
const currentUser = { id: 'user-1', personalWorkspaceId: 'ws-personal' }
const crossAccountUser = { id: 'current-user', personalWorkspaceId: 'ws-personal' }

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

    it('routes deliberately-excluded tables into ignoredTableNames', async () => {
      // Tampered or hand-crafted files might contain these even though our
      // exporter never produces them — they must be skipped, not written.
      const result = await importUserData(
        getDb(),
        envelope({
          devices: [{ id: 'd-1', userId: 'user-1' }],
          integrations_secrets: [{ provider: 'google', credentials: '{}' }],
          agents_system: [{ id: 'sys-1', name: 'X' }],
          workspace_memberships: [{ id: 'mem-1', workspaceId: 'ws-1', userId: 'user-1', role: 'admin' }],
          workspace_pending_memberships: [
            {
              id: 'pend-1',
              workspaceId: 'ws-1',
              email: 'alice@example.com',
              role: 'member',
              invitedByUserId: 'someone',
            },
          ],
        }),
        currentUser,
      )

      expect(result.ignoredTableNames.sort()).toEqual([
        'agents_system',
        'devices',
        'integrations_secrets',
        'workspace_memberships',
        'workspace_pending_memberships',
      ])
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

    it('re-stamps ownerUserId on workspaces with the current session user (same-account re-import)', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          workspaces: [{ id: 'ws-1', name: 'Imported', isPersonal: 0, ownerUserId: 'attacker-user' }],
        }),
        currentUser,
      )

      const row = await db.select().from(workspacesTable).where(eq(workspacesTable.id, 'ws-1')).get()
      expect(row?.ownerUserId).toBe(currentUser.id)
    })
  })

  describe('workspace tables', () => {
    it('same-account re-import preserves shared workspaces + permissions and synthesizes an admin membership', async () => {
      const db = getDb()
      const result = await importUserData(
        db,
        envelope({
          workspaces: [{ id: 'ws-1', name: 'Imported', isPersonal: 0, ownerUserId: 'someone' }],
          workspace_permissions: [
            { id: 'perm-1', workspaceId: 'ws-1', permissionKey: 'add_agents', requiredRole: 'admin' },
          ],
        }),
        currentUser,
      )

      expect(result.tables.workspaces).toEqual({ upserted: 1 })
      expect(result.tables.workspace_permissions).toEqual({ upserted: 1 })

      const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, 'ws-1')).get()
      expect(ws?.name).toBe('Imported')
      // ownerUserId is re-stamped — see the dedicated test in `userId re-stamping`.
      expect(ws?.ownerUserId).toBe(currentUser.id)

      // Synthesized membership: not in the envelope, created by the importer.
      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, 'ws-1'))
      expect(memberships).toHaveLength(1)
      expect(memberships[0]?.userId).toBe(currentUser.id)
      expect(memberships[0]?.role).toBe('admin')

      const perm = await db
        .select()
        .from(workspacePermissionsTable)
        .where(eq(workspacePermissionsTable.id, 'perm-1'))
        .get()
      expect(perm?.permissionKey).toBe('add_agents')
      expect(perm?.requiredRole).toBe('admin')
    })

    it('cross-account import drops workspace_permissions for foreign personal (avoids BE unique-index conflict on local personal)', async () => {
      const db = getDb()
      // A foreign personal collapses into local personal — its permissions
      // would land at the local personal's workspace_id, and stacked with
      // any future foreign personal's permissions would collide on the BE's
      // unique `(workspace_id, permission_key)` index. Drop them; BE
      // applies the admin-only default (Decision 11).
      await importUserData(
        db,
        envelope({
          workspaces: [{ id: 'foreign-personal', name: 'P', isPersonal: 1, ownerUserId: 'user-1' }],
          workspace_permissions: [
            {
              id: 'perm-foreign-personal',
              workspaceId: 'foreign-personal',
              permissionKey: 'add_agents',
              requiredRole: 'admin',
            },
          ],
        }),
        crossAccountUser,
      )

      const permissions = await db.select().from(workspacePermissionsTable)
      expect(permissions).toEqual([])
    })

    it('cross-account import preserves workspace_permissions for foreign shared workspaces under fresh ids', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          workspaces: [{ id: 'foreign-shared', name: 'S', isPersonal: 0 }],
          workspace_permissions: [
            {
              id: 'perm-foreign-shared',
              workspaceId: 'foreign-shared',
              permissionKey: 'add_agents',
              requiredRole: 'member',
            },
          ],
        }),
        crossAccountUser,
      )

      const permissions = await db.select().from(workspacePermissionsTable)
      expect(permissions).toHaveLength(1)
      // Id is freshly minted (BE conflict target on this table is id-only).
      expect(permissions[0]?.id).not.toBe('perm-foreign-shared')
      // workspaceId points to the workspace's new id, not the source's.
      expect(permissions[0]?.workspaceId).not.toBe('foreign-shared')
      const workspaces = await db.select().from(workspacesTable).where(eq(workspacesTable.isPersonal, 0))
      expect(workspaces).toHaveLength(1)
      expect(permissions[0]?.workspaceId).toBe(workspaces[0]?.id)
      // Policy value survives the transit verbatim.
      expect(permissions[0]?.permissionKey).toBe('add_agents')
      expect(permissions[0]?.requiredRole).toBe('member')
    })

    it('cross-account import forces orphan workspaceIds (not in the envelope`s workspaces bucket) into local personal', async () => {
      const db = getDb()
      // Hand-crafted / partial envelope: chat_threads + tasks reference a
      // workspace that the file doesn't include in its `workspaces` array.
      // Without the defensive fallback those rows would sync up under the
      // foreign id, BE would reject, and down-sync would wipe them.
      await importUserData(
        db,
        envelope({
          // No `workspaces` bucket at all.
          chat_threads: [{ id: 'orphan-thread', title: 'T', workspaceId: 'foreign-orphan-ws' }],
          tasks: [{ id: 'orphan-task', item: 'task', workspaceId: 'foreign-orphan-ws' }],
        }),
        crossAccountUser,
      )

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.workspaceId).toBe(crossAccountUser.personalWorkspaceId)

      const tasks = await db.select().from(tasksTable)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.workspaceId).toBe(crossAccountUser.personalWorkspaceId)
    })

    it('cross-account import mints a fresh id for triggers and rewrites chat_threads.triggeredBy', async () => {
      const db = getDb()
      // `triggers` share `chat_threads`/`chat_messages`'s id-only BE
      // conflict target — same wipe risk on cross-account if we kept the
      // source id. `chat_threads.triggeredBy` references the trigger id
      // and must follow the remap.
      await importUserData(
        db,
        envelope({
          triggers: [{ id: 'src-trigger', workspaceId: 'foreign-shared' }],
          chat_threads: [{ id: 'src-thread', title: 'T', triggeredBy: 'src-trigger', workspaceId: 'foreign-shared' }],
          workspaces: [{ id: 'foreign-shared', name: 'S', isPersonal: 0 }],
        }),
        crossAccountUser,
      )

      const triggers = await db.select().from(triggersTable)
      expect(triggers).toHaveLength(1)
      const newTriggerId = triggers[0]!.id
      expect(newTriggerId).not.toBe('src-trigger')

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      // triggeredBy rewritten to the new trigger id.
      expect(threads[0]?.triggeredBy).toBe(newTriggerId)
    })

    it('cross-account import mints fresh ids for chat_threads / chat_messages and rewrites chatThreadId + parentId', async () => {
      const db = getDb()
      // The BE conflict target on these two tables is `(id)` alone, so a
      // re-uploaded source id would silently no-op against the existing BE
      // row (`ON CONFLICT (id) DO UPDATE WHERE workspace_id = …` doesn't
      // match the existing row's workspace_id) and the next down-sync would
      // wipe the local rows. Cross-account mints fresh ids and rewires the
      // internal thread→message and message→message reply graph.
      await importUserData(
        db,
        envelope({
          chat_threads: [{ id: 'src-thread', title: 'T' }],
          chat_messages: [
            { id: 'src-msg-parent', chatThreadId: 'src-thread', role: 'user', parts: [{ type: 'text', text: 'a' }] },
            {
              id: 'src-msg-child',
              chatThreadId: 'src-thread',
              parentId: 'src-msg-parent',
              role: 'assistant',
              parts: [{ type: 'text', text: 'b' }],
            },
          ],
        }),
        crossAccountUser,
      )

      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      const newThreadId = threads[0]!.id
      expect(newThreadId).not.toBe('src-thread')

      const messages = await db.select().from(chatMessagesTable)
      expect(messages).toHaveLength(2)
      for (const m of messages) {
        expect(m.id).not.toBe('src-msg-parent')
        expect(m.id).not.toBe('src-msg-child')
        // chatThreadId rewritten to the new thread id.
        expect(m.chatThreadId).toBe(newThreadId)
      }

      // parentId rewritten to the new parent message id (not the source one).
      const child = messages.find((m) => m.role === 'assistant')
      const parent = messages.find((m) => m.role === 'user')
      expect(child?.parentId).toBe(parent?.id)
      expect(child?.parentId).not.toBe('src-msg-parent')
    })

    it('cross-account import preserves foreign-shared workspaces under fresh ids; folds foreign personal into local personal', async () => {
      const db = getDb()
      // Personal collapses (single-personal-per-owner BE constraint); shared
      // is preserved but under a new id (the source's id exists on the BE
      // already, would no-op the upload).
      await importUserData(
        db,
        envelope({
          workspaces: [
            { id: 'foreign-personal', name: 'Source personal', isPersonal: 1, ownerUserId: 'user-1', slug: null },
            { id: 'foreign-shared', name: 'Source shared', isPersonal: 0, slug: 'engineering' },
          ],
          chat_threads: [
            { id: 'thread-in-personal', title: 'P', workspaceId: 'foreign-personal' },
            { id: 'thread-in-shared', title: 'S', workspaceId: 'foreign-shared' },
          ],
        }),
        crossAccountUser,
      )

      // Foreign personal: skipped (collapses into local personal).
      // Foreign shared: inserted under a fresh id.
      const localWorkspaces = await db.select().from(workspacesTable)
      expect(localWorkspaces.map((w) => w.id)).not.toContain('foreign-personal')
      expect(localWorkspaces.map((w) => w.id)).not.toContain('foreign-shared')
      const sharedLocally = localWorkspaces.find((w) => w.isPersonal === 0)
      expect(sharedLocally).toBeDefined()
      expect(sharedLocally?.name).toBe('Source shared')
      // `slug` stripped on insert (BE has a global unique index on `slug`).
      expect(sharedLocally?.slug).toBeNull()

      // Threads land where they belong: foreign-personal data → local personal,
      // foreign-shared data → the freshly-minted shared workspace.
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      const titleP = threads.find((t) => t.title === 'P')
      const titleS = threads.find((t) => t.title === 'S')
      expect(titleP?.workspaceId).toBe(crossAccountUser.personalWorkspaceId)
      expect(titleS?.workspaceId).toBe(sharedLocally?.id)
      // chat_threads ids are freshly minted on cross-account.
      expect(titleP?.id).not.toBe('thread-in-personal')
      expect(titleS?.id).not.toBe('thread-in-shared')

      // Synthesized membership: importing user becomes admin of the new
      // shared workspace (and re-uses the existing membership for personal).
      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, sharedLocally!.id))
      expect(memberships).toHaveLength(1)
      expect(memberships[0]?.userId).toBe(crossAccountUser.id)
      expect(memberships[0]?.role).toBe('admin')
    })

    it('merges a foreign personal workspace into the importing user`s local personal — does not create a second isPersonal row', async () => {
      const db = getDb()
      const foreignPersonalId = 'foreign-personal-ws'
      const result = await importUserData(
        db,
        envelope({
          workspaces: [
            // Source user's personal workspace — different canonical id than the
            // importing user's. Must not land as a separate row (would conflict
            // with the BE's one-personal-per-owner unique index after re-stamp).
            { id: foreignPersonalId, name: 'Alice`s Default', isPersonal: 1, ownerUserId: 'user-1' },
          ],
          chat_threads: [
            { id: 'thread-foreign-personal', title: 'In foreign personal', workspaceId: foreignPersonalId },
          ],
        }),
        crossAccountUser,
      )

      // The foreign personal workspace row is skipped, not inserted.
      const personalRows = await db.select().from(workspacesTable).where(eq(workspacesTable.id, foreignPersonalId))
      expect(personalRows).toEqual([])
      // workspaces.upserted reflects the skip — zero rows upserted, so the bucket is absent.
      expect(result.tables.workspaces).toBeUndefined()

      // Its resources land in the importing user's personal workspace. The
      // chat_threads id is freshly minted on cross-account import — look up
      // by title since the source id no longer exists locally.
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.title).toBe('In foreign personal')
      expect(threads[0]?.workspaceId).toBe(crossAccountUser.personalWorkspaceId)
    })

    it('skips membership synthesis when the importing user is already a member of the imported workspace (same-account)', async () => {
      const db = getDb()
      // Pre-existing local membership (e.g. PowerSync down-sync prior to import).
      await db.insert(workspacesTable).values({ id: 'ws-existing', name: 'Existing', isPersonal: 0 })
      await db.insert(workspaceMembershipsTable).values({
        id: 'mem-existing',
        workspaceId: 'ws-existing',
        userId: currentUser.id,
        role: 'member',
      })

      await importUserData(
        db,
        envelope({
          workspaces: [{ id: 'ws-existing', name: 'Renamed', isPersonal: 0 }],
        }),
        currentUser,
      )

      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, 'ws-existing'))
      // Exactly one row — the pre-existing membership; role unchanged.
      expect(memberships).toHaveLength(1)
      expect(memberships[0]?.id).toBe('mem-existing')
      expect(memberships[0]?.role).toBe('member')
    })

    it('attaches pre-workspaces-v1 rows (no workspaceId in file) to the importing user`s personal workspace', async () => {
      const db = getDb()
      // Pre-v1 envelope: synced tables had no `workspace_id` column when the
      // backup was taken, so the rows arrive without one.
      await importUserData(
        db,
        envelope({
          chat_threads: [
            { id: 'thread-legacy-1', title: 'Legacy 1' },
            { id: 'thread-legacy-2', title: 'Legacy 2' },
          ],
          tasks: [{ id: 'task-legacy', item: 'Pre-v1 task' }],
        }),
        currentUser,
      )

      const threads = await db.select().from(chatThreadsTable)
      expect(threads.map((t) => t.workspaceId).sort()).toEqual([
        currentUser.personalWorkspaceId,
        currentUser.personalWorkspaceId,
      ])
      const tasks = await db.select().from(tasksTable)
      expect(tasks[0]?.workspaceId).toBe(currentUser.personalWorkspaceId)
    })

    it('same-account re-import preserves the file`s workspaceId on modern multi-workspace backups', async () => {
      const db = getDb()
      await importUserData(
        db,
        envelope({
          workspaces: [
            { id: 'ws-a', name: 'A', isPersonal: 0 },
            { id: 'ws-b', name: 'B', isPersonal: 0 },
          ],
          chat_threads: [
            { id: 'thread-a', title: 'In A', workspaceId: 'ws-a' },
            { id: 'thread-b', title: 'In B', workspaceId: 'ws-b' },
          ],
        }),
        currentUser,
      )

      const threadA = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-a')).get()
      const threadB = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, 'thread-b')).get()
      expect(threadA?.workspaceId).toBe('ws-a')
      expect(threadB?.workspaceId).toBe('ws-b')
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
