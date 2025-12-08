import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import type { Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { useChatStore } from './chat-store'

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

/**
 * Helper to hydrate the store with a session (replaces old hydrate method)
 */
const hydrateStore = (state: {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: null
  id: string
  mcpClients: never[]
  models: Model[]
  selectedModel: Model | null
  triggerData: null
}) => {
  const store = useChatStore.getState()

  // Set models first
  store.setModels(state.models)

  // Set MCP clients
  store.setMcpClients(state.mcpClients)

  // Create session with a default model if selectedModel is null
  const defaultModel =
    state.selectedModel ??
    ({
      id: 'default-model',
      provider: 'openai',
      name: 'Default Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
      isConfidential: 0,
    } as Model)

  store.createSession({
    chatInstance: state.chatInstance,
    chatThread: state.chatThread,
    id: state.id,
    selectedModel: defaultModel,
    triggerData: state.triggerData,
  })
  store.setCurrentSessionId(state.id)
}

/**
 * Helper to reset the store (replaces old reset method)
 */
const resetStore = () => {
  useChatStore.setState({
    currentSessionId: null,
    mcpClients: [],
    models: [],
    sessions: new Map(),
  })
}

describe('SavePartialAssistantMessagesHandler', () => {
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

  it('should render children without modification', () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { container } = render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait for throttle delay (200ms) plus a bit more
    await act(async () => {
      await getClock().tickAsync(250)
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait for throttle delay (200ms) plus a bit more
    await act(async () => {
      await getClock().tickAsync(250)
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait for throttle delay (200ms) plus a bit more
    await act(async () => {
      await getClock().tickAsync(250)
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
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait for throttle delay (200ms) plus a bit more
    await act(async () => {
      await getClock().tickAsync(250)
    })

    expect(mockSaveMessages).toHaveBeenCalledWith({
      id: 'thread-1',
      messages: [messages[2]], // Should save only the latest message
    })
  })

  it('should not save when messages array is empty', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance([], 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should work with dependency injection for useChat', async () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Test' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Wait for throttle delay (200ms) plus a bit more
    await act(async () => {
      await getClock().tickAsync(250)
    })

    // Should have been called (useChatStore and useThrottledCallback use real hooks)
    expect(mockSaveMessages).toHaveBeenCalled()
  })
})
