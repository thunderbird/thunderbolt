import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { BrowserRouter } from 'react-router'
import { ChatPromptInput, type ChatPromptInputRef } from './chat-prompt-input'

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

// Mock useChat hook
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

const createMockChatThread = (overrides?: Partial<ChatThread>): ChatThread => {
  return {
    id: 'thread-1',
    title: 'Test Thread',
    isEncrypted: 0,
    ...overrides,
  } as ChatThread
}

const createMockModel = (overrides?: Partial<Model>): Model => {
  return {
    id: 'model-1',
    provider: 'thunderbolt',
    name: 'Test Model',
    model: 'gpt-oss-120b',
    isSystem: 0,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    url: null,
    defaultHash: null,
    apiKey: null,
    ...overrides,
  } as Model
}

// Mock useContextTracking hook
const createMockUseContextTracking = (
  isOverflowing: boolean = false,
  isContextKnown: boolean = true,
  usedTokens: number | null = 1000,
  maxTokens: number | null = 2000,
) => {
  return (_options?: {
    model?: Model | null
    chatThreadId?: string
    currentInput?: string
    onOverflow?: () => void
  }) => ({
    usedTokens,
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading: false,
    estimateTokensForInput: (_input: string) => 0,
  })
}

// Mock useSidebar hook
const createMockUseSidebar = (isMobile: boolean = false, openMobile: boolean = false) => {
  return () => ({
    isMobile,
    openMobile,
    state: 'expanded' as const,
    open: true,
    setOpen: mock(),
    setOpenMobile: mock(),
    toggleSidebar: mock(),
    width: '16rem',
    setWidth: mock(),
    isDraggingRail: false,
    setIsDraggingRail: mock(),
  })
}

/**
 * Wrapper that includes Router context for useNavigate
 */
const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const queryWrapper = createQueryTestWrapper()
  return createElement(BrowserRouter, null, createElement(queryWrapper, null, children))
}

describe('ChatPromptInput', () => {
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
    // Cleanup rendered components before resetting store to prevent errors during unmount
    cleanup()
    // Reset store state after each test
    useChatStore.getState().reset()
    await resetTestDatabase()
  })

  describe('basic rendering', () => {
    it('should render the prompt input component', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(container).toBeInTheDocument()
    })
  })

  describe('form submission', () => {
    it('should render textarea for input', () => {
      const mockChatInstance = createMockChatInstance([], 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()

      render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      // Verify textarea is rendered
      const textarea = screen.getByPlaceholderText('Ask me anything...')
      expect(textarea).toBeInTheDocument()
    })
  })

  describe('context overflow', () => {
    it('should use context tracking hook', () => {
      const mockChatInstance = createMockChatInstance([], 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()
      const mockUseContextTracking = createMockUseContextTracking(false, true, 1000, 2000)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()

      render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useContextTracking={mockUseContextTracking}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      // Component should render without errors
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })
  })

  describe('ref methods', () => {
    it('should expose focus method that focuses textarea', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()
      const ref = { current: null } as unknown as React.RefObject<ChatPromptInputRef>

      render(
        <ChatPromptInput
          ref={ref}
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(ref.current).not.toBeNull()
      expect(typeof ref.current?.focus).toBe('function')

      const textarea = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
      const focusSpy = mock(() => {})
      const setSelectionRangeSpy = mock(() => {})

      textarea.focus = focusSpy
      textarea.setSelectionRange = setSelectionRangeSpy

      act(() => {
        ref.current?.focus()
      })

      expect(focusSpy).toHaveBeenCalled()
      expect(setSelectionRangeSpy).toHaveBeenCalled()
    })

    it('should expose setInput method that updates input value', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()
      const ref = { current: null } as unknown as React.RefObject<ChatPromptInputRef>

      render(
        <ChatPromptInput
          ref={ref}
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(ref.current).not.toBeNull()
      expect(typeof ref.current?.setInput).toBe('function')

      act(() => {
        ref.current?.setInput('Test input')
      })

      const textarea = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
      expect(textarea.value).toBe('Test input')
    })
  })

  describe('dependency injection', () => {
    it('should work with dependency injection for useChat', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(container).toBeInTheDocument()
    })

    it('should work with dependency injection for useContextTracking', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()
      const mockUseContextTracking = createMockUseContextTracking(false, true, 1000, 2000)

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useContextTracking={mockUseContextTracking}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(container).toBeInTheDocument()
    })

    it('should work with dependency injection for useSidebar', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const handleResetUserScroll = mock()
      const handleScrollToBottom = mock()
      const mockUseSidebar = createMockUseSidebar(false, false)

      const { container } = render(
        <ChatPromptInput
          handleResetUserScroll={handleResetUserScroll}
          handleScrollToBottom={handleScrollToBottom}
          useChat={mockUseChat}
          useSidebar={mockUseSidebar}
        />,
        { wrapper: TestWrapper },
      )

      expect(container).toBeInTheDocument()
    })
  })
})
