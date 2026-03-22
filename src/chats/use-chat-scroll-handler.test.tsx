import { hydrateStore, resetStore, createMockModel } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatScrollHandler } from './use-chat-scroll-handler'
import type { ChatStatus } from './chat-store'
import type { ThunderboltUIMessage } from '@/types'

type MockUseAutoScrollReturn = {
  scrollToBottom: ReturnType<typeof mock>
  scrollToElement: ReturnType<typeof mock>
  resetUserScroll: ReturnType<typeof mock>
  mockHook: typeof import('@/hooks/use-auto-scroll').useAutoScroll
}

const createMockUseAutoScroll = (
  isAtBottom: boolean = true,
  scrollSucceeds: boolean = true,
): MockUseAutoScrollReturn => {
  const scrollToBottom = mock((_smooth?: boolean, _force?: boolean) => scrollSucceeds)
  const scrollToElement = mock(
    (_selector: string, _offset?: number, _smooth?: boolean, _force?: boolean) => scrollSucceeds,
  )
  const resetUserScroll = mock(() => {})
  const scrollContainerRef = () => {}
  const scrollTargetRef = () => {}
  const scrollHandlers = {
    onWheel: () => {},
    onTouchStart: () => {},
  }

  const mockHook = ((_options?: {
    dependencies?: unknown[]
    smooth?: boolean
    isStreaming?: boolean
    rootMargin?: string
  }) => ({
    scrollContainerRef,
    scrollTargetRef,
    scrollToBottom,
    scrollToElement,
    resetUserScroll,
    scrollHandlers,
    isAtBottom,
  })) as unknown as typeof import('@/hooks/use-auto-scroll').useAutoScroll

  return {
    scrollToBottom,
    scrollToElement,
    resetUserScroll,
    mockHook,
  }
}

const createMockSession = (messages: ThunderboltUIMessage[] = [], status: ChatStatus = 'ready') => ({
  chatThread: null,
  id: 'thread-1',
  messages,
  status,
  selectedModel: createMockModel(),
  triggerData: null,
})

describe('useChatScrollHandler', () => {
  beforeEach(() => {
    resetStore()
  })

  afterEach(() => {
    cleanup()
    resetStore()
  })

  it('should return all required refs and handlers', () => {
    const { mockHook } = createMockUseAutoScroll()

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current).toHaveProperty('isAtBottom')
    expect(result.current).toHaveProperty('scrollContainerRef')
    expect(result.current).toHaveProperty('scrollHandlers')
    expect(result.current).toHaveProperty('scrollTargetRef')
    expect(result.current).toHaveProperty('scrollToBottom')
    expect(result.current).toHaveProperty('scrollToBottomAndActivate')
    expect(typeof result.current.scrollToBottom).toBe('function')
    expect(typeof result.current.scrollToBottomAndActivate).toBe('function')
  })

  it('should return isAtBottom as true when at bottom', () => {
    const { mockHook } = createMockUseAutoScroll(true)

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current.isAtBottom).toBe(true)
  })

  it('should return isAtBottom as false when not at bottom', () => {
    const { mockHook } = createMockUseAutoScroll(false)

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current.isAtBottom).toBe(false)
  })

  it('should only call scrollToBottom when scrollToBottom is called', () => {
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll()

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottom()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).not.toHaveBeenCalled()
  })

  it('should call both scrollToBottom and resetUserScroll when scrollToBottomAndActivate succeeds', () => {
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll(true, true)

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottomAndActivate()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).toHaveBeenCalled()
  })

  it('should not call resetUserScroll when scrollToBottomAndActivate fails (container not ready)', () => {
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll(true, false)

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottomAndActivate()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).not.toHaveBeenCalled()
  })

  it('should pass smooth parameter to scrollToBottom', () => {
    const { mockHook, scrollToBottom } = createMockUseAutoScroll()

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    act(() => {
      result.current.scrollToBottom(false)
    })

    expect(scrollToBottom).toHaveBeenCalledWith(false)
  })

  it('should pass correct options to useAutoScroll', () => {
    const capturedOptions: unknown[] = []

    const mockUseAutoScroll = ((options?: unknown) => {
      capturedOptions.push(options)
      return {
        scrollContainerRef: () => {},
        scrollTargetRef: () => {},
        scrollToBottom: mock(),
        scrollToElement: mock(),
        resetUserScroll: mock(),
        scrollHandlers: { onWheel: () => {}, onTouchStart: () => {} },
        isAtBottom: true,
      }
    }) as unknown as typeof import('@/hooks/use-auto-scroll').useAutoScroll

    hydrateStore(createMockSession([], 'streaming'))

    renderHook(() => useChatScrollHandler({ useAutoScroll: mockUseAutoScroll }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(capturedOptions.length).toBeGreaterThan(0)
    const options = capturedOptions[0] as { dependencies?: unknown[]; smooth?: boolean; isStreaming?: boolean }
    expect(options.smooth).toBe(true)
    expect(options.isStreaming).toBe(true)
    expect(options.dependencies).toBeDefined()
  })

  it('should work with dependency injection for useAutoScroll', () => {
    const { mockHook } = createMockUseAutoScroll()

    hydrateStore(createMockSession())

    const { result } = renderHook(() => useChatScrollHandler({ useAutoScroll: mockHook }), {
      wrapper: createQueryTestWrapper(),
    })

    expect(result.current).toBeDefined()
    expect(result.current.scrollContainerRef).toBeDefined()
    expect(result.current.scrollTargetRef).toBeDefined()
    expect(result.current.scrollHandlers).toBeDefined()
  })
})
