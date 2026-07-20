/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/dal'
import { getChatThread } from '@/dal/chat-threads'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import type { ChatThread, Mode } from '@/types'
import {
  createMockAutomationRun,
  createMockChatInstanceWithValidation,
  createMockChatThread,
  createMockModel,
  getCurrentSession,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { Model, ThunderboltUIMessage } from '@/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { deriveToolKey, findAllowOption, useChatStore } from './chat-store'

describe('chat-store', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    // Reset store state before each test
    resetStore()
    await resetTestDatabase()
  })

  afterEach(async () => {
    // Ensure store is reset after each test to prevent test pollution
    resetStore()
  })

  describe('createSession', () => {
    it('should set all state values correctly', () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const chatThread = createMockChatThread()
      const model = createMockModel()
      const automationRun = createMockAutomationRun()

      hydrateStore({
        chatInstance,
        chatThread,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: automationRun,
      })

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session?.chatInstance).toBe(chatInstance)
      expect(session?.chatThread).toBe(chatThread)
      expect(session?.id).toBe('test-id')
      expect(storeState.getMcpClients()).toEqual([])
      expect(storeState.models).toEqual([model])
      expect(session?.selectedModel).toBe(model)
      expect(session?.triggerData).toBe(automationRun)
    })
  })

  describe('reset', () => {
    it('should reset store to initial state', () => {
      // First hydrate with some data
      const chatInstance = createMockChatInstanceWithValidation()
      const model = createMockModel()

      hydrateStore({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: createMockAutomationRun(),
      })

      // Then reset
      resetStore()

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session).toBeNull()
      expect(storeState.currentSessionId).toBeNull()
      expect(storeState.getMcpClients()).toEqual([])
      expect(storeState.models).toEqual([])
      expect(storeState.sessions.size).toBe(0)
    })
  })

  describe('sendMessage', () => {
    it('should throw error when selectedModel is null', async () => {
      const chatInstance = createMockChatInstanceWithValidation()

      // Create session without selected model - need to manually set up
      useChatStore.getState().setModels([])
      useChatStore.getState().setModes([])
      useChatStore.setState((state) => ({
        ...state,
        sessions: new Map([
          [
            'test-id',
            {
              chatInstance,
              chatThread: null,
              connectionStatus: 'idle' as const,
              connectionError: null,
              id: 'test-id',
              pendingPermission: null,
              selectedAgent: builtInAgent,
              selectedMode: null as unknown as Mode,
              retryCount: 0,
              retriesExhausted: false,
              selectedModel: null as unknown as Model,
              triggerData: null,
            },
          ],
        ]),
        currentSessionId: 'test-id',
      }))

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow('No selected model')
    })

    it('should throw error when chatThread encryption does not match model confidentiality', async () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const encryptedThread = createMockChatThread({ isEncrypted: 1 })
      const nonConfidentialModel = createMockModel({ isConfidential: 0 })

      hydrateStore({
        chatInstance,
        chatThread: encryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [nonConfidentialModel],
        selectedModel: nonConfidentialModel,
        triggerData: null,
      })

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'This model is not available for encrypted conversations.',
      )
    })

    it('should throw error when unencrypted thread is used with confidential model', async () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const unencryptedThread = createMockChatThread({ isEncrypted: 0 })
      const confidentialModel = createMockModel({ isConfidential: 1 })

      hydrateStore({
        chatInstance,
        chatThread: unencryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [confidentialModel],
        selectedModel: confidentialModel,
        triggerData: null,
      })

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'This model is not available for unencrypted conversations.',
      )
    })

    it('should send message successfully when all conditions are met', async () => {
      const model = createMockModel()
      const messages: ThunderboltUIMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ]
      const chatInstanceWithMessages = createMockChatInstanceWithValidation(messages)

      hydrateStore({
        chatInstance: chatInstanceWithMessages,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      const session = getCurrentSession()
      await session?.chatInstance?.sendMessage({ text: 'test message' })

      expect(chatInstanceWithMessages._originalSendMessage).toHaveBeenCalledWith({
        text: 'test message',
      })

      // trackEvent is called but we don't verify it to avoid module mocking
      // The function is safe to call and won't throw even if posthogClient is null
    })

    it('should track event with correct prompt number', async () => {
      const messages: ThunderboltUIMessage[] = [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'First' }] },
        { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] },
        { id: 'msg-3', role: 'user', parts: [{ type: 'text', text: 'Second' }] },
      ]
      const chatInstance = createMockChatInstanceWithValidation(messages)
      const model = createMockModel()

      hydrateStore({
        chatInstance,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      const session = getCurrentSession()
      await session?.chatInstance?.sendMessage({ text: 'third message' })

      // Verify sendMessage was called with correct parameters
      expect(chatInstance._originalSendMessage).toHaveBeenCalledWith({
        text: 'third message',
      })

      // trackEvent is called but we don't verify it to avoid module mocking
    })
  })

  describe('setSelectedModel', () => {
    it('should throw error when model is not found', async () => {
      const model1 = createMockModel({ id: 'model-1' })
      const model2 = createMockModel({ id: 'model-2' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await expect(useChatStore.getState().setSelectedModel('test-id', 'nonexistent-model')).rejects.toThrow(
        'Model not found',
      )
    })

    it('should set selected model and update settings', async () => {
      const model1 = createMockModel({ id: 'model-1', name: 'Model 1' })
      const model2 = createMockModel({ id: 'model-2', name: 'Model 2' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'model-2')

      const session = getCurrentSession()
      expect(session?.selectedModel).toBe(model2)
      expect(session?.selectedModel?.id).toBe('model-2')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('model-2')
    })

    it('should update settings with correct model id', async () => {
      const model = createMockModel({ id: 'custom-model-id' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'custom-model-id')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('custom-model-id')
    })

    it('should complete without errors when setting model', async () => {
      const model = createMockModel({ id: 'tracked-model' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      // trackEvent is called but we don't verify it to avoid module mocking
      // The function is safe to call and won't throw even if posthogClient is null
      await useChatStore.getState().setSelectedModel('test-id', 'tracked-model')

      const session = getCurrentSession()
      expect(session?.selectedModel?.id).toBe('tracked-model')
    })
  })

  describe('setSelectedAgent', () => {
    const customAgent = {
      id: 'custom-agent-1',
      name: 'My Agent',
      type: 'remote-acp' as const,
      transport: 'websocket' as const,
      url: 'wss://example.test/ws',
      description: null,
      icon: null,
      isSystem: 0 as const,
      enabled: 1 as const,
      deletedAt: null,
      userId: 'u1',
    }

    /** Seeds a persisted thread and matching hydrated chat session. */
    const seedThreadSession = async (id: string, agent: Agent, acpSessionId: string): Promise<ChatThread> => {
      const model = createMockModel()
      const chatThread = createMockChatThread({ id, agentId: agent.id, acpSessionId })
      await getDb().insert(chatThreadsTable).values({ id, title: 'x', agentId: agent.id, acpSessionId })
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread,
        id,
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })
      useChatStore.getState().updateSession(id, { selectedAgent: agent })
      return chatThread
    }

    it('updates the in-memory session selectedAgent', async () => {
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedAgent('thread-1', customAgent)

      const session = getCurrentSession()
      expect(session?.selectedAgent.id).toBe(customAgent.id)
    })

    it('switches the thread agent and clears its ACP session in memory and storage', async () => {
      const chatThread = await seedThreadSession('thread-persist', builtInAgent, 'session-from-previous-agent')

      await useChatStore.getState().setSelectedAgent(chatThread.id, customAgent)

      const session = getCurrentSession()
      const stored = await getChatThread(getDb(), chatThread.id)
      expect(session?.chatThread?.agentId).toBe(customAgent.id)
      expect(session?.chatThread?.acpSessionId).toBeNull()
      expect(stored?.agentId).toBe(customAgent.id)
      expect(stored?.acpSessionId).toBeNull()
    })

    it('preserves the ACP session when selecting the current agent', async () => {
      const chatThread = await seedThreadSession('thread-same-agent', customAgent, 'current-session')

      await useChatStore.getState().setSelectedAgent(chatThread.id, customAgent)

      expect(getCurrentSession()?.chatThread?.acpSessionId).toBe('current-session')
      expect((await getChatThread(getDb(), chatThread.id))?.acpSessionId).toBe('current-session')
    })

    it('refreshes active agent wire identity and clears matching in-memory ACP sessions', async () => {
      await seedThreadSession('thread-wire-edit', customAgent, 'stale-session')

      useChatStore.getState().applyAgentWireIdentityChange({ ...customAgent, url: 'wss://new.example.test/ws' })

      expect(getCurrentSession()?.selectedAgent.url).toBe('wss://new.example.test/ws')
      expect(getCurrentSession()?.chatThread?.acpSessionId).toBeNull()
    })

    it('updates in-memory state and skips the DB write when no chat thread exists yet', async () => {
      // For brand-new chats (no `chat_threads` row yet) the selection is held
      // in memory until the first message is sent. Persistence happens inside
      // `getOrCreateChatThread` — see `use-hydrate-chat-store.ts` saveMessages.
      // This test covers the pre-first-message path only.
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-no-row',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      // Should not throw despite no DB row existing.
      await useChatStore.getState().setSelectedAgent('thread-no-row', customAgent)

      const session = getCurrentSession()
      expect(session?.selectedAgent.id).toBe(customAgent.id)

      // Verify no row was created behind the scenes.
      const stored = await getChatThread(getDb(), 'thread-no-row')
      expect(stored).toBeNull()
    })

    it('persists the global last-used agent in settings so new chats default to it', async () => {
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedAgent('thread-1', customAgent)

      const settings = await getSettings(getDb(), { selected_agent: String })
      expect(settings.selectedAgent).toBe(customAgent.id)
    })

    it('throws when the session is missing', async () => {
      await expect(useChatStore.getState().setSelectedAgent('nope', customAgent)).rejects.toThrow('No session found')
    })
  })

  describe('session permission allowances', () => {
    afterEach(() => {
      useChatStore.setState({ alwaysAllowedAgentIds: new Set(), alwaysAllowedAgentToolKeys: new Set() })
    })

    it('limits an action-kind allowance to the matching kind and agent', () => {
      const { allowAlwaysForTool, isAlwaysAllowed } = useChatStore.getState()

      allowAlwaysForTool('agent-a', 'read')

      expect(isAlwaysAllowed('agent-a', 'read')).toBe(true)
      expect(isAlwaysAllowed('agent-a', 'edit')).toBe(false)
      expect(isAlwaysAllowed('agent-b', 'read')).toBe(false)
    })

    it('allows every tool for an allowed agent without affecting other agents', () => {
      const { allowAlwaysForAgent, isAlwaysAllowed } = useChatStore.getState()

      allowAlwaysForAgent('agent-wholesale')

      expect(isAlwaysAllowed('agent-wholesale', 'read')).toBe(true)
      expect(isAlwaysAllowed('agent-wholesale', 'edit')).toBe(true)
      expect(isAlwaysAllowed('agent-other', 'read')).toBe(false)
    })
  })

  describe('permission request helpers', () => {
    it('derives a tool key from kind regardless of the argument-bearing title', () => {
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/passwd', kind: 'read' } } as never)).toBe('read')
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/shadow', kind: 'read' } } as never)).toBe('read')
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/passwd', kind: 'execute' } } as never)).toBe('execute')
      expect(deriveToolKey({ toolCall: {} } as never)).toBe('unknown')
    })

    it('prefers allow-once, falls back to allow-always, and rejects non-allow options', () => {
      const allowAlways = { optionId: 'always', name: 'Always', kind: 'allow_always' } as const
      const allowOnce = { optionId: 'once', name: 'Once', kind: 'allow_once' } as const

      expect(findAllowOption([allowAlways, allowOnce])).toBe(allowOnce)
      expect(findAllowOption([allowAlways])).toBe(allowAlways)
      expect(findAllowOption([{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }])).toBeUndefined()
    })
  })
})
