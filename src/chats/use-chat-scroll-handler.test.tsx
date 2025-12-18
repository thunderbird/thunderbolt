import { createMockChatInstance, createMockUseChat, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatScrollHandler } from './use-chat-scroll-handler'

type MockUseAutoScrollReturn = {
  scrollToBottom: ReturnType<typeof mock>
  resetUserScroll: ReturnType<typeof mock>
  mockHook: typeof import('@/hooks/use-auto-scroll').useAutoScroll
}

const createMockUseAutoScroll = (userHasScrolled: boolean = false): MockUseAutoScrollReturn => {
  const scrollToBottom = mock((_smooth?: boolean) => {})
  const resetUserScroll = mock(() => {})
  const scrollContainerRef = { current: null }
  const scrollTargetRef = { current: null }
  const scrollHandlers = {
    onScroll: () => {},
    onWheel: () => {},
    onTouchStart: () => {},
  }

  const mockHook = ((_options?: {
    dependencies?: unknown[]
    smooth?: boolean
    isStreaming?: boolean
    onUserScroll?: (isAtBottom: boolean) => void
    rootMargin?: string
  }) => ({
    scrollContainerRef,
    scrollTargetRef,
    scrollToBottom,
    resetUserScroll,
    scrollHandlers,
    userHasScrolled,
    isAtBottom: !userHasScrolled,
  })) as unknown as typeof import('@/hooks/use-auto-scroll').useAutoScroll

  return {
    scrollToBottom,
    resetUserScroll,
    mockHook,
  }
}

describe('useChatScrollHandler', () => {
  beforeEach(() => {
    resetStore()
  })

  afterEach(() => {
    cleanup()
    resetStore()
  })

  it('should return all required refs and handlers', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current).toHaveProperty('isAtBottom')
    expect(result.current).toHaveProperty('resetUserScroll')
    expect(result.current).toHaveProperty('scrollContainerRef')
    expect(result.current).toHaveProperty('scrollHandlers')
    expect(result.current).toHaveProperty('scrollTargetRef')
    expect(result.current).toHaveProperty('scrollToBottom')
    expect(typeof result.current.scrollToBottom).toBe('function')
    expect(typeof result.current.resetUserScroll).toBe('function')
  })

  it('should return isAtBottom as true when user has not scrolled', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll(false) // userHasScrolled = false

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current.isAtBottom).toBe(true)
  })

  it('should return isAtBottom as false when user has scrolled', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll(true) // userHasScrolled = true

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current.isAtBottom).toBe(false)
  })

  it('should call scrollToBottom and resetUserScroll when scrollToBottom is called', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottom()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).toHaveBeenCalled()
  })

  it('should pass smooth parameter to scrollToBottom', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook, scrollToBottom } = createMockUseAutoScroll()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottom(false)
    })

    expect(scrollToBottom).toHaveBeenCalledWith(false)
  })

  it('should pass correct options to useAutoScroll', () => {
    const mockChatInstance = createMockChatInstance([], 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)
    const capturedOptions: unknown[] = []

    const mockUseAutoScroll = ((options?: unknown) => {
      capturedOptions.push(options)
      return {
        scrollContainerRef: { current: null },
        scrollTargetRef: { current: null },
        scrollToBottom: mock(),
        resetUserScroll: mock(),
        scrollHandlers: { onScroll: () => {}, onWheel: () => {}, onTouchStart: () => {} },
        userHasScrolled: false,
        isAtBottom: true,
      }
    }) as unknown as typeof import('@/hooks/use-auto-scroll').useAutoScroll

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockUseAutoScroll }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(capturedOptions.length).toBeGreaterThan(0)
    const options = capturedOptions[0] as { dependencies?: unknown[]; smooth?: boolean; isStreaming?: boolean }
    expect(options.smooth).toBe(true)
    expect(options.isStreaming).toBe(true)
    expect(options.dependencies).toBeDefined()
  })

  it('should work with dependency injection for useChat and useAutoScroll', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { result } = renderHook(() => useChatScrollHandler({ useChat: mockUseChat, useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current).toBeDefined()
    expect(result.current.scrollContainerRef).toBeDefined()
    expect(result.current.scrollTargetRef).toBeDefined()
    expect(result.current.scrollHandlers).toBeDefined()
  })
})
