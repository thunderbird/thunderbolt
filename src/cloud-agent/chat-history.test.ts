/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getChatThread, updateChatThread } from '@/dal/chat-threads'
import { useChatStore } from '@/chats/chat-store'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { CloudAgentView, CloudConversationView } from './client'
import { cloudAgentToAgent } from './agent-inventory'
import {
  createCloudChatHistoryImporter,
  persistCloudConversation,
  resumeCloudChat,
  sortCloudChatMessages,
} from './chat-history'

const agentId = '00000000-0000-4000-8000-000000000001'
const conversationId = '00000000-0000-4000-8000-000000000002'
const date = '2026-10-23T12:00:00.000Z'
const opaque = { version: 1 as const, kind: 'scoped-payload' as const, iv: 'opaque', ciphertext: 'opaque' }
const agent: CloudAgentView = {
  record: {
    id: agentId,
    ownerId: 'owner',
    version: 1,
    keyEpoch: 1,
    enabled: true,
    config: opaque,
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: 'owner',
      ephemeralPublicKey: 'opaque',
      mlkemCiphertext: 'opaque',
      iv: 'opaque',
      ciphertext: 'opaque',
    },
    createdAt: date,
    updatedAt: date,
    deletedAt: null,
  },
  config: {
    ownerRecipient: { version: 1, keyId: 'owner', ecdhPublicKey: 'opaque', mlkemPublicKey: 'opaque' },
    name: 'Cloud helper',
    description: '',
    instructions: 'Help',
    model: { provider: 'managed', modelId: 'test', contextWindow: 16000, maxOutputTokens: 1000 },
    skills: [],
    connectionIds: [],
    searchEnabled: false,
    approvalMode: 'ask',
    maxSteps: 10,
    maxRunCostUsd: 1,
  },
}
const projection = (status: 'running' | 'completed' = 'completed', id = conversationId): CloudConversationView => {
  const runs = ['first', 'second'].map((run, index) => ({
    id: run,
    commandId: index ? 'a-second-prompt' : 'z-first-prompt',
    conversationId: id,
    configVersion: 1,
    status,
    errorCode: null,
    createdAt: date,
    updatedAt: date,
  }))
  const decryptedMessages = runs.flatMap((run, index) =>
    (['user', 'assistant'] as const).map((role, offset) => ({
      record: {
        id: `${run.id}-${role}`,
        conversationId: id,
        runId: run.id,
        sequence: index * 2 + offset + 1,
        revision: 1,
        keyEpoch: 1,
        content: opaque,
        createdAt: date,
      },
      content: { role, text: role === 'user' ? `Prompt ${index + 1}` : `Reply ${index + 1}` },
    })),
  )
  return {
    conversation: { id, agentId, ownerId: 'owner', createdAt: date, updatedAt: date, deletedAt: null },
    runs,
    messages: decryptedMessages.map(({ record }) => record),
    decryptedMessages,
    approvals: [],
    decryptedApprovals: [],
    cursor: 4,
  }
}
const mountSession = (messages: ThunderboltUIMessage[] = [], status: 'ready' | 'streaming' = 'ready') => {
  const instance = createMockChatInstance(messages, status)
  const resume = mock(async () => {})
  Object.assign(instance, { resumeStream: resume })
  hydrateStore({ id: conversationId, chatInstance: instance, chatThread: null, selectedModel: null, triggerData: null })
  useChatStore.getState().updateSession(conversationId, { selectedAgent: cloudAgentToAgent(agent) })
  return { instance, resume }
}

beforeEach(async () => {
  resetStore()
  await setupTestDatabase()
})
afterEach(async () => {
  resetStore()
  await teardownTestDatabase()
})

describe('cloud history in ordinary encrypted chat storage', () => {
  it('imports once with stable turn order and parent chain, preserving user titles', async () => {
    const db = getDb()
    const first = await persistCloudConversation(db, agent, projection())
    expect(first).toMatchObject({ id: conversationId, title: 'Prompt 1', agentId: `cloud:${agentId}`, isEncrypted: 0 })
    await updateChatThread(db, conversationId, { title: 'My research' })
    await persistCloudConversation(db, agent, projection())
    expect((await getChatThread(db, conversationId))?.title).toBe('My research')
    expect(await db.select().from(chatThreadsTable)).toHaveLength(1)
    const messages = sortCloudChatMessages(await db.select().from(chatMessagesTable))
    expect(messages.map(({ id }) => id)).toEqual([
      'z-first-prompt',
      'cloud-run:first',
      'a-second-prompt',
      'cloud-run:second',
    ])
    expect(messages.map(({ parentId }) => parentId)).toEqual([
      null,
      'z-first-prompt',
      'cloud-run:first',
      'a-second-prompt',
    ])
  })

  it('rejects cross-owner projections and an existing thread pinned to another agent', async () => {
    const db = getDb()
    const wrongOwner = projection()
    wrongOwner.conversation.ownerId = 'another-owner'
    expect(await persistCloudConversation(db, agent, wrongOwner)).toBeNull()
    expect(await db.select().from(chatThreadsTable)).toHaveLength(0)
    await persistCloudConversation(db, agent, projection())
    await updateChatThread(db, conversationId, { agentId: 'other-agent' })
    expect(await persistCloudConversation(db, agent, projection())).toBeNull()
    expect((await getChatThread(db, conversationId))?.agentId).toBe('other-agent')
  })

  it('rejects a replay whose globally unique message IDs already belong to another chat', async () => {
    const db = getDb()
    await persistCloudConversation(db, agent, projection())
    const collision = projection('completed', '00000000-0000-4000-8000-000000000004')
    expect(await persistCloudConversation(db, agent, collision)).toBeNull()
    expect(await getChatThread(db, collision.conversation.id)).toBeNull()
    expect(await db.select().from(chatMessagesTable)).toHaveLength(4)
  })

  it('does not restore soft-deleted chats or scrubbed messages in storage or the live instance', async () => {
    const db = getDb()
    await persistCloudConversation(db, agent, projection())
    await db
      .update(chatMessagesTable)
      .set({ deletedAt: date, parts: null, content: null, metadata: null })
      .where(eq(chatMessagesTable.id, 'cloud-run:first'))
    const { instance } = mountSession()
    await persistCloudConversation(db, agent, projection())
    const deleted = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, 'cloud-run:first')).get()
    expect(deleted).toMatchObject({ deletedAt: date, parts: null, content: null, metadata: null })
    expect(instance.messages.some(({ id }) => id === 'cloud-run:first')).toBe(false)
    await db.update(chatThreadsTable).set({ deletedAt: date }).where(eq(chatThreadsTable.id, conversationId))
    expect(await persistCloudConversation(db, agent, projection())).toBeNull()
    expect(await getChatThread(db, conversationId)).toBeNull()
  })

  it('skips a live transport and imports its final history after it becomes idle', async () => {
    const db = getDb()
    const { instance } = mountSession([], 'streaming')
    expect(await persistCloudConversation(db, agent, projection())).toBeNull()
    expect(await db.select().from(chatMessagesTable)).toHaveLength(0)
    Object.defineProperty(instance, 'status', { value: 'ready', configurable: true })
    await persistCloudConversation(db, agent, projection())
    expect(instance.messages).toHaveLength(4)
    expect(useChatStore.getState().sessions.get(conversationId)?.chatThread?.agentId).toBe(`cloud:${agentId}`)
  })

  it('preserves unsent local user prompts without executing them or duplicating acknowledged IDs', async () => {
    const pending: ThunderboltUIMessage = { id: 'pending', role: 'user', parts: [{ type: 'text', text: 'Unsent' }] }
    const acknowledged: ThunderboltUIMessage = {
      id: 'z-first-prompt',
      role: 'user',
      parts: [{ type: 'text', text: 'Prompt 1' }],
    }
    const { instance, resume } = mountSession([acknowledged, pending])
    await persistCloudConversation(getDb(), agent, projection('running'))
    expect(instance.messages.map(({ id }) => id)).toEqual([
      'z-first-prompt',
      'cloud-run:first',
      'a-second-prompt',
      'cloud-run:second',
      'pending',
    ])
    expect(
      sortCloudChatMessages([pending, ...instance.messages.filter(({ id }) => id !== pending.id)]).at(-1)?.id,
    ).toBe('pending')
    expect(resume).not.toHaveBeenCalled()
    expect(instance.sendMessage).not.toHaveBeenCalled()
  })

  it('never refreshes another owner’s live instance', async () => {
    const { instance } = mountSession()
    useChatStore
      .getState()
      .updateSession(conversationId, { selectedAgent: { ...cloudAgentToAgent(agent), userId: 'other-owner' } })
    await persistCloudConversation(getDb(), agent, projection())
    expect(instance.messages).toHaveLength(0)
    expect(useChatStore.getState().sessions.get(conversationId)?.chatThread).toBeNull()
  })

  it('deduplicates reconnect before SDK status changes and respects stopped/disabled sessions', async () => {
    const { instance } = mountSession()
    const gate = Promise.withResolvers<void>()
    const resume = mock(() => gate.promise)
    Object.assign(instance, { resumeStream: resume })
    await persistCloudConversation(getDb(), agent, projection('running'))
    resumeCloudChat(conversationId)
    expect(resume).toHaveBeenCalledTimes(1)
    gate.resolve()
    await gate.promise
    await Promise.resolve()
    useChatStore.getState().updateSession(conversationId, { stopping: true })
    resumeCloudChat(conversationId)
    useChatStore
      .getState()
      .updateSession(conversationId, { stopping: false, selectedAgent: { ...cloudAgentToAgent(agent), enabled: 0 } })
    resumeCloudChat(conversationId)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('bounds sequential imports and revisits active runs even if the conversation timestamp is unchanged', async () => {
    const first = projection('running')
    const second = projection('completed', '00000000-0000-4000-8000-000000000003')
    // Different conversations cannot share globally unique command/run record IDs.
    second.runs = second.runs.map((run) => ({ ...run, id: `other-${run.id}`, commandId: `other-${run.commandId}` }))
    second.decryptedMessages = second.decryptedMessages.map(({ record, content }) => ({
      record: { ...record, id: `other-${record.id}`, runId: `other-${record.runId}` },
      content,
    }))
    second.messages = second.decryptedMessages.map(({ record }) => record)
    const getConversation = mock(async (_agent: CloudAgentView['record'], id: string) =>
      id === conversationId ? first : second,
    )
    const importer = createCloudChatHistoryImporter(
      getDb(),
      {
        conversations: async () => [first.conversation, second.conversation],
        getConversation,
      },
      1,
    )
    await importer([agent])
    expect(getConversation).toHaveBeenCalledTimes(1)
    await importer([agent])
    expect(getConversation).toHaveBeenCalledTimes(2)
    first.runs = first.runs.map((run) => ({ ...run, status: 'completed' }))
    await importer([agent])
    expect(getConversation).toHaveBeenCalledTimes(3)
    await importer([agent])
    await importer([agent])
    expect(getConversation).toHaveBeenCalledTimes(3)
    const abort = new AbortController()
    abort.abort()
    await importer([agent], abort.signal)
    expect(getConversation).toHaveBeenCalledTimes(3)
  })
})
