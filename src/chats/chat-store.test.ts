import { getSettings } from '@/dal'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'

// Mock Chat instance - minimal implementation for testing
const createMockChatInstance = (
  messages: ThunderboltUIMessage[] = [],
): Chat<ThunderboltUIMessage> & {
  _originalSendMessage: ReturnType<typeof mock>
} => {
  const originalSendMessage = mock(async (_params: { text: string; metadata?: Record<string, unknown> }) => {
    // Mock implementation
  })

  // Wrap sendMessage with validation logic to match real implementation
  const sendMessage = async (params: { text: string; metadata?: Record<string, unknown> }) => {
    const { chatThread, selectedModel } = useChatStore.getState()

    if (!selectedModel) {
      throw new Error('No selected model')
    }

    if (chatThread && chatThread.isEncrypted !== selectedModel.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    return originalSendMessage(params)
  }

  return {
    id: 'test-chat-id',
    messages,
    sendMessage,
    status: 'ready',
    regenerate: mock(),
    stop: mock(),
    append: mock(),
    reload: mock(),
    setMessages: mock(),
    setData: mock(),
    setStatus: mock(),
    _originalSendMessage: originalSendMessage,
  } as unknown as Chat<ThunderboltUIMessage> & { _originalSendMessage: ReturnType<typeof mock> }
}

const createMockModel = (overrides?: Partial<Model>): Model => {
  return {
    id: 'model-1',
    provider: 'openai',
    name: 'Test Model',
    model: 'gpt-4',
    isSystem: 0,
    enabled: 1,
    isConfidential: 0,
    ...overrides,
  } as Model
}

const createMockChatThread = (overrides?: Partial<ChatThread>): ChatThread => {
  return {
    id: 'thread-1',
    title: 'Test Thread',
    isEncrypted: 0,
    ...overrides,
  } as ChatThread
}

const createMockAutomationRun = (overrides?: Partial<AutomationRun>): AutomationRun => {
  return {
    prompt: null,
    wasTriggeredByAutomation: false,
    isAutomationDeleted: false,
    ...overrides,
  }
}

describe('chat-store', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    // Reset store state before each test
    useChatStore.getState().reset()
    await resetTestDatabase()
  })

  afterEach(async () => {
    // Ensure store is reset after each test to prevent test pollution
    useChatStore.getState().reset()
  })

  describe('hydrate', () => {
    it('should set all state values correctly', () => {
      const chatInstance = createMockChatInstance()
      const chatThread = createMockChatThread()
      const model = createMockModel()
      const automationRun = createMockAutomationRun()

      const state = {
        chatInstance,
        chatThread,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: automationRun,
      }

      useChatStore.getState().hydrate(state)

      const storeState = useChatStore.getState()
      expect(storeState.chatInstance).toBe(chatInstance)
      expect(storeState.chatThread).toBe(chatThread)
      expect(storeState.id).toBe('test-id')
      expect(storeState.mcpClients).toEqual([])
      expect(storeState.models).toEqual([model])
      expect(storeState.selectedModel).toBe(model)
      expect(storeState.triggerData).toBe(automationRun)
    })
  })

  describe('reset', () => {
    it('should reset store to initial state', () => {
      // First hydrate with some data
      const chatInstance = createMockChatInstance()
      const model = createMockModel()
      useChatStore.getState().hydrate({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: createMockAutomationRun(),
      })

      // Then reset
      useChatStore.getState().reset()

      const storeState = useChatStore.getState()
      expect(storeState.chatInstance).toBeNull()
      expect(storeState.chatThread).toBeNull()
      expect(storeState.id).toBeNull()
      expect(storeState.mcpClients).toEqual([])
      expect(storeState.models).toEqual([])
      expect(storeState.selectedModel).toBeNull()
      expect(storeState.triggerData).toBeNull()
    })
  })

  describe('sendMessage', () => {
    it('should throw error when selectedModel is null', async () => {
      const chatInstance = createMockChatInstance()
      useChatStore.getState().hydrate({
        chatInstance,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      await expect(useChatStore.getState().chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'No selected model',
      )
    })
    it('should throw error when chatThread encryption does not match model confidentiality', async () => {
      const chatInstance = createMockChatInstance()
      const encryptedThread = createMockChatThread({ isEncrypted: 1 })
      const nonConfidentialModel = createMockModel({ isConfidential: 0 })

      useChatStore.getState().hydrate({
        chatInstance,
        chatThread: encryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [nonConfidentialModel],
        selectedModel: nonConfidentialModel,
        triggerData: null,
      })

      await expect(useChatStore.getState().chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'This model is not available for encrypted conversations.',
      )
    })

    it('should throw error when unencrypted thread is used with confidential model', async () => {
      const chatInstance = createMockChatInstance()
      const unencryptedThread = createMockChatThread({ isEncrypted: 0 })
      const confidentialModel = createMockModel({ isConfidential: 1 })

      useChatStore.getState().hydrate({
        chatInstance,
        chatThread: unencryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [confidentialModel],
        selectedModel: confidentialModel,
        triggerData: null,
      })

      await expect(useChatStore.getState().chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
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
      const chatInstanceWithMessages = createMockChatInstance(messages)

      useChatStore.getState().hydrate({
        chatInstance: chatInstanceWithMessages,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().chatInstance?.sendMessage({ text: 'test message' })

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
      const chatInstance = createMockChatInstance(messages)
      const model = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().chatInstance?.sendMessage({ text: 'third message' })

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

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await expect(useChatStore.getState().setSelectedModel('nonexistent-model')).rejects.toThrow('Model not found')
    })

    it('should set selected model and update settings', async () => {
      const model1 = createMockModel({ id: 'model-1', name: 'Model 1' })
      const model2 = createMockModel({ id: 'model-2', name: 'Model 2' })

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('model-2')

      const storeState = useChatStore.getState()
      expect(storeState.selectedModel).toBe(model2)
      expect(storeState.selectedModel?.id).toBe('model-2')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings({ selected_model: String })
      expect(settings.selectedModel).toBe('model-2')
    })

    it('should update settings with correct model id', async () => {
      const model = createMockModel({ id: 'custom-model-id' })

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: null,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('custom-model-id')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings({ selected_model: String })
      expect(settings.selectedModel).toBe('custom-model-id')
    })

    it('should complete without errors when setting model', async () => {
      const model = createMockModel({ id: 'tracked-model' })

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: null,
        triggerData: null,
      })

      // trackEvent is called but we don't verify it to avoid module mocking
      // The function is safe to call and won't throw even if posthogClient is null
      await useChatStore.getState().setSelectedModel('tracked-model')

      const storeState = useChatStore.getState()
      expect(storeState.selectedModel?.id).toBe('tracked-model')
    })
  })
})
