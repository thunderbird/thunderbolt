/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SQLiteRemoteSession } from 'drizzle-orm/sqlite-proxy'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { getChatMessages, getMessage, saveMessagesWithContextUpdate } from '@/dal/chat-messages'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import { buildAttachmentPart } from '@/lib/attachments'
import type { AgentAdapter } from '@/types/acp'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createAgentRoutingFetch } from './chat-instance'

beforeEach(async () => {
  resetStore()
  await resetTestDatabase()
})

afterAll(teardownTestDatabase)

/** A persisted alternating transcript with ordered ids, matching a hydrated chat. */
const historyFor = (threadId: string, length: number): ThunderboltUIMessage[] =>
  Array.from({ length }, (_, index) => ({
    id: `${threadId}-${index.toString().padStart(3, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `Message ${index}: ${'existing content '.repeat(100)}` }],
  }))

/** Route through the real message DAL while recording which messages cross the persistence boundary. */
const createRoutingHarness = async (threadId: string, history: ThunderboltUIMessage[]) => {
  const db = getDb()
  await db.insert(chatThreadsTable).values({ id: threadId, title: 'Existing chat', isEncrypted: 0 })
  await saveMessagesWithContextUpdate(db, threadId, history)
  hydrateStore({
    id: threadId,
    chatInstance: createMockChatInstance(history),
    chatThread: null,
    selectedModel: createMockModel(),
    triggerData: null,
  })
  const save = mock<SaveMessagesFunction>(async ({ id, messages }) => {
    await saveMessagesWithContextUpdate(db, id, messages)
  })
  const fetch = mock<AgentAdapter['fetch']>(async () => new Response('stream'))
  const adapter: AgentAdapter = {
    agent: builtInAgent,
    capabilities: null,
    fetch,
    ensureSession: async () => {},
    disconnect: async () => {},
  }
  const proxyFetch = Object.assign(async () => new Response('unused proxy'), { preconnect: async () => true })
  const connect = mock(async () => adapter)
  const route = createAgentRoutingFetch(threadId, save, {} as HttpClient, () => proxyFetch, {
    getOrConnectAdapter: connect,
    getChatReasoningEffort: async () => undefined,
  })
  return {
    save,
    fetch,
    connect,
    send: (messages: ThunderboltUIMessage[]) =>
      route('/chat', { method: 'POST', body: JSON.stringify({ id: threadId, messages }) }),
  }
}

describe('prompt persistence', () => {
  it('does not connect or send after a failed tail save, and retries the same tail without duplicating history', async () => {
    const history = historyFor('failed-save', 4)
    const request = [...history, ...historyFor('failed-save', 5).slice(-1)]
    const harness = await createRoutingHarness('failed-save', history)
    const before = await getChatMessages(getDb(), 'failed-save')
    harness.save.mockRejectedValueOnce(new Error('Storage unavailable'))

    await expect(harness.send(request)).rejects.toThrow('Storage unavailable')

    expect(harness.connect).not.toHaveBeenCalled()
    expect(harness.fetch).not.toHaveBeenCalled()
    expect(await getChatMessages(getDb(), 'failed-save')).toEqual(before)

    await harness.send(request)

    expect(harness.save.mock.calls.map(([params]) => params.messages)).toEqual([request.slice(-2), request.slice(-2)])
    expect(harness.fetch).toHaveBeenCalledTimes(1)
    const saved = await getChatMessages(getDb(), 'failed-save')
    expect(saved.map(({ id }) => id)).toEqual(request.map(({ id }) => id))
    expect(saved.slice(0, -1)).toEqual(before)
    expect(saved.at(-1)?.parentId).toBe(history.at(-1)?.id)
  })

  it('reduces a 120-message history from 241 write attempts to 3 while preserving rows and full adapter context', async () => {
    const history = historyFor('bounded', 120)
    const request = [...history, ...historyFor('bounded', 121).slice(-1)]
    const harness = await createRoutingHarness('bounded', history)
    const before = await getChatMessages(getDb(), 'bounded')
    const prepareQuery = spyOn(SQLiteRemoteSession.prototype, 'prepareQuery')
    const messageWrites = () =>
      prepareQuery.mock.calls.filter(([query]) => /^(insert into|update) "chat_messages"/.test(query.sql))
    try {
      await harness.send(request)
      expect(messageWrites()).toHaveLength(3)
      expect(harness.save.mock.calls[0]?.[0].messages).toEqual(request.slice(-2))
      expect(JSON.parse(harness.fetch.mock.calls[0]![0].body as string).messages).toEqual(request)
      expect((await getChatMessages(getDb(), 'bounded')).slice(0, -1)).toEqual(before)

      prepareQuery.mockRestore()
      const baseline = historyFor('baseline', 121)
      await createRoutingHarness('baseline', baseline.slice(0, -1))
      const baselineQueries = spyOn(SQLiteRemoteSession.prototype, 'prepareQuery')
      try {
        await saveMessagesWithContextUpdate(getDb(), 'baseline', baseline)
        expect(
          baselineQueries.mock.calls.filter(([query]) => /^(insert into|update) "chat_messages"/.test(query.sql)),
        ).toHaveLength(241)
      } finally {
        baselineQueries.mockRestore()
      }
    } finally {
      prepareQuery.mockRestore()
    }
  })

  it('inserts the previous pending assistant before the user and keeps both parents when its final save catches up', async () => {
    const transcript = historyFor('pending', 3)
    const harness = await createRoutingHarness('pending', transcript.slice(0, 1))
    harness.fetch.mockImplementation(async () => {
      expect((await getMessage(getDb(), transcript[1]!.id))?.parentId).toBe(transcript[0]!.id)
      expect((await getMessage(getDb(), transcript[2]!.id))?.parentId).toBe(transcript[1]!.id)
      return new Response('stream')
    })

    await harness.send(transcript)
    await saveMessagesWithContextUpdate(getDb(), 'pending', [transcript[1]!])

    expect(harness.fetch).toHaveBeenCalledTimes(1)
    expect((await getMessage(getDb(), transcript[1]!.id))?.parentId).toBe(transcript[0]!.id)
    expect((await getMessage(getDb(), transcript[2]!.id))?.parentId).toBe(transcript[1]!.id)
  })

  it('persists edited retry content and cleared stop metadata without resaving the older prefix', async () => {
    const history = historyFor('retry', 5)
    const harness = await createRoutingHarness('retry', history)
    const edited: ThunderboltUIMessage = {
      ...history[4]!,
      parts: [
        { type: 'text', text: 'Revised prompt and attachment delivery' },
        buildAttachmentPart({
          localFileId: 'pdf-1',
          filename: 'research.pdf',
          mimeType: 'application/pdf',
          deliverAs: 'images',
        }),
      ],
      metadata: { modelId: 'replacement-model', stoppedByUser: false },
    }
    const request = [...history.slice(0, -1), edited]

    await harness.send(request)

    expect(harness.save.mock.calls[0]?.[0].messages).toEqual([history[3]!, edited])
    expect(await getMessage(getDb(), edited.id)).toMatchObject({
      content: 'Revised prompt and attachment delivery',
      parts: edited.parts,
      metadata: edited.metadata,
    })
  })

  it.each([0, 1, 2, 3])('preserves an empty or consecutive-user request with %i messages', async (length) => {
    const messages = historyFor('users', length).map((message) => ({ ...message, role: 'user' as const }))
    const harness = await createRoutingHarness('users', messages.slice(0, -1))

    await harness.send(messages)

    expect(harness.save.mock.calls[0]?.[0].messages).toEqual(messages.slice(-2))
    expect((await getChatMessages(getDb(), 'users')).map(({ id }) => id)).toEqual(messages.map(({ id }) => id))
  })
})
