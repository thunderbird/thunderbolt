import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test'
import { render, waitFor } from '@testing-library/react'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import type { ThunderboltUIMessage, SaveMessagesFunction } from '@/types'
import type { Chat } from '@ai-sdk/react'
import { useChatStore } from './chat-store'

// Mock dependencies
const mockSaveMessages = mock<SaveMessagesFunction>()
const mockUseChat = mock()
const mockUseThrottledCallback = mock()

// Mock modules
mock.module('@ai-sdk/react', () => ({
  useChat: mockUseChat,
}))

mock.module('@/hooks/use-throttle', () => ({
  useThrottledCallback: mockUseThrottledCallback,
}))

describe('SavePartialAssistantMessagesHandler', () => {
  const mockChatInstance = {
    messages: [],
    sendMessage: mock(),
  } as unknown as Chat<ThunderboltUIMessage>

  const createMockMessage = (role: 'user' | 'assistant', content: string): ThunderboltUIMessage => {
    return {
      id: `msg-${Date.now()}-${Math.random()}`,
      role,
      parts: [{ type: 'text', text: content }],
    } as ThunderboltUIMessage
  }

  beforeEach(() => {
    useChatStore.getState().reset()
    mockSaveMessages.mockReset()
    mockUseChat.mockReset()
    mockUseThrottledCallback.mockReset()

    // Setup default store state
    useChatStore.getState().hydrate({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // Default useChat mock - not streaming, empty messages
    mockUseChat.mockReturnValue({
      status: 'idle',
      messages: [],
    })

    // Default useThrottledCallback mock - just call the callback immediately
    mockUseThrottledCallback.mockImplementation((callback) => callback)
  })

  afterEach(() => {
    mockSaveMessages.mockReset()
    mockUseChat.mockReset()
    mockUseThrottledCallback.mockReset()
  })

  describe('Component rendering', () => {
    it('should render children', () => {
      const { getByText } = render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Test Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      expect(getByText('Test Child')).toBeDefined()
    })
  })

  describe('Message saving behavior', () => {
    it('should save message when streaming and latest message is assistant', async () => {
      const assistantMessage = createMockMessage('assistant', 'Hello, how can I help?')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-1',
          messages: [assistantMessage],
        })
      })
    })

    it('should not save message when not streaming', () => {
      const assistantMessage = createMockMessage('assistant', 'Hello, how can I help?')

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [assistantMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      // Wait a bit to ensure no save happens
      expect(mockSaveMessages).not.toHaveBeenCalled()
    })

    it('should not save message when latest message is user', () => {
      const userMessage = createMockMessage('user', 'Hello')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [userMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      expect(mockSaveMessages).not.toHaveBeenCalled()
    })

    it('should not save when messages array is empty', () => {
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      expect(mockSaveMessages).not.toHaveBeenCalled()
    })

    it('should save only the latest message when multiple messages exist', async () => {
      const userMessage = createMockMessage('user', 'Hello')
      const assistantMessage1 = createMockMessage('assistant', 'Hi there!')
      const assistantMessage2 = createMockMessage('assistant', 'How can I help you?')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [userMessage, assistantMessage1, assistantMessage2],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-1',
          messages: [assistantMessage2],
        })
      })

      // Should not have saved assistantMessage1
      expect(mockSaveMessages).toHaveBeenCalledTimes(1)
    })

    it('should use throttled callback for saving', async () => {
      const throttledCallback = mock((message: ThunderboltUIMessage) => {
        mockSaveMessages({
          id: 'thread-1',
          messages: [message],
        })
      })
      mockUseThrottledCallback.mockReturnValue(throttledCallback)

      const assistantMessage = createMockMessage('assistant', 'Hello')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockUseThrottledCallback).toHaveBeenCalled()
        expect(throttledCallback).toHaveBeenCalledWith(assistantMessage)
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-1',
          messages: [assistantMessage],
        })
      })
    })

    it('should pass correct throttle interval (200ms)', async () => {
      const assistantMessage = createMockMessage('assistant', 'Hello')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockUseThrottledCallback).toHaveBeenCalled()
        const throttleInterval = mockUseThrottledCallback.mock.calls[0]?.[1]
        expect(throttleInterval).toBe(200)
      })
    })
  })

  describe('Status transitions', () => {
    it('should save when status changes from idle to streaming', async () => {
      const assistantMessage = createMockMessage('assistant', 'Hello')

      // Start with idle
      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [assistantMessage],
      })

      const { rerender } = render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      expect(mockSaveMessages).not.toHaveBeenCalled()

      // Change to streaming
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      rerender(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalled()
      })
    })

    it('should stop saving when status changes from streaming to idle', async () => {
      const assistantMessage = createMockMessage('assistant', 'Hello')

      // Start with streaming
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      const { rerender } = render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalled()
      })

      const callCountBefore = mockSaveMessages.mock.calls.length

      // Change to idle
      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [assistantMessage],
      })

      rerender(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      // Wait a bit to ensure no new saves
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(mockSaveMessages.mock.calls.length).toBe(callCountBefore)
    })
  })

  describe('Message updates during streaming', () => {
    it('should save updated message when assistant message changes during streaming', async () => {
      const assistantMessage1 = createMockMessage('assistant', 'Hello')
      const assistantMessage2 = createMockMessage('assistant', 'Hello, how can I help you?')

      // Start with first message
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage1],
      })

      const { rerender } = render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-1',
          messages: [assistantMessage1],
        })
      })

      // Update message
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage2],
      })

      rerender(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-1',
          messages: [assistantMessage2],
        })
      })
    })
  })

  describe('Edge cases', () => {
    it('should handle undefined latest message gracefully', () => {
      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      expect(mockSaveMessages).not.toHaveBeenCalled()
    })

    it('should use correct chat thread ID from store', async () => {
      // Change thread ID in store
      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-2',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const assistantMessage = createMockMessage('assistant', 'Hello')

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [assistantMessage],
      })

      render(
        <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
          <div>Child</div>
        </SavePartialAssistantMessagesHandler>,
      )

      await waitFor(() => {
        expect(mockSaveMessages).toHaveBeenCalledWith({
          id: 'thread-2',
          messages: [assistantMessage],
        })
      })
    })
  })
})
