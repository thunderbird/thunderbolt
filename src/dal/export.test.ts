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
} from '@/db/tables'
import type { UIMessageMetadata } from '@/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { exportChatThread, exportFormat, exportSchemaVersion, exportUserData, exportedTableNames } from './export'
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
      'provider_connections',
      'provider_connection_secrets',
      'projects',
      'prompts',
      'settings',
      'skills',
      'tasks',
      'triggers',
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
    const exported = await exportUserData(getDb(), { id: 'user-1', email: null })
    for (const rows of Object.values(exported.tables)) {
      expect(rows).toEqual([])
    }
  })

  describe('exportChatThread', () => {
    it('holds only the thread and its live messages, edited-away branches included', async () => {
      const db = getDb()
      await db.insert(chatThreadsTable).values([
        { id: 'thread-1', title: 'Mine' },
        { id: 'thread-2', title: 'Other' },
      ])
      await db.insert(chatMessagesTable).values([
        { id: 'm1', chatThreadId: 'thread-1', role: 'user', content: 'hi' },
        { id: 'm2', chatThreadId: 'thread-1', role: 'assistant', parentId: 'm1' },
        { id: 'm2-edit', chatThreadId: 'thread-1', role: 'assistant', parentId: 'm1' },
        { id: 'm-deleted', chatThreadId: 'thread-1', role: 'user', deletedAt: '2026-06-16' },
        { id: 'm3', chatThreadId: 'thread-2', role: 'user' },
      ])
      await db.insert(tasksTable).values({ id: 'task-1', item: 'Not exported' })

      const exported = await exportChatThread(db, 'thread-1', { id: 'user-1', email: 'u1@example.com' })

      expect(exported.format).toBe(exportFormat)
      expect(exported.schemaVersion).toBe(exportSchemaVersion)
      expect(exported.kind).toBe('chat')
      expect(exported.user).toEqual({ id: 'user-1', email: 'u1@example.com' })
      expect(Object.keys(exported.tables).sort()).toEqual(['chat_messages', 'chat_threads'])
      expect(exported.tables.chat_threads.map((row) => row.id)).toEqual(['thread-1'])
      expect(exported.tables.chat_messages.map((row) => row.id).sort()).toEqual(['m1', 'm2', 'm2-edit'])
    })

    it('leaves out owners, MCP URL paths and debug links, which a shared file must not carry', async () => {
      const db = getDb()
      // Messages saved before `mcpTools` existed named their servers in `mcpServers`.
      const storedMetadata: UIMessageMetadata & { mcpServers: Record<string, { url: string }> } = {
        modelId: 'model-1',
        debugTranscript: {
          traceId: 'trace-1',
          engine: 'pi',
          modelId: 'model-1',
          modelName: 'Model',
          provider: 'custom',
          agentId: 'agent-1',
        },
        mcpTools: {
          docs_search: { name: 'Docs', url: 'https://user:pass@mcp.example.com/sse?token=secret', toolName: 'search' },
        },
        mcpServers: { docs: { url: 'https://mcp.example.com/sse?token=legacy-secret' } },
      }
      await db.insert(chatThreadsTable).values({ id: 'thread-1', title: 'Mine', userId: 'user-1' })
      await db.insert(chatMessagesTable).values({
        id: 'm1',
        chatThreadId: 'thread-1',
        role: 'assistant',
        userId: 'user-1',
        metadata: storedMetadata,
      })

      const exported = await exportChatThread(db, 'thread-1', { id: 'user-1', email: null })
      const [message] = exported.tables.chat_messages

      expect(exported.tables.chat_threads[0]).not.toHaveProperty('userId')
      expect(message).not.toHaveProperty('userId')
      expect(message.metadata).toEqual({
        modelId: 'model-1',
        mcpTools: { docs_search: { name: 'Docs', url: 'https://mcp.example.com', toolName: 'search' } },
      })
      expect(JSON.stringify(exported)).not.toContain('secret')
    })

    it('throws for a chat that does not exist', async () => {
      await expect(exportChatThread(getDb(), 'missing', { id: 'user-1', email: null })).rejects.toThrow()
    })
  })
})
