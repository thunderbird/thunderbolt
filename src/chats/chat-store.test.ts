import { getSettings } from '@/dal'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  createMockAutomationRun,
  createMockChatThread,
  createMockModel,
  getCurrentSession,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from './chat-store'

const agentNullDefaults = {
  deletedAt: null,
  defaultHash: null,
  userId: null,
  description: null,
  registryId: null,
  installedVersion: null,
  registryVersion: null,
  distributionType: null,
  installPath: null,
  packageName: null,
} as const

describe('chat-store', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    resetStore()
    await resetTestDatabase()
  })

  afterEach(async () => {
    resetStore()
  })

  describe('createSession', () => {
    it('should set all state values correctly', () => {
      const chatThread = createMockChatThread()
      const model = createMockModel()
      const automationRun = createMockAutomationRun()

      hydrateStore({
        chatThread,
        id: 'test-id',
        mcpClients: [],
        selectedModel: model,
        triggerData: automationRun,
      })

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session?.acpClient).toBeDefined()
      expect(session?.chatThread).toBe(chatThread)
      expect(session?.id).toBe('test-id')
      expect(storeState.mcpClients).toEqual([])
      expect(session?.selectedModel).toBe(model)
      expect(session?.triggerData).toBe(automationRun)
    })
  })

  describe('reset', () => {
    it('should reset store to initial state', () => {
      const model = createMockModel()

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'test-id',
        mcpClients: [],
        selectedModel: model,
        triggerData: createMockAutomationRun(),
      })

      resetStore()

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session).toBeNull()
      expect(storeState.currentSessionId).toBeNull()
      expect(storeState.mcpClients).toEqual([])
      expect(storeState.sessions.size).toBe(0)
    })
  })

  describe('message management', () => {
    it('should append messages to session', () => {
      const model = createMockModel()
      hydrateStore({
        chatThread: null,
        id: 'test-id',
        selectedModel: model,
        triggerData: null,
      })

      const message: ThunderboltUIMessage = {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      }

      useChatStore.getState().appendMessage('test-id', message)

      const session = getCurrentSession()
      expect(session?.messages).toHaveLength(1)
      expect(session?.messages[0].id).toBe('msg-1')
    })

    it('should update last message', () => {
      const model = createMockModel()
      const messages: ThunderboltUIMessage[] = [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
      ]

      hydrateStore({
        chatThread: null,
        id: 'test-id',
        messages,
        selectedModel: model,
        triggerData: null,
      })

      const updatedMessage: ThunderboltUIMessage = {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi there! How can I help?' }],
      }

      useChatStore.getState().updateLastMessage('test-id', updatedMessage)

      const session = getCurrentSession()
      expect(session?.messages).toHaveLength(2)
      expect(session?.messages[1].parts[0]).toEqual({ type: 'text', text: 'Hi there! How can I help?' })
    })

    it('should set session status', () => {
      const model = createMockModel()
      hydrateStore({
        chatThread: null,
        id: 'test-id',
        selectedModel: model,
        triggerData: null,
      })

      useChatStore.getState().setSessionStatus('test-id', 'streaming')
      expect(getCurrentSession()?.status).toBe('streaming')

      useChatStore.getState().setSessionStatus('test-id', 'error', new Error('Test error'))
      expect(getCurrentSession()?.status).toBe('error')
      expect(getCurrentSession()?.error?.message).toBe('Test error')

      useChatStore.getState().setSessionStatus('test-id', 'ready')
      expect(getCurrentSession()?.status).toBe('ready')
      expect(getCurrentSession()?.error).toBeNull()
    })
  })

  describe('setSelectedModel', () => {
    it('should set selected model and update settings', async () => {
      const model1 = createMockModel({ id: 'model-1', name: 'Model 1' })

      hydrateStore({
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'model-1')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('model-1')
    })

    it('should update settings with correct model id', async () => {
      const model = createMockModel({ id: 'custom-model-id' })

      hydrateStore({
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'custom-model-id')

      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('custom-model-id')
    })
  })

  describe('setSelectedAgent', () => {
    it('should throw error when agent is not found', async () => {
      const model = createMockModel()
      hydrateStore({
        chatThread: null,
        id: 'test-id',
        selectedModel: model,
        triggerData: null,
      })

      useChatStore.getState().setAgents([])

      await expect(useChatStore.getState().setSelectedAgent('test-id', 'nonexistent')).rejects.toThrow(
        'Agent not found',
      )
    })
  })

  describe('unavailableAgentIds', () => {
    it('should initialize with empty unavailableAgentIds', () => {
      const state = useChatStore.getState()
      expect(state.unavailableAgentIds).toBeInstanceOf(Set)
      expect(state.unavailableAgentIds.size).toBe(0)
    })

    it('should store unavailableAgentIds when setAgents is called with them', () => {
      const agents = [
        {
          id: 'agent-1',
          name: 'Agent 1',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          command: null,
          args: null,
          url: null,
          authMethod: null,
          icon: 'zap',
          isSystem: 1,
          ...agentNullDefaults,
        },
        {
          id: 'agent-2',
          name: 'Agent 2',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          command: 'test',
          args: null,
          url: null,
          authMethod: null,
          icon: 'terminal',
          isSystem: 1,
          ...agentNullDefaults,
        },
      ]
      const unavailableIds = new Set(['agent-2'])

      useChatStore.getState().setAgents(agents, unavailableIds)

      const state = useChatStore.getState()
      expect(state.agents).toEqual(agents)
      expect(state.unavailableAgentIds).toBe(unavailableIds)
      expect(state.unavailableAgentIds.has('agent-2')).toBe(true)
      expect(state.unavailableAgentIds.has('agent-1')).toBe(false)
    })

    it('should default to empty set when setAgents is called without unavailableAgentIds', () => {
      const agents = [
        {
          id: 'agent-1',
          name: 'Agent 1',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          command: null,
          args: null,
          url: null,
          authMethod: null,
          icon: 'zap',
          isSystem: 1,
          ...agentNullDefaults,
        },
      ]

      useChatStore.getState().setAgents(agents)

      const state = useChatStore.getState()
      expect(state.unavailableAgentIds).toBeInstanceOf(Set)
      expect(state.unavailableAgentIds.size).toBe(0)
    })

    it('should reset unavailableAgentIds when store is reset', () => {
      const agents = [
        {
          id: 'agent-1',
          name: 'Agent 1',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          command: null,
          args: null,
          url: null,
          authMethod: null,
          icon: 'zap',
          isSystem: 1,
          ...agentNullDefaults,
        },
      ]
      useChatStore.getState().setAgents(agents, new Set(['agent-1']))

      resetStore()

      const state = useChatStore.getState()
      expect(state.unavailableAgentIds.size).toBe(0)
    })
  })
})
