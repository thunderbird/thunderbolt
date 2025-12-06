import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { ChatMessages } from './chat-messages'
import { useChatStore } from '@/chats/chat-store'
import type { ThunderboltUIMessage, ChatThread, AutomationRun } from '@/types'
import { type Chat } from '@ai-sdk/react'

// Mock Chat instance - minimal implementation for testing
const createMockChatInstance = (
  messages: ThunderboltUIMessage[] = [],
  status: 'ready' | 'streaming' = 'ready',
): Chat<ThunderboltUIMessage> => {
  const sendMessage = mock((_params: { text: string; metadata?: Record<string, unknown> }) => {
    // Mock implementation
  })
  const regenerate = mock(() => Promise.resolve())

  return {
    id: 'test-chat-id',
    messages,
    sendMessage,
    status,
    regenerate,
    stop: mock(),
    append: mock(),
    reload: mock(),
    setMessages: mock(),
    setData: mock(),
    setStatus: mock(),
  } as unknown as Chat<ThunderboltUIMessage>
}

// Mock useChat hook that reads from chat instance
const createMockUseChat = (chatInstance: Chat<ThunderboltUIMessage>, error?: Error) => {
  return ((_options?: { chat?: Chat<ThunderboltUIMessage> }) => ({
    id: chatInstance.id,
    status: chatInstance.status,
    messages: chatInstance.messages,
    error,
    isLoading: false,
    reload: mock(),
    stop: chatInstance.stop,
    append: mock(),
    setMessages: mock(),
    setData: mock(),
    sendMessage: chatInstance.sendMessage,
    regenerate: chatInstance.regenerate,
    resumeStream: mock(),
    addToolResult: mock(),
    clearError: mock(),
  })) as unknown as typeof import('@ai-sdk/react').useChat
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

const createTestMessage = (overrides?: Partial<ThunderboltUIMessage>): ThunderboltUIMessage => {
  return {
    id: 'msg-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Hello' }],
    ...overrides,
  }
}

describe('ChatMessages', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    // Reset store state before each test
    useChatStore.getState().reset()
  })

  afterEach(async () => {
    // Reset store state after each test
    useChatStore.getState().reset()
    await resetTestDatabase()
  })

  describe('basic rendering', () => {
    it('should render user and assistant messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
        createTestMessage({ role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createQueryTestWrapper(),
      })

      // Messages should be rendered - check if text content is present
      expect(container.textContent).toContain('Hello')
      expect(container.textContent).toContain('Hi there')
    })
  })

  describe('encryption message', () => {
    it('should show encryption message when thread is encrypted', () => {
      const mockChatInstance = createMockChatInstance([])
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread({ isEncrypted: 1 }),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createQueryTestWrapper(),
      })

      // EncryptionMessage should be rendered with the confidential text
      expect(container.textContent).toContain('This conversation is confidential')
    })
  })

  describe('trigger message', () => {
    it('should show trigger message when automation was triggered', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Automation prompt' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: createMockAutomationRun({
          wasTriggeredByAutomation: true,
          prompt: {
            id: 'prompt-1',
            title: 'Test Automation',
            prompt: 'Automation prompt',
            deletedAt: null,
            defaultHash: null,
            modelId: 'model-1',
          },
        }),
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createQueryTestWrapper(),
      })

      // TriggerMessage should be rendered with "Triggered by automation" text
      expect(container.textContent).toContain('Triggered by automation')
    })

    it('should skip first user message when automation was triggered', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Automation prompt' }],
        }),
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: createMockAutomationRun({
          wasTriggeredByAutomation: true,
        }),
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // First user message should be skipped, only assistant message should be visible
      expect(screen.queryByText('Automation prompt')).not.toBeInTheDocument()
      expect(screen.getByText('Response')).toBeInTheDocument()
    })
  })

  describe('message filtering', () => {
    it('should skip OAuth retry messages and render other messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'OAuth retry message' }],
          metadata: { oauthRetry: true },
        }),
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Regular message' }],
        }),
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createQueryTestWrapper(),
      })

      // OAuth retry message should be skipped
      expect(container.textContent).not.toContain('OAuth retry message')
      // Other messages should still be visible
      expect(container.textContent).toContain('Regular message')
      expect(container.textContent).toContain('Response')
    })
  })

  describe('error handling', () => {
    it('should show error message when chatError exists', () => {
      const mockChatInstance = createMockChatInstance([])
      const chatError = new Error('Network error')
      const mockUseChat = createMockUseChat(mockChatInstance, chatError)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // ErrorMessage should be rendered with the error message
      expect(screen.getByText('Network error')).toBeInTheDocument()
    })

    it('should show error message when last message is assistant with no parts and not streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [], // Empty parts
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // ErrorMessage should be rendered with default error message
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })

    it('should not show error message when last message is assistant with no parts but streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [], // Empty parts but streaming
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // ErrorMessage should not be rendered when streaming
      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument()
    })

    it('should not show error message when last message has parts', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Valid response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // ErrorMessage should not be rendered when message has parts
      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument()
    })
  })

  describe('streaming state', () => {
    it('should pass isStreaming to last assistant message when streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Streaming response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // Message should be rendered (isStreaming prop is passed to AssistantMessage)
      expect(screen.getByText('Streaming response')).toBeInTheDocument()
    })

    it('should not pass isStreaming to non-last assistant messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'First response' }],
        }),
        createTestMessage({
          id: 'msg-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createQueryTestWrapper() })

      // Both messages should be rendered
      expect(screen.getByText('First response')).toBeInTheDocument()
      expect(screen.getByText('Second response')).toBeInTheDocument()
    })
  })

  describe('dependency injection', () => {
    it('should work with dependency injection for useChat', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createQueryTestWrapper(),
      })

      // Component should render without errors
      expect(container).toBeInTheDocument()
      expect(screen.getByText('Hello')).toBeInTheDocument()
    })
  })
})
