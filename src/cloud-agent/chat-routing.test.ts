/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import type { ChatTransport, UIMessageChunk } from 'ai'
import { useChatStore } from '@/chats/chat-store'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { builtInAgent } from '@/defaults/agents'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createMockHttpClient } from '@/test-utils/http-client'
import type { ThunderboltUIMessage } from '@/types'
import { cloudAgentViewFixture } from './agent-inventory-fixture'
import { cloudAgentToAgent, agentInEnvironment } from './agent-inventory'
import { createCloudAgentClient, type CloudAgentView } from './client'
import { createCloudOfflineStore } from './offline'
import { createAgentChatTransport } from './chat-routing'
import type { CloudChatApproval, createCloudChatTransport } from './chat-transport'

const id = 'conversation'
const http = createMockHttpClient()
const messages: ThunderboltUIMessage[] = [{ id: 'command', role: 'user', parts: [{ type: 'text', text: 'Task' }] }]
const options: Parameters<ChatTransport<ThunderboltUIMessage>['sendMessages']>[0] = {
  chatId: id,
  trigger: 'submit-message',
  abortSignal: undefined,
  messageId: 'command',
  messages,
}
const approval: CloudChatApproval = {
  record: {
    id: 'approval',
    agentId: cloudAgentViewFixture().record.id,
    runId: 'run',
    keyEpoch: 1,
    status: 'pending',
    payload: cloudAgentViewFixture().record.config,
    createdAt: '',
  },
  payload: { toolName: 'Publish artifact', arguments: { title: 'Draft' } },
}

/** Completed fake streams let the tests isolate environment dispatch from durable polling. */
const emptyStream = () => new ReadableStream<UIMessageChunk>({ start: (controller) => controller.close() })

/** Real client construction keeps the dependency contract intact; only inventory reads are replaced. */
const setup = (views: CloudAgentView[] = [cloudAgentViewFixture()]) => {
  hydrateStore({
    id,
    chatInstance: createMockChatInstance(messages),
    chatThread: null,
    selectedModel: createMockModel(),
    triggerData: null,
  })
  useChatStore.getState().updateSession(id, { selectedAgent: cloudAgentToAgent(views[0] ?? cloudAgentViewFixture()) })
  const fallback = { sendMessages: mock(async () => emptyStream()), reconnectToStream: mock(async () => null) }
  const saveMessages = mock(async () => {})
  const cloudSend = mock(async () => emptyStream())
  const cloudAgents = mock(async () => views)
  const cloudReconnect = mock(async () => null)
  const cloudStop = mock(async () => {})
  const created: Parameters<typeof createCloudChatTransport>[0][] = []
  const clients: string[] = []
  const router = createAgentChatTransport(
    { id, httpClient: http, fallback, saveMessages },
    {
      createClient: (http, ownerId) => {
        clients.push(ownerId)
        return {
          ...createCloudAgentClient(http, ownerId, createCloudOfflineStore(getDb(), ownerId)),
          agents: cloudAgents,
        }
      },
      createTransport: (input) => {
        created.push(input)
        return {
          sendMessages: cloudSend,
          reconnectToStream: cloudReconnect,
          stop: cloudStop,
          dispose: () => {},
          load: async () => {
            throw new Error('Unexpected load')
          },
        }
      },
    },
  )
  return { ...router, fallback, saveMessages, cloudSend, cloudAgents, cloudReconnect, cloudStop, created, clients }
}

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(resetStore)

describe('normal chat environment routing', () => {
  it('still reconnects and stops an admitted run after its definition loses the cloud model', async () => {
    const view = cloudAgentViewFixture()
    view.config.model = null
    const routed = setup([view])
    await routed.transport.reconnectToStream({ chatId: id })
    await routed.stop()
    expect(routed.cloudReconnect).toHaveBeenCalledWith({ chatId: id })
    expect(routed.cloudStop).toHaveBeenCalledTimes(1)
  })
  it('runs the same saved agent locally without admitting a cloud conversation', async () => {
    const routed = setup()
    useChatStore.getState().updateSession(id, {
      selectedAgent: agentInEnvironment(cloudAgentToAgent(cloudAgentViewFixture()), 'local'),
    })
    await routed.transport.sendMessages(options)
    await routed.transport.reconnectToStream({ chatId: id })
    await routed.stop()
    expect(routed.fallback.sendMessages).toHaveBeenCalledWith(options)
    expect(routed.fallback.reconnectToStream).toHaveBeenCalled()
    expect(routed.cloudAgents).not.toHaveBeenCalled()
    expect(routed.cloudSend).not.toHaveBeenCalled()
    expect(routed.cloudStop).not.toHaveBeenCalled()
  })
  it('dispatches cloud sends, reconnect, and Stop through the scoped transport without invoking the ACP fallback', async () => {
    const routed = setup()
    await routed.transport.sendMessages(options)
    await routed.transport.reconnectToStream({ chatId: id })
    await routed.stop()
    expect(routed.saveMessages).toHaveBeenCalledWith({ id, messages })
    expect(routed.cloudSend).toHaveBeenCalledWith(options)
    expect(routed.cloudReconnect).toHaveBeenCalledWith({ chatId: id })
    expect(routed.cloudStop).toHaveBeenCalledTimes(1)
    expect(routed.created).toHaveLength(1)
    expect(routed.fallback.sendMessages).not.toHaveBeenCalled()
    expect(routed.fallback.reconnectToStream).not.toHaveBeenCalled()
  })

  it('waits for local save, cloud binding, and send admission before an immediate Stop', async () => {
    const routed = setup()
    const saved = Promise.withResolvers<void>()
    const inventoryStarted = Promise.withResolvers<void>()
    const inventory = Promise.withResolvers<CloudAgentView[]>()
    const sendStarted = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<ReadableStream<UIMessageChunk>>()
    routed.saveMessages.mockImplementationOnce(() => saved.promise)
    routed.cloudAgents.mockImplementationOnce(() => {
      inventoryStarted.resolve()
      return inventory.promise
    })
    routed.cloudSend.mockImplementationOnce(() => {
      sendStarted.resolve()
      return admitted.promise
    })

    const sending = routed.transport.sendMessages(options)
    const stopping = routed.stop()
    await Promise.resolve()
    expect(routed.cloudAgents).not.toHaveBeenCalled()
    expect(routed.cloudStop).not.toHaveBeenCalled()

    saved.resolve()
    await inventoryStarted.promise
    expect(routed.cloudSend).not.toHaveBeenCalled()
    expect(routed.cloudStop).not.toHaveBeenCalled()

    inventory.resolve([cloudAgentViewFixture()])
    await sendStarted.promise
    expect(routed.cloudStop).not.toHaveBeenCalled()

    admitted.resolve(emptyStream())
    await sending
    await stopping
    expect(routed.cloudStop).toHaveBeenCalledTimes(1)
  })

  it('keeps ordinary agents on their existing transport and does not bind a cloud client', async () => {
    const routed = setup()
    useChatStore.getState().updateSession(id, { selectedAgent: builtInAgent })
    await routed.transport.sendMessages(options)
    await routed.transport.reconnectToStream({ chatId: id })
    await routed.stop()
    expect(routed.fallback.sendMessages).toHaveBeenCalledWith(options)
    expect(routed.fallback.reconnectToStream).toHaveBeenCalledWith({ chatId: id })
    expect(routed.clients).toEqual([])
    expect(routed.saveMessages).not.toHaveBeenCalled()
  })

  it('never sends an unavailable or differently owned resource through the fallback', async () => {
    const routed = setup([cloudAgentViewFixture('different-owner')])
    useChatStore.getState().updateSession(id, { selectedAgent: cloudAgentToAgent(cloudAgentViewFixture()) })
    await expect(routed.transport.sendMessages(options)).rejects.toThrow('no longer available')
    expect(routed.created).toEqual([])
    expect(routed.cloudSend).not.toHaveBeenCalled()
    expect(routed.fallback.sendMessages).not.toHaveBeenCalled()
  })

  it('rejects malformed reserved IDs, forged protocol summaries, and inconsistent cloud bindings before dispatch', async () => {
    const routed = setup()
    const cloud = cloudAgentToAgent(cloudAgentViewFixture())
    for (const invalid of [
      { ...cloud, id: 'cloud:invalid' },
      { ...cloud, cloudAgentId: '00000000-0000-4000-8000-000000000099' },
      { ...builtInAgent, id: cloud.id },
    ]) {
      useChatStore.getState().updateSession(id, { selectedAgent: invalid })
      await expect(routed.transport.sendMessages(options)).rejects.toThrow('selection is invalid')
      await expect(routed.transport.reconnectToStream({ chatId: id })).rejects.toThrow('selection is invalid')
    }
    expect(routed.saveMessages).not.toHaveBeenCalled()
    expect(routed.cloudSend).not.toHaveBeenCalled()
    expect(routed.fallback.sendMessages).not.toHaveBeenCalled()
    expect(routed.fallback.reconnectToStream).not.toHaveBeenCalled()
  })

  it('scopes the binding cache by owner even when the resource selection ID is identical', async () => {
    const first = cloudAgentViewFixture()
    const second = cloudAgentViewFixture('another-owner')
    const routed = setup([first, second])
    await routed.transport.sendMessages(options)
    useChatStore.getState().updateSession(id, { selectedAgent: cloudAgentToAgent(second) })
    await routed.transport.sendMessages(options)
    expect(routed.clients).toEqual(['owner', 'another-owner'])
    expect(routed.created.map((input) => input.agent.ownerId)).toEqual(['owner', 'another-owner'])
  })

  it('bridges a one-time approval without remembering access or submitting another message', async () => {
    const routed = setup()
    await routed.transport.reconnectToStream({ chatId: id })
    const permission = routed.created[0].requestPermission!
    const signal = new AbortController()
    const decision = permission(approval, signal.signal)
    const pending = useChatStore.getState().sessions.get(id)!.pendingPermission!
    expect(pending.allowRemember).toBe(false)
    expect(pending.request.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once'])
    expect(pending.request.toolCall.rawInput).toEqual(approval.payload.arguments)
    pending.resolve({ outcome: { outcome: 'selected', optionId: 'approved' } })
    pending.resolve({ outcome: { outcome: 'selected', optionId: 'denied' } })
    await expect(decision).resolves.toBe('approved')
    expect(useChatStore.getState().sessions.get(id)!.pendingPermission).toBeNull()
    expect(routed.cloudSend).not.toHaveBeenCalled()
    expect(routed.fallback.sendMessages).not.toHaveBeenCalled()
  })

  it('withdraws an obsolete dialog on abort and rejects an approval after the owner changes', async () => {
    const routed = setup()
    await routed.transport.reconnectToStream({ chatId: id })
    const permission = routed.created[0].requestPermission!
    const signal = new AbortController()
    const decision = permission(approval, signal.signal)
    signal.abort()
    await expect(decision).resolves.toBeNull()
    expect(useChatStore.getState().sessions.get(id)!.pendingPermission).toBeNull()
    useChatStore.getState().updateSession(id, { selectedAgent: cloudAgentToAgent(cloudAgentViewFixture('other')) })
    await expect(permission(approval, new AbortController().signal)).resolves.toBeNull()
    expect(useChatStore.getState().sessions.get(id)!.pendingPermission).toBeNull()
  })
})
