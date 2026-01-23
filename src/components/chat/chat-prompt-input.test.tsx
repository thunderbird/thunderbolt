import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { Model } from '@/types'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { BrowserRouter } from 'react-router'
import { ChatPromptInput, type ChatPromptInputRef } from './chat-prompt-input'

// Mock useContextTracking hook
const createMockUseContextTracking =
  (
    isOverflowing: boolean = false,
    isContextKnown: boolean = true,
    usedTokens: number | null = 1000,
    maxTokens: number | null = 2000,
  ) =>
  (_options?: { model?: Model | null; chatThreadId?: string; currentInput?: string; onOverflow?: () => void }) => ({
    usedTokens,
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading: false,
    estimateTokensForInput: (_input: string) => 0,
  })

// Mock useSidebar hook
const createMockUseSidebar =
  (isMobile: boolean = false, openMobile: boolean = false) =>
  () => ({
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
    it('should render the prompt input component', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(<ChatPromptInput useChat={mockUseChat} useSidebar={mockUseSidebar} />, {
        wrapper: TestWrapper,
      })

      expect(container).toBeInTheDocument()
    })
  })

  describe('form submission', () => {
    it('should render textarea for input', () => {
      const mockChatInstance = createMockChatInstance([], 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()

      render(<ChatPromptInput useChat={mockUseChat} useSidebar={mockUseSidebar} />, { wrapper: TestWrapper })

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

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()

      render(
        <ChatPromptInput
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

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()
      const ref = { current: null } as unknown as React.RefObject<ChatPromptInputRef>

      render(<ChatPromptInput ref={ref} useChat={mockUseChat} useSidebar={mockUseSidebar} />, { wrapper: TestWrapper })

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

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()
      const ref = { current: null } as unknown as React.RefObject<ChatPromptInputRef>

      render(<ChatPromptInput ref={ref} useChat={mockUseChat} useSidebar={mockUseSidebar} />, { wrapper: TestWrapper })

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

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(<ChatPromptInput useChat={mockUseChat} useSidebar={mockUseSidebar} />, {
        wrapper: TestWrapper,
      })

      expect(container).toBeInTheDocument()
    })

    it('should work with dependency injection for useContextTracking', () => {
      const mockChatInstance = createMockChatInstance()
      const mockUseChat = createMockUseChat(mockChatInstance)
      const mockModel = createMockModel()
      const mockUseContextTracking = createMockUseContextTracking(false, true, 1000, 2000)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar()

      const { container } = render(
        <ChatPromptInput
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

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [mockModel],
        selectedModel: mockModel,
        triggerData: null,
      })

      const mockUseSidebar = createMockUseSidebar(false, false)

      const { container } = render(<ChatPromptInput useChat={mockUseChat} useSidebar={mockUseSidebar} />, {
        wrapper: TestWrapper,
      })

      expect(container).toBeInTheDocument()
    })
  })
})
