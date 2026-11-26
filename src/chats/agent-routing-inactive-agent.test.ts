/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * An open chat keeps the agent object it picked. These tests disable or delete
 * that agent, through the DAL as Settings does and by writing the row directly
 * as a sync from another device does, and check that the next send reaches
 * neither the cached connection nor a new one. Sends run through the real
 * adapter cache and the real agent rows; only the connection itself is faked.
 */

import '@/testing-library'
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { useChatStore } from '@/chats/chat-store'
import { createAgent, deleteAgent, updateAgent } from '@/dal/agents'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { agentsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import { nowIso } from '@/lib/utils'
import type { Agent, AgentAdapter } from '@/types/acp'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createAgentRoutingFetch } from './chat-instance'

const threadId = 'inactive-agent-thread'

const remoteAgent: Agent = {
  id: 'remote-agent',
  name: 'Remote',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://agent.test/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'u1',
}

const writeSyncedRow = (patch: Partial<typeof agentsTable.$inferInsert>) =>
  getDb().update(agentsTable).set(patch).where(eq(agentsTable.id, remoteAgent.id))

const deactivations = [
  ['disabled in Settings', () => updateAgent(getDb(), remoteAgent.id, { enabled: 0 })],
  ['deleted in Settings', () => deleteAgent(getDb(), remoteAgent.id)],
  ['disabled by a sync', () => writeSyncedRow({ enabled: 0 })],
  ['deleted by a sync', () => writeSyncedRow({ deletedAt: nowIso() })],
] as const

beforeEach(async () => {
  resetStore()
  await resetTestDatabase()
  await createAgent(getDb(), {
    id: remoteAgent.id,
    name: remoteAgent.name,
    type: 'remote-acp',
    transport: 'websocket',
    url: 'wss://agent.test/ws',
    userId: 'u1',
  })
})

afterAll(teardownTestDatabase)

/** Open a chat on `agent`, counting the connections it opens and the prompts it dispatches. */
const openChat = (agent: Agent, onConnect: () => Promise<void> = async () => {}) => {
  const model = createMockModel()
  hydrateStore({
    id: threadId,
    chatInstance: createMockChatInstance(),
    chatThread: null,
    models: [model],
    selectedModel: model,
    triggerData: null,
  })
  useChatStore.getState().updateSession(threadId, { selectedAgent: agent })
  const prompts = mock<AgentAdapter['fetch']>(async () => new Response('stream'))
  const connectToAgent = mock(async (connected: Agent): Promise<AgentAdapter> => {
    await onConnect()
    return { agent: connected, capabilities: null, fetch: prompts, ensureSession: async () => {}, disconnect: () => {} }
  })
  const saveMessages = mock(async () => {})
  const proxyFetch = Object.assign(async () => new Response('unused proxy'), { preconnect: async () => true })
  const route = createAgentRoutingFetch(threadId, saveMessages, {} as HttpClient, () => proxyFetch, {
    connectToAgent,
    getChatReasoningEffort: async () => undefined,
    getAvailableModels: async () => useChatStore.getState().models,
  })
  let turn = 0
  const send = () => {
    turn += 1
    const messages = [{ id: `prompt-${turn}`, role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]
    return route('/chat', { method: 'POST', body: JSON.stringify({ id: threadId, messages }) })
  }
  return { send, prompts, connectToAgent, saveMessages }
}

describe('sending from a chat whose agent was disabled or deleted', () => {
  it.each(deactivations)('refuses the next send once the agent is %s, without reconnecting', async (_, deactivate) => {
    const chat = openChat(remoteAgent)
    await chat.send()
    expect(chat.prompts).toHaveBeenCalledTimes(1)

    await deactivate()
    await expect(chat.send()).rejects.toThrow('"kind":"agent-unavailable"')

    expect(chat.prompts).toHaveBeenCalledTimes(1)
    expect(chat.connectToAgent).toHaveBeenCalledTimes(1)
    // The refused prompt is not saved, so a reload cannot auto-run it on a fallback agent.
    expect(chat.saveMessages).toHaveBeenCalledTimes(1)
  })

  it('refuses the prompt when the agent is disabled while its connection opens', async () => {
    const chat = openChat(remoteAgent, async () => {
      await writeSyncedRow({ enabled: 0 })
    })

    await expect(chat.send()).rejects.toThrow('"kind":"agent-unavailable"')

    expect(chat.prompts).not.toHaveBeenCalled()
  })

  it('keeps sending to an agent that is still enabled', async () => {
    const chat = openChat(remoteAgent)

    await chat.send()
    await chat.send()

    expect(chat.prompts).toHaveBeenCalledTimes(2)
    expect(chat.connectToAgent).toHaveBeenCalledTimes(1)
  })

  it('sends on the built-in agent, which has no row to check', async () => {
    const chat = openChat(builtInAgent)

    await chat.send()

    expect(chat.prompts).toHaveBeenCalledTimes(1)
  })

  it('sends again once the user moves the chat to another agent', async () => {
    const chat = openChat(remoteAgent)
    await deleteAgent(getDb(), remoteAgent.id)
    await expect(chat.send()).rejects.toThrow('"kind":"agent-unavailable"')

    useChatStore.getState().updateSession(threadId, { selectedAgent: builtInAgent })
    await chat.send()

    expect(chat.prompts).toHaveBeenCalledTimes(1)
    expect(chat.connectToAgent.mock.calls.map(([agent]) => agent.id)).toEqual([builtInAgent.id])
  })
})
