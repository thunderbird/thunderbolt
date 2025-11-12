import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import type { Chat } from '@ai-sdk/react'
import type { ChatThread, Model, ThunderboltUIMessage, AutomationRun } from '@/types'
import { MCPClient } from '@/lib/mcp-provider'

const mockUpdateSetting = mock()
const mockTrackEvent = mock()

mock.module('@/dal', () => ({
  updateSetting: mockUpdateSetting,
}))

mock.module('@/lib/posthog', () => ({
  trackEvent: mockTrackEvent,
}))

describe('chat-store', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    mockUpdateSetting.mockReset()
    mockTrackEvent.mockReset()
  })

  describe('Initial state', () => {
    it('should initialize with correct default state', () => {
      const state = useChatStore.getState()

      expect(state.chatInstance).toBeNull()
      expect(state.chatThread).toBeNull()
      expect(state.id).toBeNull()
      expect(state.mcpClients).toEqual([])
      expect(state.models).toEqual([])
      expect(state.selectedModel).toBeNull()
      expect(state.triggerData).toBeNull()
    })
  })

  describe('hydrate', () => {
    it('should hydrate store with provided data', () => {
      const mockChatInstance = {
        messages: [],
        sendMessage: mock(),
      } as unknown as Chat<ThunderboltUIMessage>

      const mockChatThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'New Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      const mockModel: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      const mockMCPClient = {} as MCPClient

      const hydrateData = {
        chatInstance: mockChatInstance,
        chatThread: mockChatThread,
        id: 'thread-1',
        mcpClients: [mockMCPClient],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      }

      useChatStore.getState().hydrate(hydrateData)

      const state = useChatStore.getState()
      expect(state.chatInstance).toBe(mockChatInstance)
      expect(state.chatThread).toBe(mockChatThread)
      expect(state.id).toBe('thread-1')
      expect(state.mcpClients).toEqual([mockMCPClient])
      expect(state.models).toEqual([mockModel])
      expect(state.selectedModel).toBe(mockModel)
      expect(state.triggerData).toBeNull()
    })

    it('should replace all existing state', () => {
      const initialModel: Model = {
        id: 'model-1',
        name: 'Initial Model',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'initial-id',
        mcpClients: [],
        models: [initialModel],
        selectedModel: initialModel,
        triggerData: null,
      })

      const newModel: Model = {
        id: 'model-2',
        name: 'New Model',
        isConfidential: 1,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'new-id',
        mcpClients: [],
        models: [newModel],
        selectedModel: newModel,
        triggerData: null,
      })

      const state = useChatStore.getState()
      expect(state.id).toBe('new-id')
      expect(state.models).toEqual([newModel])
      expect(state.selectedModel).toBe(newModel)
    })
  })

  describe('reset', () => {
    it('should reset store to initial state', () => {
      const mockChatInstance = {
        messages: [],
        sendMessage: mock(),
      } as unknown as Chat<ThunderboltUIMessage>

      const mockModel: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      useChatStore.getState().reset()

      const state = useChatStore.getState()
      expect(state.chatInstance).toBeNull()
      expect(state.chatThread).toBeNull()
      expect(state.id).toBeNull()
      expect(state.mcpClients).toEqual([])
      expect(state.models).toEqual([])
      expect(state.selectedModel).toBeNull()
      expect(state.triggerData).toBeNull()
    })
  })

  describe('sendMessage', () => {
    it('should throw error when chat instance is null', async () => {
      const mockModel: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      await expect(useChatStore.getState().sendMessage('Hello')).rejects.toThrow('No chat instance')
    })

    it('should throw error when selected model is null', async () => {
      const mockChatInstance = {
        messages: [],
        sendMessage: mock(),
      } as unknown as Chat<ThunderboltUIMessage>

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      await expect(useChatStore.getState().sendMessage('Hello')).rejects.toThrow('No selected model')
    })

    it('should throw error when encryption status does not match', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const encryptedModel: Model = {
        id: 'model-1',
        name: 'Encrypted Model',
        isConfidential: 1,
      } as Model

      const unencryptedThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'New Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: unencryptedThread,
        id: 'thread-1',
        mcpClients: [],
        models: [encryptedModel],
        selectedModel: encryptedModel,
        triggerData: null,
      })

      await expect(useChatStore.getState().sendMessage('Hello')).rejects.toThrow(
        'This model is not available for unencrypted conversations.',
      )
    })

    it('should throw error when unencrypted model is used with encrypted thread', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const unencryptedModel: Model = {
        id: 'model-1',
        name: 'Unencrypted Model',
        isConfidential: 0,
      } as Model

      const encryptedThread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'New Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: encryptedThread,
        id: 'thread-1',
        mcpClients: [],
        models: [unencryptedModel],
        selectedModel: unencryptedModel,
        triggerData: null,
      })

      await expect(useChatStore.getState().sendMessage('Hello')).rejects.toThrow(
        'This model is not available for encrypted conversations.',
      )
    })

    it('should send message successfully when all conditions are met', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Previous message' }] }],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const model: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      const thread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'New Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: thread,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().sendMessage('Hello, world!')

      expect(mockSendMessage).toHaveBeenCalledWith({
        text: 'Hello, world!',
        metadata: {
          modelId: 'model-1',
        },
      })

      expect(mockTrackEvent).toHaveBeenCalledWith('chat_send_prompt', {
        model,
        length: 13,
        prompt_number: 2,
      })
    })

    it('should send message successfully when thread is null (new chat)', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const model: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().sendMessage('First message')

      expect(mockSendMessage).toHaveBeenCalledWith({
        text: 'First message',
        metadata: {
          modelId: 'model-1',
        },
      })

      expect(mockTrackEvent).toHaveBeenCalledWith('chat_send_prompt', {
        model,
        length: 13,
        prompt_number: 1,
      })
    })

    it('should track correct prompt number based on existing messages', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Message 1' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'Response 1' }] },
          { role: 'user', parts: [{ type: 'text', text: 'Message 2' }] },
        ],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const model: Model = {
        id: 'model-1',
        name: 'Test Model',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().sendMessage('Message 3')

      expect(mockTrackEvent).toHaveBeenCalledWith('chat_send_prompt', {
        model,
        length: 9,
        prompt_number: 4,
      })
    })
  })

  describe('setSelectedModel', () => {
    it('should throw error when model is not found', async () => {
      const model1: Model = {
        id: 'model-1',
        name: 'Model 1',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: null,
        mcpClients: [],
        models: [model1],
        selectedModel: model1,
        triggerData: null,
      })

      await expect(useChatStore.getState().setSelectedModel('nonexistent-model')).rejects.toThrow('Model not found')
    })

    it('should set selected model and update setting', async () => {
      const model1: Model = {
        id: 'model-1',
        name: 'Model 1',
        isConfidential: 0,
      } as Model

      const model2: Model = {
        id: 'model-2',
        name: 'Model 2',
        isConfidential: 1,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: null,
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('model-2')

      const state = useChatStore.getState()
      expect(state.selectedModel).toBe(model2)
      expect(mockUpdateSetting).toHaveBeenCalledWith('selected_model', 'model-2')
      expect(mockTrackEvent).toHaveBeenCalledWith('model_select', { model: 'model-2' })
    })

    it('should update selected model when switching between models', async () => {
      const model1: Model = {
        id: 'model-1',
        name: 'Model 1',
        isConfidential: 0,
      } as Model

      const model2: Model = {
        id: 'model-2',
        name: 'Model 2',
        isConfidential: 0,
      } as Model

      const model3: Model = {
        id: 'model-3',
        name: 'Model 3',
        isConfidential: 1,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: null,
        mcpClients: [],
        models: [model1, model2, model3],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('model-2')
      expect(useChatStore.getState().selectedModel).toBe(model2)
      expect(mockUpdateSetting).toHaveBeenCalledWith('selected_model', 'model-2')

      mockUpdateSetting.mockReset()
      mockTrackEvent.mockReset()

      await useChatStore.getState().setSelectedModel('model-3')
      expect(useChatStore.getState().selectedModel).toBe(model3)
      expect(mockUpdateSetting).toHaveBeenCalledWith('selected_model', 'model-3')
      expect(mockTrackEvent).toHaveBeenCalledWith('model_select', { model: 'model-3' })
    })

    it('should handle null modelId', async () => {
      const model1: Model = {
        id: 'model-1',
        name: 'Model 1',
        isConfidential: 0,
      } as Model

      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: null,
        mcpClients: [],
        models: [model1],
        selectedModel: model1,
        triggerData: null,
      })

      await expect(useChatStore.getState().setSelectedModel(null)).rejects.toThrow('Model not found')
    })
  })

  describe('Integration scenarios', () => {
    it('should handle complete workflow: hydrate -> sendMessage -> setSelectedModel', async () => {
      const mockSendMessage = mock()
      const mockChatInstance = {
        messages: [],
        sendMessage: mockSendMessage,
      } as unknown as Chat<ThunderboltUIMessage>

      const model1: Model = {
        id: 'model-1',
        name: 'Model 1',
        isConfidential: 0,
      } as Model

      const model2: Model = {
        id: 'model-2',
        name: 'Model 2',
        isConfidential: 0,
      } as Model

      const thread: ChatThread = {
        id: 'thread-1',
        isEncrypted: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        contextSize: null,
        title: 'New Chat',
        triggeredBy: null,
        wasTriggeredByAutomation: 0,
      } as ChatThread

      // Hydrate store
      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: thread,
        id: 'thread-1',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      // Send message with initial model
      await useChatStore.getState().sendMessage('First message')
      expect(mockSendMessage).toHaveBeenCalledWith({
        text: 'First message',
        metadata: { modelId: 'model-1' },
      })

      // Switch model
      await useChatStore.getState().setSelectedModel('model-2')
      expect(useChatStore.getState().selectedModel).toBe(model2)

      // Send message with new model
      mockSendMessage.mockReset()
      await useChatStore.getState().sendMessage('Second message')
      expect(mockSendMessage).toHaveBeenCalledWith({
        text: 'Second message',
        metadata: { modelId: 'model-2' },
      })
    })

    it('should handle triggerData in workflow', () => {
      const mockChatInstance = {
        messages: [],
        sendMessage: mock(),
      } as unknown as Chat<ThunderboltUIMessage>

      const triggerData: AutomationRun = {
        prompt: null,
        wasTriggeredByAutomation: true,
        isAutomationDeleted: false,
      }

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData,
      })

      const state = useChatStore.getState()
      expect(state.triggerData).toBe(triggerData)
      expect(state.triggerData?.wasTriggeredByAutomation).toBe(true)
    })
  })
})
