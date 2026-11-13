/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { applySchema } from '@/db/apply-schema'
import { BunSQLiteDatabase } from '@/db/bun-sqlite-database'
import { chatThreadsTable, settingsTable } from '@/db/tables'
import { maxMemoryBytes, MemoryValidationError } from '@/memory/limits'
import { getMemoryRevision } from '@/memory/revision'
import { updateSettings } from './settings'
import { getMemoryDocument, saveMemoryDocument, MemoryConflictError, MemoryDisabledError } from './memories'

describe('memory document', () => {
  let database: BunSQLiteDatabase
  beforeEach(async () => {
    database = new BunSQLiteDatabase()
    await database.initialize(':memory:')
    await applySchema(database.db)
  })
  afterEach(async () => database.close())

  it('starts empty and preserves exact freeform text, line breaks, and Unicode', async () => {
    expect(await getMemoryDocument(database.db)).toEqual({ content: '' })
    const content = '# About me\n\n' + 'A long freeform paragraph. '.repeat(20) + '\nCafé 🙂\n' + 'line\n'.repeat(60)
    expect(await saveMemoryDocument(database.db, content, { expectedContent: '' })).toEqual({ content })
    expect(await getMemoryDocument(database.db)).toEqual({ content })
  })

  it('clears by updating the settings row without deleting it', async () => {
    await saveMemoryDocument(database.db, 'Forget me.', { expectedContent: '' })
    await saveMemoryDocument(database.db, '', { expectedContent: 'Forget me.' })
    expect(await getMemoryDocument(database.db)).toEqual({ content: '' })
    expect(
      await database.db.select().from(settingsTable).where(eq(settingsTable.key, 'memory_content')).get(),
    ).toMatchObject({ key: 'memory_content', value: '' })
  })

  it('rejects stale edits and stale compaction previews without overwriting newer changes', async () => {
    await saveMemoryDocument(database.db, 'Lives in Boston.\nPrefers TypeScript.', { expectedContent: '' })
    const before = await getMemoryDocument(database.db)
    const latest = 'Lives in Chicago.\nPrefers TypeScript.'
    await saveMemoryDocument(database.db, latest, { expectedContent: before.content })
    await expect(
      saveMemoryDocument(database.db, 'Boston; TypeScript.', { expectedContent: before.content }),
    ).rejects.toBeInstanceOf(MemoryConflictError)
    expect((await getMemoryDocument(database.db)).content).toBe(latest)
  })

  it('protects a document created after another editor read the initially empty value', async () => {
    await saveMemoryDocument(database.db, 'Newly created.', { expectedContent: '' })
    await expect(saveMemoryDocument(database.db, 'Stale creation.', { expectedContent: '' })).rejects.toBeInstanceOf(
      MemoryConflictError,
    )
  })

  it('accepts opaque revisions of exact whitespace and rejects stale tokens after a whitespace-only edit', async () => {
    const before = 'Prefers TypeScript.\n'
    const revision = await getMemoryRevision(before)
    await saveMemoryDocument(database.db, before, { expectedContent: '' })
    await saveMemoryDocument(database.db, before + '\n', { expectedContent: before })
    await expect(saveMemoryDocument(database.db, 'Stale edit.', { expectedRevision: revision })).rejects.toBeInstanceOf(
      MemoryConflictError,
    )
    const currentRevision = await getMemoryRevision(before + '\n')
    await saveMemoryDocument(database.db, 'Prefers Rust.\n', { expectedRevision: currentRevision })
    expect((await getMemoryDocument(database.db)).content).toBe('Prefers Rust.\n')
  })

  it('applies the same live consent and cancellation guards to revision writes', async () => {
    await database.db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    const options = { expectedRevision: await getMemoryRevision(''), currentThreadId: 'public', requireEnabled: true }
    await expect(saveMemoryDocument(database.db, 'Denied.', options)).rejects.toBeInstanceOf(MemoryDisabledError)
    await updateSettings(database.db, { memory_enabled: true })
    await expect(
      saveMemoryDocument(database.db, 'Cancelled.', { ...options, signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    await saveMemoryDocument(database.db, 'Allowed.', options)
    expect((await getMemoryDocument(database.db)).content).toBe('Allowed.')
  })

  it('enforces UTF-8 bytes at the write boundary, including multibyte text', async () => {
    const content = '🙂'.repeat(maxMemoryBytes / 4)
    await saveMemoryDocument(database.db, content, { expectedContent: '' })
    await expect(saveMemoryDocument(database.db, content + 'a', { expectedContent: content })).rejects.toBeInstanceOf(
      MemoryValidationError,
    )
    expect((await getMemoryDocument(database.db)).content).toBe(content)
  })

  it('allows user editing while disabled but rejects agent reads and writes', async () => {
    await database.db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await saveMemoryDocument(database.db, 'Manual note.', { expectedContent: '' })
    const options = { requireEnabled: true, currentThreadId: 'public' }
    await expect(getMemoryDocument(database.db, options)).rejects.toBeInstanceOf(MemoryDisabledError)
    await expect(
      saveMemoryDocument(database.db, 'Agent note.', { ...options, expectedContent: 'Manual note.' }),
    ).rejects.toBeInstanceOf(MemoryDisabledError)
    await updateSettings(database.db, { memory_enabled: true })
    expect(await getMemoryDocument(database.db, options)).toEqual({ content: 'Manual note.' })
    await saveMemoryDocument(database.db, 'Enabled note.', { ...options, expectedContent: 'Manual note.' })
  })

  it('rechecks the selected provider after acquiring a delayed write transaction', async () => {
    await database.db.insert(chatThreadsTable).values({ id: 'public', isEncrypted: 0 })
    await updateSettings(database.db, { memory_enabled: true })
    await saveMemoryDocument(database.db, 'Existing.', { expectedContent: '' })
    const queued = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const transact = database.db.transaction.bind(database.db)
    const lock = spyOn(database.db, 'transaction').mockImplementationOnce(async (callback, config) => {
      queued.resolve()
      await release.promise
      return transact(callback, config)
    })
    try {
      const pending = saveMemoryDocument(database.db, 'Must not save.', {
        expectedContent: 'Existing.',
        currentThreadId: 'public',
        requireEnabled: true,
      })
      await queued.promise
      lock.mockRestore()
      await updateSettings(database.db, { memory_provider: 'mcp:selected-external' })
      release.resolve()
      await expect(pending).rejects.toBeInstanceOf(MemoryDisabledError)
      expect(await getMemoryDocument(database.db)).toEqual({ content: 'Existing.' })
    } finally {
      lock.mockRestore()
      release.resolve()
    }
  })

  it('fails closed for missing and deleted chats at the DAL boundary', async () => {
    await updateSettings(database.db, { memory_enabled: true })
    await database.db.insert(chatThreadsTable).values([
      { id: 'private', isEncrypted: 1 },
      { id: 'unknown', isEncrypted: null },
      { id: 'deleted', isEncrypted: 0, deletedAt: '2026-11-11' },
    ])
    for (const currentThreadId of [undefined, '', 'missing', 'deleted']) {
      const options = { requireEnabled: true, currentThreadId }
      await expect(getMemoryDocument(database.db, options)).rejects.toBeInstanceOf(MemoryDisabledError)
      await expect(
        saveMemoryDocument(database.db, 'Forbidden.', { ...options, expectedContent: '' }),
      ).rejects.toBeInstanceOf(MemoryDisabledError)
    }
    for (const currentThreadId of ['private', 'unknown']) {
      expect(await getMemoryDocument(database.db, { requireEnabled: true, currentThreadId })).toEqual({ content: '' })
    }
  })

  it('does not return or save memory after cancellation', async () => {
    await saveMemoryDocument(database.db, 'Existing.', { expectedContent: '' })
    const signal = AbortSignal.abort(new Error('Identity changed'))
    await expect(getMemoryDocument(database.db, { signal })).rejects.toThrow('Identity changed')
    await expect(saveMemoryDocument(database.db, 'Changed.', { expectedContent: 'Existing.', signal })).rejects.toThrow(
      'Identity changed',
    )
    expect(await getMemoryDocument(database.db)).toEqual({ content: 'Existing.' })
  })
})
