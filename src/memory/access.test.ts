/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { memoryProviderForServer } from '@/memory/selection'
import { getDb } from '@/db/database'
import { chatThreadsTable, mcpServersTable } from '@/db/tables'
import { canUseSavedMemory } from './access'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)

describe('saved memory access', () => {
  it('denies missing consent, unknown chats, deleted chats, and any private or unknown classification', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values([
      { id: 'public', isEncrypted: 0 },
      { id: 'private', isEncrypted: 1 },
      { id: 'unknown', isEncrypted: null },
      { id: 'deleted', isEncrypted: 0, deletedAt: '2026-11-11' },
    ])
    expect(await canUseSavedMemory(db, 'public')).toBe(false)
    await updateSettings(db, { memory_enabled: true })
    expect(await canUseSavedMemory(db, 'public')).toBe(true)
    for (const id of [undefined, '', 'missing', 'private', 'unknown', 'deleted']) {
      expect(await canUseSavedMemory(db, id)).toBe(false)
    }
  })

  it('rechecks consent and thread privacy after a toolset was prepared', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await updateSettings(db, { memory_enabled: true })
    const allowed = () => canUseSavedMemory(db, 'public')
    expect(await allowed()).toBe(true)
    await db.update(chatThreadsTable).set({ isEncrypted: 1 }).where(eq(chatThreadsTable.id, 'public'))
    expect(await allowed()).toBe(false)
    await db.update(chatThreadsTable).set({ isEncrypted: 0 }).where(eq(chatThreadsTable.id, 'public'))
    expect(await allowed()).toBe(true)
    await updateSettings(db, { memory_enabled: false })
    expect(await allowed()).toBe(false)
  })

  it('defaults only missing selections to Built-in and never falls back from an unavailable connection', async () => {
    const db = getDb()
    const provider = { id: 'memory-connection', url: 'https://mcp.mem0.ai/mcp' }
    await db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await db.insert(mcpServersTable).values({ ...provider, name: 'Memory', enabled: 1 })
    await updateSettings(db, { memory_enabled: true })
    expect(await canUseSavedMemory(db, 'public')).toBe(true)
    expect(await canUseSavedMemory(db, 'public', provider)).toBe(false)
    await updateSettings(db, { memory_provider: memoryProviderForServer(provider.id) })
    expect(await canUseSavedMemory(db, 'public')).toBe(false)
    expect(await canUseSavedMemory(db, 'public', provider)).toBe(true)
    for (const patch of [{ enabled: 0 }, { enabled: 1, deletedAt: '2026-11-11' }]) {
      await db.update(mcpServersTable).set(patch).where(eq(mcpServersTable.id, provider.id))
      expect(await canUseSavedMemory(db, 'public', provider)).toBe(false)
      expect(await canUseSavedMemory(db, 'public')).toBe(false)
    }
    for (const selection of ['missing-id', '']) {
      await updateSettings(db, { memory_provider: selection })
      expect(await canUseSavedMemory(db, 'public')).toBe(false)
      expect(await canUseSavedMemory(db, 'public', provider)).toBe(false)
    }
  })

  it('rejects stale connection endpoints and ordinary MCP servers even when their IDs are selected', async () => {
    const db = getDb()
    const provider = { id: 'memory-connection', url: 'https://mcp.mem0.ai/mcp' }
    await db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await db.insert(mcpServersTable).values({ ...provider, name: 'Memory', enabled: 1 })
    await updateSettings(db, { memory_enabled: true, memory_provider: memoryProviderForServer(provider.id) })
    await db
      .update(mcpServersTable)
      .set({ url: 'https://mcp.supermemory.ai/mcp' })
      .where(eq(mcpServersTable.id, provider.id))
    expect(await canUseSavedMemory(db, 'public', provider)).toBe(false)
    const ordinary = { ...provider, url: 'https://calendar.example/mcp' }
    await db.update(mcpServersTable).set({ url: ordinary.url }).where(eq(mcpServersTable.id, provider.id))
    expect(await canUseSavedMemory(db, 'public', ordinary)).toBe(false)
  })

  it('separates imported connection IDs from the Built-in sentinel and rejects raw legacy IDs', async () => {
    const db = getDb()
    const provider = { id: 'builtin', url: 'https://mcp.mem0.ai/mcp' }
    await db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await db.insert(mcpServersTable).values({ ...provider, name: 'Imported', enabled: 1 })
    await updateSettings(db, { memory_enabled: true, memory_provider: 'builtin' })
    expect(await canUseSavedMemory(db, 'public')).toBe(true)
    expect(await canUseSavedMemory(db, 'public', provider)).toBe(false)
    await updateSettings(db, { memory_provider: memoryProviderForServer(provider.id) })
    expect(await canUseSavedMemory(db, 'public')).toBe(false)
    expect(await canUseSavedMemory(db, 'public', provider)).toBe(true)
    await updateSettings(db, { memory_provider: 'raw-connection-id' })
    expect(await canUseSavedMemory(db, 'public')).toBe(false)
    expect(await canUseSavedMemory(db, 'public', { ...provider, id: 'raw-connection-id' })).toBe(false)
  })
})
