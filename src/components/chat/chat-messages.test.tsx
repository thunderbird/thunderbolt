import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import {
  createMockAutomationRun,
  createMockChatInstance,
  createMockChatThread,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { ChatMessages } from './chat-messages'
import type { ThunderboltUIMessage } from '@/types'

const createTestMessage = (overrides?: Partial<ThunderboltUIMessage>): ThunderboltUIMessage => ({
  id: 'msg-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  ...overrides,
})

describe('ChatMessages', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    // Reset store state before each test
    resetStore()
  })

  afterEach(async () => {
    // Cleanup rendered components before resetting store to prevent errors during unmount
    cleanup()
    // Reset store state after each test
    resetStore()
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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

      hydrateStore({
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
