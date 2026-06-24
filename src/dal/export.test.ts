/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import {
  agentsSecretsTable,
  agentsSystemTable,
  agentsTable,
  chatMessagesTable,
  chatThreadsTable,
  devicesTable,
  integrationsSecretsTable,
  mcpSecretsTable,
  mcpServersTable,
  modelsSecretsTable,
  modelsTable,
  settingsTable,
  tasksTable,
  workspaceMembershipsTable,
  workspacePermissionsTable,
  workspacesTable,
} from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { exportFormat, exportSchemaVersion, exportUserData, exportedTableNames } from './export'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Export DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('returns a properly stamped envelope with all expected table buckets', async () => {
    const exported = await exportUserData(getDb(), { id: 'user-1', email: 'u1@example.com' })

    expect(exported.format).toBe(exportFormat)
    expect(exported.schemaVersion).toBe(exportSchemaVersion)
    expect(new Date(exported.exportedAt).toString()).not.toBe('Invalid Date')
    expect(exported.user).toEqual({ id: 'user-1', email: 'u1@example.com' })
    // Explicit allowlist: a new schema table will trip this test and force
    // a conscious include-or-exclude decision (vs. silently leaking through).
    const expectedKeys: string[] = [
      'agents',
      'agents_secrets',
      'chat_messages',
      'chat_threads',
      'mcp_secrets',
      'mcp_servers',
      'model_profiles',
      'models',
      'models_secrets',
      'modes',
      'prompts',
      'settings',
      'skills',
      'tasks',
      'triggers',
      // Workspaces and their permissions travel with the backup so a
      // restore reinstates them offline. `workspace_memberships` and
      // `workspace_pending_memberships` are BE-authoritative and excluded
      // — see `excludedFromExport` in `./export.ts` for the rationale.
      'workspace_permissions',
      'workspaces',
    ]
    const actualKeys = Object.keys(exported.tables).sort() as string[]
    expect(actualKeys).toEqual(expectedKeys.sort())
    expect([...exportedTableNames].sort() as string[]).toEqual(expectedKeys.slice().sort())
  })

  it('returns every local row across the included tables', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values([
      { id: 'thread-1', title: 'One' },
      { id: 'thread-2', title: 'Two' },
    ])
    await db.insert(tasksTable).values([
      { id: 'task-1', item: 'One' },
      { id: 'task-2', item: 'Two' },
    ])
    await db.insert(settingsTable).values([
      { key: 'pref:a', value: 'a' },
      { key: 'pref:b', value: 'b' },
    ])
    await db.insert(modelsTable).values({ id: 'model-1', provider: 'custom', name: 'Mine' })
    await db.insert(modelsSecretsTable).values({ modelId: 'model-1', apiKey: 'sk-mine' })
    await db.insert(agentsTable).values({
      id: 'agent-1',
      userId: 'user-1',
      name: 'Mine',
      type: 'remote-acp',
      transport: 'websocket',
      url: 'wss://mine',
    })
    await db.insert(agentsSecretsTable).values({ agentId: 'agent-1', apiKey: 'k-mine' })
    await db.insert(mcpServersTable).values({ id: 'mcp-1', name: 'Mine', type: 'http', url: 'https://mine' })
    await db.insert(mcpSecretsTable).values({ id: 'mcp-1', credentials: '{"type":"bearer","token":"mine"}' })

    const exported = await exportUserData(db, { id: 'user-1', email: null })

    expect(exported.tables.chat_threads).toHaveLength(2)
    expect(exported.tables.tasks).toHaveLength(2)
    expect(exported.tables.settings).toHaveLength(2)
    expect(exported.tables.models).toHaveLength(1)
    expect(exported.tables.models_secrets).toHaveLength(1)
    expect(exported.tables.agents).toHaveLength(1)
    expect(exported.tables.agents_secrets).toHaveLength(1)
    expect(exported.tables.mcp_servers).toHaveLength(1)
    expect(exported.tables.mcp_secrets).toHaveLength(1)
  })

  it('includes soft-deleted rows so restore can reinstate the trash state', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values([
      { id: 'thread-active', title: 'Active' },
      { id: 'thread-deleted', title: 'Deleted', deletedAt: '2026-06-01T00:00:00.000Z' },
    ])

    const exported = await exportUserData(db, { id: 'user-1', email: null })

    const ids = exported.tables.chat_threads.map((row) => (row as { id: string }).id).sort()
    expect(ids).toEqual(['thread-active', 'thread-deleted'])
  })

  it('omits tables that are intentionally excluded from the export', async () => {
    const db = getDb()
    await db.insert(devicesTable).values({ id: 'device-1', userId: 'user-1', name: 'Mine' })
    await db.insert(integrationsSecretsTable).values({ provider: 'google', credentials: '{"oauth":1}' })
    await db.insert(agentsSystemTable).values({
      id: 'sys-1',
      name: 'Haystack',
      type: 'managed-acp',
      transport: 'websocket',
      url: 'wss://sys',
      fetchedAt: '2026-06-01T00:00:00.000Z',
    })

    const exported = await exportUserData(db, { id: 'user-1', email: null })
    const tableKeys = Object.keys(exported.tables) as Array<keyof typeof exported.tables>

    expect(tableKeys).not.toContain('devices')
    expect(tableKeys).not.toContain('integrations_secrets')
    expect(tableKeys).not.toContain('agents_system')
    expect(tableKeys).not.toContain('workspace_memberships')
    expect(tableKeys).not.toContain('workspace_pending_memberships')
  })

  it('preserves chat message JSON columns (parts / metadata / cache) as parsed objects', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values({ id: 'thread-1', title: 't' })
    await db.insert(chatMessagesTable).values({
      id: 'msg-1',
      chatThreadId: 'thread-1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
      metadata: { modelId: 'model-x' },
      cache: {},
    })

    const exported = await exportUserData(db, { id: 'user-1', email: null })
    const [message] = exported.tables.chat_messages as Array<{
      parts: unknown
      metadata: unknown
    }>
    expect(message?.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(message?.metadata).toEqual({ modelId: 'model-x' })
  })

  it('returns empty arrays for tables when the local DB is empty', async () => {
    // `resetTestDatabase` seeds a Personal workspace so component tests can
    // resolve `useActiveWorkspaceId`. Strip it here so every bucket — including
    // `workspaces` — starts truly empty for the assertion.
    await getDb().delete(workspacesTable)
    const exported = await exportUserData(getDb(), { id: 'user-1', email: null })
    for (const rows of Object.values(exported.tables)) {
      expect(rows).toEqual([])
    }
  })

  it('exports workspaces (admin-only) and their permissions', async () => {
    const db = getDb()
    // Seed an extra workspace + the corresponding admin membership +
    // a permission so we can verify the export carries the full workspace
    // graph the user admins. Memberships are excluded from the envelope —
    // see `excludedFromExport`.
    await db.insert(workspacesTable).values({
      id: 'ws-extra',
      name: 'Extra',
      isPersonal: 0,
    })
    await db.insert(workspaceMembershipsTable).values({
      id: 'mem-self-extra',
      workspaceId: 'ws-extra',
      userId: 'user-1',
      role: 'admin',
    })
    await db.insert(workspacePermissionsTable).values({
      id: 'ws-extra-add_agents',
      workspaceId: 'ws-extra',
      permissionKey: 'add_agents',
      requiredRole: 'admin',
    })

    const exported = await exportUserData(db, { id: 'user-1', email: null })

    const workspaceIds = (exported.tables.workspaces as Array<{ id: string }>).map((row) => row.id).sort()
    expect(workspaceIds).toContain('ws-extra')
    expect(exported.tables.workspace_permissions).toHaveLength(1)
  })

  it('omits workspaces the user only has a `member` (non-admin) membership for', async () => {
    const db = getDb()
    // Two shared workspaces — one the user admins, one they joined as a
    // member. Only the admin'd one ends up in the envelope.
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', name: 'Mine', isPersonal: 0 },
      { id: 'ws-theirs', name: 'Theirs', isPersonal: 0 },
    ])
    await db.insert(workspaceMembershipsTable).values([
      { id: 'mem-self-mine', workspaceId: 'ws-mine', userId: 'user-1', role: 'admin' },
      { id: 'mem-self-theirs', workspaceId: 'ws-theirs', userId: 'user-1', role: 'member' },
    ])

    const exported = await exportUserData(db, { id: 'user-1', email: null })

    const ids = (exported.tables.workspaces as Array<{ id: string }>).map((row) => row.id).sort()
    expect(ids).toContain('ws-mine')
    expect(ids).not.toContain('ws-theirs')
  })

  it('omits workspace_memberships from the envelope even when local rows exist', async () => {
    const db = getDb()
    await db.insert(workspacesTable).values({
      id: 'ws-shared',
      name: 'Shared',
      isPersonal: 0,
    })
    await db.insert(workspaceMembershipsTable).values([
      { id: 'mem-self', workspaceId: 'ws-shared', userId: 'user-1', role: 'admin' },
      // Co-member's row synced down via `workspace_data` — its userName /
      // userEmail must not leak into the backup.
      {
        id: 'mem-bob',
        workspaceId: 'ws-shared',
        userId: 'user-2',
        userName: 'Bob',
        userEmail: 'bob@example.com',
        role: 'member',
      },
    ])

    const exported = await exportUserData(db, { id: 'user-1', email: null })

    const tableKeys = Object.keys(exported.tables) as Array<keyof typeof exported.tables>
    expect(tableKeys).not.toContain('workspace_memberships')
  })
})
