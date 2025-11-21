import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { act, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'

// Mock Chat instance - minimal implementation for testing
const createMockChatInstance = (
  messages: ThunderboltUIMessage[] = [],
  status: 'ready' | 'streaming' = 'ready',
): Chat<ThunderboltUIMessage> => {
  const sendMessage = mock((_params: { text: string; metadata?: Record<string, unknown> }) => {
    // Mock implementation
  })

  return {
    id: 'test-chat-id',
    messages,
    sendMessage,
    status,
    regenerate: mock(),
    stop: mock(),
    append: mock(),
    reload: mock(),
    setMessages: mock(),
    setData: mock(),
    setStatus: mock(),
  } as unknown as Chat<ThunderboltUIMessage>
}

// Mock useChatStore hook - returns chatInstance and chatThreadId
// The selector receives the full store state, so we provide all required fields
const createMockUseChatStore = (chatInstance: Chat<ThunderboltUIMessage> | null, chatThreadId: string | null) => {
  return ((
    selector: (state: {
      chatInstance: Chat<ThunderboltUIMessage> | null
      chatThread: unknown
      id: string | null
      mcpClients: unknown[]
      models: unknown[]
      selectedModel: unknown
      triggerData: unknown
      hydrate: unknown
      reset: unknown
      sendMessage: unknown
      setSelectedModel: unknown
    }) => unknown,
  ) => {
    // Create a mock state object that matches the store structure
    const mockState = {
      chatInstance,
      chatThread: null,
      id: chatThreadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
      hydrate: mock(),
      reset: mock(),
      sendMessage: mock(),
      setSelectedModel: mock(),
    }
    return selector(mockState)
  }) as unknown as typeof import('./chat-store').useChatStore
}

// Mock useChat hook that reads from chat instance
const createMockUseChat = (chatInstance: Chat<ThunderboltUIMessage>) => {
  return ((_options?: { chat?: Chat<ThunderboltUIMessage> }) => ({
    id: chatInstance.id,
    status: chatInstance.status,
    messages: chatInstance.messages,
    error: undefined,
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

// Mock useThrottledCallback hook
const createMockUseThrottledCallback = () => {
  return ((callback: (...args: unknown[]) => void, _interval: number) => {
    // Return the callback directly (no throttling for simpler testing)
    // Tests can override this to test throttling behavior
    return callback
  }) as unknown as typeof import('@/hooks/use-throttle').useThrottledCallback
}

describe('SavePartialAssistantMessagesHandler', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  it('should render children without modification', () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance()
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    const { container } = render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        <div data-testid="child">Test Child</div>
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument()
    expect(container.textContent).toBe('Test Child')
  })

  it('should not save messages when not streaming', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'ready')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait a bit to ensure no saves happen
    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should not save messages when latest message is not from assistant', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait a bit to ensure no saves happen
    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should save partial assistant message when streaming', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello, this is a partial response...' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // With mock throttled callback (no throttling), should be called immediately
    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockSaveMessages).toHaveBeenCalled()
    expect(mockSaveMessages).toHaveBeenCalledWith({
      id: 'thread-1',
      messages: [messages[0]],
    })
  })

  it('should use throttled callback to save messages', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Streaming message' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // With mock throttled callback (no throttling), should be called immediately
    await act(async () => {
      await getClock().tickAsync(10)
    })

    // Should have been called (throttling is handled by useThrottledCallback, tested separately)
    expect(mockSaveMessages).toHaveBeenCalled()
    expect(mockSaveMessages).toHaveBeenCalledWith({
      id: 'thread-1',
      messages: [messages[0]],
    })
  })

  it('should save message with correct thread id', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const threadId = 'custom-thread-id'
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Test message' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, threadId)
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockSaveMessages).toHaveBeenCalledWith({
      id: threadId,
      messages: [messages[0]],
    })
  })

  it('should handle messages array with multiple messages and save only the latest', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi there' }],
      },
      {
        id: 'msg-3',
        role: 'assistant',
        parts: [{ type: 'text', text: 'This is the latest partial message' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockSaveMessages).toHaveBeenCalledWith({
      id: 'thread-1',
      messages: [messages[2]], // Should save only the latest message
    })
  })

  it('should not save when messages array is empty', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance([], 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const mockUseThrottledCallback = createMockUseThrottledCallback()

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
        useThrottledCallback={mockUseThrottledCallback}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should work with dependency injection for all dependencies', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const mockThrottledCallback = mock((callback: (message: ThunderboltUIMessage) => void) => {
      // Return a function that calls the callback immediately (no throttling for this test)
      return (message: ThunderboltUIMessage) => {
        callback(message)
      }
    })
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Test' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChatStore = createMockUseChatStore(mockChatInstance, 'thread-1')
    const mockUseChat = createMockUseChat(mockChatInstance)

    render(
      <SavePartialAssistantMessagesHandler
        saveMessages={mockSaveMessages}
        useThrottledCallback={
          mockThrottledCallback as unknown as typeof import('@/hooks/use-throttle').useThrottledCallback
        }
        useChatStore={mockUseChatStore}
        useChat={mockUseChat}
      >
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(10)
    })

    // Should have been called with the injected throttled callback
    expect(mockThrottledCallback).toHaveBeenCalled()
    expect(mockSaveMessages).toHaveBeenCalled()
  })
})
