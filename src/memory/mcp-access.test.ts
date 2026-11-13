/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tool } from 'ai'
import { z } from 'zod'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { updateSettings } from '@/dal/settings'
import { memoryProviderForServer } from '@/memory/selection'
import { getDb } from '@/db/database'
import { chatThreadsTable, mcpServersTable } from '@/db/tables'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import { sessionHistoryLimits } from '@/session-history/limits'
import { createMemoryMcpAccess } from './mcp-access'

const provider = { id: 'selected-memory', url: 'https://mcp.mem0.ai/mcp' }

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  invalidateIdentityLifetime()
  await resetTestDatabase()
  // Legacy private chats have the same provider access and revocation rules.
  await getDb().insert(chatThreadsTable).values({ id: 'current', isEncrypted: 1 })
  await getDb()
    .insert(mcpServersTable)
    .values({ ...provider, name: 'Memory', type: 'http', enabled: 1 })
  await updateSettings(getDb(), { memory_enabled: true, memory_provider: memoryProviderForServer(provider.id) })
})

const deleteChat = () =>
  getDb().update(chatThreadsTable).set({ deletedAt: '2026-11-12' }).where(eq(chatThreadsTable.id, 'current'))
const options = { toolCallId: 'memory-provider', messages: [] }
const inputSchema = z.object({ query: z.string() })

describe('memory MCP execution boundary', () => {
  it('pins one provider across discovery checks even when live selection changes between them', async () => {
    const other = { id: 'other-memory', url: 'https://mcp.supermemory.ai/mcp' }
    await getDb()
      .insert(mcpServersTable)
      .values({ ...other, name: 'Other memory', enabled: 1 })
    const access = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id))
    expect(await access.isAllowed(provider)).toBe(true)
    await updateSettings(getDb(), { memory_provider: memoryProviderForServer(other.id) })
    expect(await access.isAllowed(other)).toBe(false)
    expect(await access.isAllowed(provider)).toBe(false)
    const nextRequest = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(other.id))
    expect(await nextRequest.isAllowed(other)).toBe(true)
    await updateSettings(getDb(), { memory_provider: 'builtin' })
    expect(await access.isAllowed()).toBe(false)
    expect(await nextRequest.isAllowed()).toBe(false)
    expect(await createMemoryMcpAccess(getDb(), 'current', 'builtin').isAllowed()).toBe(true)
  })

  it('revokes queued calls, pending results, and model conversion when the selected provider changes', async () => {
    const pending = Promise.withResolvers<string>()
    const called = Promise.withResolvers<void>()
    const execute = mock(async () => {
      called.resolve()
      return pending.promise
    })
    const convert = mock(() => ({ type: 'text' as const, value: 'old provider data' }))
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({ inputSchema, execute, toModelOutput: convert }),
    )
    const result = wrapped.execute!({ query: 'preference' }, options)
    await called.promise
    await updateSettings(getDb(), { memory_provider: 'builtin' })
    pending.resolve('Do not expose the previous provider')
    await expect(result).rejects.toThrow('unselected provider')
    await expect(wrapped.execute!({ query: 'do not send this' }, options)).rejects.toThrow('unselected provider')
    await expect(wrapped.toModelOutput!({ toolCallId: 'late', input: {}, output: 'data' })).rejects.toThrow(
      'unselected provider',
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(convert).not.toHaveBeenCalled()
  })

  it('does not send through a disabled, deleted, or replaced selected connection', async () => {
    const execute = mock(async () => 'data')
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({ inputSchema, execute }),
    )
    for (const patch of [
      { enabled: 0 },
      { enabled: 1, deletedAt: '2026-11-11' },
      { deletedAt: null, url: 'https://mcp.supermemory.ai/mcp' },
    ]) {
      await getDb().update(mcpServersTable).set(patch).where(eq(mcpServersTable.id, provider.id))
      await expect(wrapped.execute!({ query: 'do not transmit' }, options)).rejects.toThrow('unselected provider')
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks every tool name after a chat is deleted, before sending arguments externally', async () => {
    const execute = mock(async () => ({ content: [{ type: 'text', text: 'Remembered data' }] }))
    const access = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id))
    const wrapped = access.protectTool(provider, tool({ inputSchema, execute }))
    expect(await access.isAllowed(provider)).toBe(true)
    await deleteChat()
    expect(await access.isAllowed(provider)).toBe(false)
    await expect(wrapped.execute!({ query: 'private user input' }, options)).rejects.toThrow('chat is unavailable')
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes pending results after chat deletion or consent changes', async () => {
    const pending = Promise.withResolvers<string>()
    const called = Promise.withResolvers<void>()
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({
        inputSchema,
        execute: async () => {
          called.resolve()
          return pending.promise
        },
      }),
    )
    const result = wrapped.execute!({ query: 'earlier preference' }, options)
    await called.promise
    await deleteChat()
    pending.resolve('User memory must not enter the newly private context')
    await expect(result).rejects.toThrow('chat is unavailable')
  })

  it('does not invoke a stale provider closure after consent or identity is revoked', async () => {
    const execute = mock(async () => 'Saved')
    const access = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id))
    const wrapped = access.protectTool(provider, tool({ inputSchema, execute }))
    await updateSettings(getDb(), { memory_enabled: false })
    await expect(wrapped.execute!({ query: 'a fact' }, options)).rejects.toThrow('memory is disabled')
    await updateSettings(getDb(), { memory_enabled: true })
    invalidateIdentityLifetime()
    await expect(wrapped.execute!({ query: 'a fact' }, options)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('discards and closes a streaming result when its chat is deleted mid-stream', async () => {
    const pending = Promise.withResolvers<void>()
    const streaming = Promise.withResolvers<void>()
    const closed = mock(() => {})
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({
        inputSchema,
        execute: async function* () {
          try {
            yield 'First partial memory'
            streaming.resolve()
            await pending.promise
            yield 'Final private memory'
          } finally {
            closed()
          }
        },
      }),
    )
    const result = wrapped.execute!({ query: 'preference' }, options)
    await streaming.promise
    await deleteChat()
    pending.resolve()
    await expect(result).rejects.toThrow('chat is unavailable')
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('rechecks chat deletion before model-output conversion and preserves the production Pi bridge', async () => {
    const convert = mock(() => ({ type: 'text' as const, value: 'provider memory' }))
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({
        inputSchema,
        execute: async () => ({ content: [{ type: 'text', text: 'provider memory' }] }),
        toModelOutput: convert,
      }),
    )
    const [piTool] = await toPiAgentTools({ graph_read_resource: wrapped })
    const result = await piTool.execute('pi-memory', { query: 'preference' })
    expect(result.content).toEqual([{ type: 'text', text: 'provider memory' }])
    expect(convert).toHaveBeenCalledTimes(1)
    await deleteChat()
    await expect(wrapped.toModelOutput!({ toolCallId: 'late', input: {}, output: 'sensitive' })).rejects.toThrow(
      'chat is unavailable',
    )
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('bounds Unicode output before it reaches the model and limits repeated calls per send', async () => {
    const oversized = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      tool({
        inputSchema,
        execute: async () => '🔐'.repeat(sessionHistoryLimits.readBytes),
      }),
    )
    await expect(oversized.execute!({ query: 'everything' }, options)).rejects.toThrow('context budget')
    const execute = mock(async () => 'A concise fact')
    const original = tool({ inputSchema, execute })
    const wrapped = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
      provider,
      original,
    )
    for (let index = 0; index < sessionHistoryLimits.calls; index++) {
      expect(await wrapped.execute!({ query: 'preference' }, options)).toBe('A concise fact')
    }
    await expect(wrapped.execute!({ query: 'more' }, options)).rejects.toThrow('budget exhausted')
    expect(execute).toHaveBeenCalledTimes(sessionHistoryLimits.calls)
    expect(
      await createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).protectTool(
        provider,
        original,
      ).execute!({ query: 'new send' }, options),
    ).toBe('A concise fact')
  })

  it('counts converted model output against the shared budget even when raw provider results are tiny', async () => {
    const access = createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id))
    const wrapped = access.protectTool(
      provider,
      tool({
        inputSchema,
        execute: async () => 'small raw result',
        toModelOutput: () => ({ type: 'text' as const, value: 'x'.repeat(10 * 1024) }),
      }),
    )
    const [piTool] = await toPiAgentTools({ memory: wrapped })
    for (let index = 0; index < 3; index++) {
      expect((await piTool.execute(`read-${index}`, { query: 'detail' })).content).toHaveLength(1)
    }
    await expect(piTool.execute('too-much', { query: 'more' })).rejects.toThrow('context budget')
  })

  it('blocks unknown or deleted source chats even if memory remains enabled', async () => {
    const execute = mock(async () => 'data')
    for (const id of [undefined, 'missing']) {
      const access = createMemoryMcpAccess(getDb(), id, memoryProviderForServer(provider.id))
      expect(await access.isAllowed(provider)).toBe(false)
      await expect(
        access.protectTool(provider, tool({ inputSchema, execute })).execute!({ query: 'data' }, options),
      ).rejects.toThrow()
    }
    await getDb().update(chatThreadsTable).set({ deletedAt: '2026-11-11' }).where(eq(chatThreadsTable.id, 'current'))
    expect(
      await createMemoryMcpAccess(getDb(), 'current', memoryProviderForServer(provider.id)).isAllowed(provider),
    ).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
})
