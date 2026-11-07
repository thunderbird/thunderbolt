/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { artifactId, toHtmlArtifact } from '@/artifacts/artifact'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import {
  artifactPinKey,
  artifactsFromMessages,
  getArtifactPinsQuery,
  getPresentedArtifactQuery,
  getHtmlArtifacts,
  pinnedArtifactIds,
  resolvePresentedArtifact,
  setArtifactPinned,
} from './artifacts'
import { exportUserData } from './export'
import { setupTestDatabase, teardownTestDatabase } from './test-utils'

const part = (toolCallId: string, output: unknown = { ok: true }): UIMessage['parts'][number] => ({
  type: 'dynamic-tool',
  toolName: 'render_html',
  toolCallId,
  state: 'output-available',
  input: { title: 'Same title', html: `<p>${toolCallId}</p>` },
  output,
})

const htmlId = (messageId: string, toolCallId = 'call') => artifactId({ kind: 'html', messageId, toolCallId })

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  const db = getDb()
  await db.delete(chatMessagesTable)
  await db.delete(chatThreadsTable)
  await db.delete(settingsTable)
  await db.insert(chatThreadsTable).values({ id: 'chat', title: 'Chat' })
})

/** Seed a persisted assistant response with the same JSON shape as a completed tool call. */
const seedMessage = async (id: string, parts: UIMessage['parts'], chatThreadId = 'chat') =>
  getDb().insert(chatMessagesTable).values({ id, role: 'assistant', parts, chatThreadId })

describe('artifact source persistence', () => {
  it('keeps a verified pending snapshot but honors persisted deletion and failed verification', async () => {
    const snapshot = toHtmlArtifact('pending', 'chat', part('call'))!
    expect(resolvePresentedArtifact(snapshot, undefined)).toBe(snapshot)
    await seedMessage('pending', [])
    const [unwritten] = await getPresentedArtifactQuery(getDb(), 'pending')
    expect(resolvePresentedArtifact(snapshot, unwritten)).toBe(snapshot)
    const base = { ...unwritten!, deletedAt: null, chatDeletedAt: null }
    expect(
      resolvePresentedArtifact(snapshot, { ...base, parts: [{ ...part('call'), state: 'input-streaming' }] }),
    ).toBe(snapshot)
    expect(
      resolvePresentedArtifact(snapshot, { ...base, parts: [part('call', { ok: false, errors: ['bad'] })] }),
    ).toBeNull()
    expect(resolvePresentedArtifact(snapshot, { ...base, deletedAt: '2026-01-01' })).toBeNull()
    expect(resolvePresentedArtifact(snapshot, { ...base, chatDeletedAt: '2026-01-01' })).toBeNull()
  })

  it('returns every verified call newest-first, including duplicate titles and call IDs in different messages', async () => {
    await seedMessage('001', [part('call')])
    await seedMessage('002', [part('call'), part('second'), part('failed', { ok: false, errors: ['bad'] })])
    const artifacts = await getHtmlArtifacts(getDb())
    expect(artifacts.map(({ id }) => id)).toEqual([htmlId('002'), htmlId('002', 'second'), htmlId('001')])
    expect(artifacts.map(({ title }) => title)).toEqual(['Same title', 'Same title', 'Same title'])
  })

  it('restricts reads to requested message IDs and treats an empty request as empty', async () => {
    await seedMessage('001', [part('call')])
    await seedMessage('002', [part('call')])
    expect((await getHtmlArtifacts(getDb(), ['001'])).map(({ id }) => id)).toEqual([htmlId('001')])
    expect(await getHtmlArtifacts(getDb(), [])).toEqual([])
    expect(await getHtmlArtifacts(getDb(), ['missing'])).toEqual([])
  })

  it('excludes deleted messages, deleted chats, orphaned sources, and non-assistant content', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values({ id: 'deleted-chat', deletedAt: '2026-01-01' })
    await seedMessage('live', [part('call')])
    await seedMessage('deleted-message', [part('call')])
    await db
      .update(chatMessagesTable)
      .set({ deletedAt: '2026-01-01' })
      .where(eq(chatMessagesTable.id, 'deleted-message'))
    await seedMessage('deleted-parent', [part('call')], 'deleted-chat')
    await seedMessage('missing-parent', [part('call')], 'missing-chat')
    await db.insert(chatMessagesTable).values({ id: 'user', role: 'user', parts: [part('call')], chatThreadId: 'chat' })
    expect((await getHtmlArtifacts(db)).map(({ id }) => id)).toEqual([htmlId('live')])
  })

  it('reads raw PowerSync JSON and skips malformed rows or parts independently', () => {
    const rows = [
      { id: '001', chatThreadId: 'chat', parts: JSON.stringify([null, {}, 42, { type: 7 }, part('call')]) },
      { id: '002', chatThreadId: 'chat', parts: '{broken' },
      { id: '003', chatThreadId: 'chat', parts: null },
      { id: '004', chatThreadId: 'chat', parts: { type: 'not-an-array' } },
    ]
    expect(artifactsFromMessages(rows).map(({ id }) => id)).toEqual([htmlId('001')])
  })

  it('retains identity when another part is inserted before the artifact', () => {
    const before = artifactsFromMessages([{ id: '001', chatThreadId: 'chat', parts: [part('call')] }])
    const after = artifactsFromMessages([
      { id: '001', chatThreadId: 'chat', parts: [{ type: 'text', text: 'Intro' }, part('new'), part('call')] },
    ])
    expect(after[1]?.id).toBe(before[0]?.id)
  })
})

describe('artifact pin preferences', () => {
  it('persists independent pins, explicit unpin, and re-pin without deleting content', async () => {
    const db = getDb()
    const first = htmlId('001')
    const second = artifactId({ kind: 'remote', appId: 'finance' })
    await seedMessage('001', [part('call')])
    await setArtifactPinned(db, first, true)
    await setArtifactPinned(db, second, true)
    expect(pinnedArtifactIds(await getArtifactPinsQuery(db))).toEqual([first, second])
    await setArtifactPinned(db, first, false)
    expect(await getArtifactPinsQuery(db, first)).toEqual([{ key: artifactPinKey(first), value: 'false' }])
    expect(pinnedArtifactIds(await getArtifactPinsQuery(db))).toEqual([second])
    await setArtifactPinned(db, first, true)
    expect(pinnedArtifactIds(await getArtifactPinsQuery(db))).toEqual([first, second])
    expect(await getHtmlArtifacts(db)).toHaveLength(1)
    expect(await db.select().from(settingsTable)).toHaveLength(2)
  })

  it('does not store HTML or titles in preferences and follows the source when it changes', async () => {
    const db = getDb()
    const id = htmlId('001')
    await seedMessage('001', [part('call')])
    await setArtifactPinned(db, id, true)
    await db
      .update(chatMessagesTable)
      .set({
        parts: [{ ...part('call'), input: { title: 'Changed', html: '<p>Updated</p>' } } as UIMessage['parts'][number]],
      })
      .where(eq(chatMessagesTable.id, '001'))
    expect(await getArtifactPinsQuery(db)).toEqual([{ key: artifactPinKey(id), value: 'true' }])
    expect((await getHtmlArtifacts(db))[0]?.title).toBe('Changed')
    expect((await getHtmlArtifacts(db))[0]?.source).toEqual({ kind: 'html', html: '<p>Updated</p>' })
  })

  it('rejects invalid identities and ignores malformed stored preference values', async () => {
    await expect(setArtifactPinned(getDb(), 'not-an-artifact', true)).rejects.toThrow('Invalid artifact identity')
    expect(
      pinnedArtifactIds([
        { key: artifactPinKey(htmlId('001')), value: 'true' },
        { key: artifactPinKey(htmlId('002')), value: 'false' },
        { key: artifactPinKey(htmlId('003')), value: '1' },
        { key: artifactPinKey(htmlId('004')), value: null },
        { key: artifactPinKey('bad'), value: 'true' },
        { key: `unrelated:${htmlId('005')}`, value: 'true' },
      ]),
    ).toEqual([htmlId('001')])
  })

  it('includes pins in the existing backup format automatically', async () => {
    const db = getDb()
    const id = htmlId('001')
    await seedMessage('001', [part('call')])
    await setArtifactPinned(db, id, true)
    const exported = await exportUserData(db, { id: 'owner', email: null })
    expect(exported.tables.settings).toEqual([expect.objectContaining({ key: artifactPinKey(id), value: 'true' })])
    expect(exported.tables.chat_messages).toEqual([expect.objectContaining({ id: '001', parts: [part('call')] })])
  })
})
