import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useChatAutomation } from './use-chat-automation'
import { useChatStore } from './chat-store'
import type { Chat } from '@ai-sdk/react'
import type { ThunderboltUIMessage } from '@/types'

// Mock dependencies
const mockUseChat = mock()
const mockRegenerate = mock()

// Mock modules
mock.module('@ai-sdk/react', () => ({
  useChat: mockUseChat,
}))

describe('useChatAutomation', () => {
  const createMockMessage = (role: 'user' | 'assistant', content: string): ThunderboltUIMessage => {
    return {
      id: `msg-${Date.now()}-${Math.random()}`,
      role,
      parts: [{ type: 'text', text: content }],
    } as ThunderboltUIMessage
  }

  const createMockChatInstance = (
    messages: ThunderboltUIMessage[],
    status: 'ready' | 'streaming' | 'idle' = 'ready',
    regenerateMock = mockRegenerate,
  ): Chat<ThunderboltUIMessage> => {
    return {
      messages,
      status,
      regenerate: regenerateMock,
      sendMessage: mock(),
    } as unknown as Chat<ThunderboltUIMessage>
  }

  beforeEach(() => {
    useChatStore.getState().reset()
    mockUseChat.mockReset()
    mockRegenerate.mockReset()

    // Setup default store state
    const mockChatInstance = createMockChatInstance([])
    useChatStore.getState().hydrate({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // Default useChat mock - empty messages
    mockUseChat.mockReturnValue({
      messages: [],
    })
  })

  afterEach(() => {
    mockUseChat.mockReset()
    mockRegenerate.mockReset()
  })

  describe('Auto-regenerate behavior', () => {
    it('should trigger regenerate when conditions are met', async () => {
      const userMessage = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([userMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      mockRegenerate.mockResolvedValue(undefined)

      renderHook(() => useChatAutomation())

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })
    })

    it('should not trigger if chat instance status is not ready', () => {
      const userMessage = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([userMessage], 'streaming')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('should not trigger if there are no messages', () => {
      const mockChatInstance = createMockChatInstance([], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('should not trigger if last message is not from user', () => {
      const assistantMessage = createMockMessage('assistant', 'Hello, how can I help?')
      const mockChatInstance = createMockChatInstance([assistantMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [assistantMessage],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('should not trigger if already triggered once', async () => {
      const userMessage = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([userMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      mockRegenerate.mockResolvedValue(undefined)

      const { rerender } = renderHook(() => useChatAutomation())

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })

      // Rerender should not trigger again
      mockRegenerate.mockReset()
      rerender()

      // Wait a bit to ensure no new calls
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('should handle regenerate errors gracefully', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {})
      const userMessage = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([userMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      const error = new Error('Regenerate failed')
      mockRegenerate.mockRejectedValue(error)

      renderHook(() => useChatAutomation())

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Auto regenerate error', error)
      })

      consoleErrorSpy.mockRestore()
    })
  })

  describe('Message sequence scenarios', () => {
    it('should trigger when user message is added after assistant message', async () => {
      const assistantMessage = createMockMessage('assistant', 'Hello')
      const userMessage = createMockMessage('user', 'How are you?')
      const mockChatInstance = createMockChatInstance([assistantMessage, userMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [assistantMessage, userMessage],
      })

      mockRegenerate.mockResolvedValue(undefined)

      renderHook(() => useChatAutomation())

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })
    })

    it('should not trigger when assistant message is added after user message', () => {
      const userMessage = createMockMessage('user', 'Hello')
      const assistantMessage = createMockMessage('assistant', 'Hi there!')
      const mockChatInstance = createMockChatInstance([userMessage, assistantMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage, assistantMessage],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })
  })

  describe('Status transitions', () => {
    it('should trigger when status changes from streaming to ready with user message', async () => {
      const userMessage = createMockMessage('user', 'Hello')
      mockRegenerate.mockResolvedValue(undefined)

      const mockChatInstance = createMockChatInstance([userMessage], 'streaming')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      const { rerender } = renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()

      // Change status to ready - create new instance with same regenerate mock
      const readyChatInstance = {
        ...mockChatInstance,
        status: 'ready' as const,
      } as unknown as Chat<ThunderboltUIMessage>

      act(() => {
        useChatStore.getState().hydrate({
          chatInstance: readyChatInstance,
          chatThread: null,
          id: 'thread-1',
          mcpClients: [],
          models: [],
          selectedModel: null,
          triggerData: null,
        })
      })

      act(() => {
        rerender()
      })

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })
    })

    it('should not trigger when status changes from ready to streaming', async () => {
      const userMessage = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([userMessage], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [userMessage],
      })

      mockRegenerate.mockResolvedValue(undefined)

      const { rerender } = renderHook(() => useChatAutomation())

      // Wait for initial trigger
      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })

      // Change status to streaming
      const streamingChatInstance = createMockChatInstance([userMessage], 'streaming')
      act(() => {
        useChatStore.getState().hydrate({
          chatInstance: streamingChatInstance,
          chatThread: null,
          id: 'thread-1',
          mcpClients: [],
          models: [],
          selectedModel: null,
          triggerData: null,
        })
      })

      mockRegenerate.mockReset()
      act(() => {
        rerender()
      })

      // Wait a bit to ensure no new calls
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockRegenerate).not.toHaveBeenCalled()
    })
  })

  describe('Edge cases', () => {
    it('should handle null chat instance gracefully', () => {
      useChatStore.getState().hydrate({
        chatInstance: null,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })

    it('should check chatInstance.messages, not useChat messages, for last message role', async () => {
      const userMessage1 = createMockMessage('user', 'First message')
      const assistantMessage = createMockMessage('assistant', 'Response')
      const userMessage2 = createMockMessage('user', 'Second message')

      // chatInstance has all messages
      const mockChatInstance = createMockChatInstance([userMessage1, assistantMessage, userMessage2], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // useChat returns different messages (e.g., only user messages)
      mockUseChat.mockReturnValue({
        messages: [userMessage1, userMessage2],
      })

      mockRegenerate.mockResolvedValue(undefined)

      renderHook(() => useChatAutomation())

      await waitFor(() => {
        expect(mockRegenerate).toHaveBeenCalledTimes(1)
      })
    })

    it('should handle empty messages array in chatInstance', () => {
      const mockChatInstance = createMockChatInstance([], 'ready')

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        messages: [],
      })

      renderHook(() => useChatAutomation())

      expect(mockRegenerate).not.toHaveBeenCalled()
    })
  })
})
