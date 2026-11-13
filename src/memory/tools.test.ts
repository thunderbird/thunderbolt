/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { applySchema } from '@/db/apply-schema'
import { BunSQLiteDatabase } from '@/db/bun-sqlite-database'
import { chatThreadsTable } from '@/db/tables'
import { getMemoryDocument, saveMemoryDocument } from '@/dal/memories'
import { updateSettings } from '@/dal/settings'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { toPiAgentTools } from '@shared/agent-core/mcp-tools'
import { createMemoryTools } from './tools'
import { getMemoryRevision } from './revision'
import { maxMemoryBytes, maxMemoryReadResultBytes, memoryByteLength } from './limits'

const replacement = async (content: string, before = '') => ({
  content,
  expectedRevision: await getMemoryRevision(before),
})

describe('memory document tools', () => {
  let database: BunSQLiteDatabase
  const options = { toolCallId: 'test', messages: [] }
  const tools = (currentThreadId = 'public') => createMemoryTools({ db: database.db, currentThreadId })

  beforeEach(async () => {
    invalidateIdentityLifetime()
    database = new BunSQLiteDatabase()
    await database.initialize(':memory:')
    await applySchema(database.db)
    await database.db.insert(chatThreadsTable).values([
      { id: 'public', isEncrypted: 0 },
      { id: 'private', isEncrypted: 1 },
    ])
    await updateSettings(database.db, { memory_enabled: true })
  })
  afterEach(async () => database.close())

  it('revokes old built-in reads, writes, and model output after selecting an external provider', async () => {
    const toolset = tools()
    await saveMemoryDocument(database.db, 'Built-in fact.', { expectedContent: '' })
    const output = { content: 'Built-in fact.', revision: await getMemoryRevision('Built-in fact.') }
    expect(await toolset.read_memory.execute!({}, options)).toEqual(output)
    await updateSettings(database.db, { memory_provider: 'external-connection' })
    await expect(toolset.read_memory.execute!({}, options)).rejects.toThrow('unavailable')
    await expect(
      toolset.save_memory.execute!(await replacement('Overwrite.', 'Built-in fact.'), options),
    ).rejects.toThrow('unavailable')
    await expect(toolset.read_memory.toModelOutput!({ toolCallId: 'late', input: {}, output })).rejects.toThrow(
      'unavailable',
    )
    expect(await getMemoryDocument(database.db)).toEqual({ content: 'Built-in fact.' })
    // Settings editing is independent of which provider the agent is allowed to use.
    await saveMemoryDocument(database.db, 'User edit.', { expectedContent: 'Built-in fact.' })
    expect(await getMemoryDocument(database.db)).toEqual({ content: 'User edit.' })
  })

  it('reads and replaces the complete document with an opaque revision', async () => {
    const toolset = tools()
    expect(await toolset.read_memory.execute!({}, options)).toEqual({
      content: '',
      revision: await getMemoryRevision(''),
    })
    const content = '# Preferences\n\nTypeScript examples.\nConcise answers.\n'
    expect(await toolset.save_memory.execute!(await replacement(content), options)).toEqual({ status: 'saved' })
    expect(await toolset.read_memory.execute!({}, options)).toEqual({
      content,
      revision: await getMemoryRevision(content),
    })
  })

  it('rejects stale revisions instead of dropping unrelated details', async () => {
    const toolset = tools()
    await toolset.save_memory.execute!(await replacement('Prefers TypeScript.'), options)
    await saveMemoryDocument(database.db, 'Prefers TypeScript. Lives in Boston.', {
      expectedContent: 'Prefers TypeScript.',
    })
    await expect(
      toolset.save_memory.execute!(await replacement('Prefers Python.', 'Prefers TypeScript.'), options),
    ).rejects.toThrow('changed while you were editing')
    expect((await getMemoryDocument(database.db)).content).toBe('Prefers TypeScript. Lives in Boston.')
  })

  it('supports selective forgetting and clearing without a second mutation API', async () => {
    const toolset = tools()
    const before = 'Lives in Boston.\nPrefers TypeScript.'
    await toolset.save_memory.execute!(await replacement(before), options)
    await toolset.save_memory.execute!(await replacement('Prefers TypeScript.', before), options)
    expect((await getMemoryDocument(database.db)).content).toBe('Prefers TypeScript.')
    expect(await toolset.save_memory.execute!(await replacement('', 'Prefers TypeScript.'), options)).toEqual({
      status: 'cleared',
    })
    expect(await getMemoryDocument(database.db)).toEqual({ content: '' })
  })

  it('revokes existing toolsets immediately when memory is disabled', async () => {
    const toolset = tools()
    await saveMemoryDocument(database.db, 'Existing.', { expectedContent: '' })
    await updateSettings(database.db, { memory_enabled: false })
    await expect(toolset.read_memory.execute!({}, options)).rejects.toThrow('disabled')
    await expect(toolset.save_memory.execute!(await replacement('Replacement.', 'Existing.'), options)).rejects.toThrow(
      'disabled',
    )
    expect((await getMemoryDocument(database.db)).content).toBe('Existing.')
  })

  it('denies all memory access in missing and deleted chats, including already-created tools', async () => {
    await saveMemoryDocument(database.db, 'Personal detail.', { expectedContent: '' })
    const legacyTools = tools('private')
    await expect(legacyTools.read_memory.execute!({}, options)).resolves.toMatchObject({ content: 'Personal detail.' })
    await legacyTools.save_memory.execute!(await replacement('Updated detail.', 'Personal detail.'), options)
    expect((await getMemoryDocument(database.db)).content).toBe('Updated detail.')
    for (const id of ['missing', '']) {
      await expect(tools(id).read_memory.execute!({}, options)).rejects.toThrow('unavailable')
      await expect(tools(id).save_memory.execute!(await replacement('', 'Personal detail.'), options)).rejects.toThrow(
        'unavailable',
      )
    }
    const toolset = tools()
    await database.db.update(chatThreadsTable).set({ deletedAt: '2026-11-12' }).where(eq(chatThreadsTable.id, 'public'))
    await expect(toolset.read_memory.execute!({}, options)).rejects.toThrow('unavailable')
    await expect(
      toolset.save_memory.execute!(await replacement('Forbidden.', 'Personal detail.'), options),
    ).rejects.toThrow('unavailable')
  })

  it('enforces size limits even when callers bypass JSON-schema validation', async () => {
    await expect(
      tools().save_memory.execute!(await replacement('x'.repeat(maxMemoryBytes + 1)), options),
    ).rejects.toThrow('6 KiB')
    await updateSettings(database.db, { memory_content: 'x'.repeat(maxMemoryBytes + 1) })
    await expect(tools().read_memory.execute!({}, options)).rejects.toThrow('6 KiB')
  })

  it('honors tool cancellation and invalidates reads and writes after an account change', async () => {
    const toolset = tools()
    const cancelled = { ...options, abortSignal: AbortSignal.abort() }
    await expect(toolset.read_memory.execute!({}, cancelled)).rejects.toThrow()
    await expect(toolset.save_memory.execute!(await replacement('Cancelled.'), cancelled)).rejects.toThrow()
    invalidateIdentityLifetime()
    await expect(toolset.read_memory.execute!({}, options)).rejects.toThrow()
    await expect(toolset.save_memory.execute!(await replacement('Wrong identity.'), options)).rejects.toThrow()
    expect(await getMemoryDocument(database.db)).toEqual({ content: '' })
  })

  it('lets Pi callers save a document ending in a newline without echoing that whitespace', async () => {
    const before = '# Me\nPrefers Python.\n'
    await saveMemoryDocument(database.db, before, { expectedContent: '' })
    const piTools = await toPiAgentTools(tools())
    const read = piTools.find((tool) => tool.name === 'read_memory')!
    const save = piTools.find((tool) => tool.name === 'save_memory')!
    expect(save.parameters).toMatchObject({ type: 'object', required: ['content', 'expectedRevision'] })
    expect(save.description).toContain('Remove the superseded value completely')
    expect(save.description).toContain('do not retain a change history with "previously", "used to", or "changed from"')
    const signal = new AbortController().signal
    const current = await read.execute('read', {}, signal)
    const block = current.content[0]
    if (block.type !== 'text') {
      throw new Error('Expected a memory document')
    }
    const revision = block.text.match(/^revision: (m1-[a-f0-9]{64})/)?.[1]
    expect(revision).toBe(await getMemoryRevision(before))
    expect(block.text).toContain(`--- BEGIN MEMORY ${revision} ---\n${before}\n--- END MEMORY ${revision} ---`)
    await save.execute('save', { content: '# Me\nPrefers Rust.\n', expectedRevision: revision }, signal)
    expect(await getMemoryDocument(database.db)).toEqual({ content: '# Me\nPrefers Rust.\n' })
  })

  it('counts metadata and raw control characters in per-result and repeated-read budgets', async () => {
    const content = '\u0000'.repeat(maxMemoryBytes)
    await saveMemoryDocument(database.db, content, { expectedContent: '' })
    const piTools = await toPiAgentTools(tools())
    const read = piTools.find((tool) => tool.name === 'read_memory')!
    const signal = new AbortController().signal
    for (const id of ['one', 'two', 'three']) {
      const result = await read.execute(id, {}, signal)
      const block = result.content[0]
      if (block.type !== 'text') {
        throw new Error('Expected a memory document')
      }
      expect(block.text).toContain(content)
      expect(memoryByteLength(block.text)).toBeLessThanOrEqual(maxMemoryReadResultBytes)
      expect(memoryByteLength(block.text)).toBeGreaterThan(maxMemoryBytes)
    }
    await expect(read.execute('four', {}, signal)).rejects.toThrow('read budget exhausted')
  })

  it('also bounds calls over empty documents and checks deletion before model conversion', async () => {
    const toolset = tools()
    for (let index = 0; index < 12; index += 1) {
      await toolset.read_memory.execute!({}, options)
    }
    await expect(toolset.read_memory.execute!({}, options)).rejects.toThrow('tool budget exhausted')
    await database.db.update(chatThreadsTable).set({ deletedAt: '2026-11-12' }).where(eq(chatThreadsTable.id, 'public'))
    await expect(
      toolset.read_memory.toModelOutput!({
        toolCallId: 'test',
        input: {},
        output: { content: 'Old snapshot.', revision: await getMemoryRevision('Old snapshot.') },
      }),
    ).rejects.toThrow('unavailable')
  })
})
