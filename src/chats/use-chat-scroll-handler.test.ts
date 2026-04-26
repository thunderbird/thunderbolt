import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useChatScrollHandler } from './use-chat-scroll-handler'
import type { ChatStatus } from './chat-store'

describe('useChatScrollHandler', () => {
  afterEach(() => {
    cleanup()
  })

  // Create mock useCurrentChatSession that returns messages and status directly
  const createMockUseCurrentChatSession = (status: ChatStatus = 'ready', messages: unknown[] = []) =>
    (() => ({
      messages,
      status,
    })) as unknown as typeof import('./chat-store').useCurrentChatSession

  // Helper to create mock useAutoScroll with spy-able scrollToBottom
  const createMockUseAutoScroll = (): {
    mockUseAutoScroll: ReturnType<typeof mock>
    mockScrollToBottom: ReturnType<typeof mock>
    mockResetUserScroll: ReturnType<typeof mock>
  } => {
    const mockScrollToBottom = mock(() => true)
    const mockResetUserScroll = mock()

    const mockUseAutoScroll = mock(() => ({
      scrollContainerRef: mock(),
      scrollTargetRef: mock(),
      scrollToBottom: mockScrollToBottom,
      scrollToElement: mock(),
      resetUserScroll: mockResetUserScroll,
      scrollHandlers: { onWheel: mock(), onTouchStart: mock() },
      isAtBottom: true,
    }))

    return { mockUseAutoScroll, mockScrollToBottom, mockResetUserScroll }
  }

  describe('initialization', () => {
    it('should return all required refs and handlers', () => {
      const { mockUseAutoScroll } = createMockUseAutoScroll()

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll as never,
          useCurrentChatSession: createMockUseCurrentChatSession() as never,
        }),
      )

      expect(result.current).toHaveProperty('scrollContainerRef')
      expect(result.current).toHaveProperty('scrollTargetRef')
      expect(result.current).toHaveProperty('isAtBottom')
      expect(result.current).toHaveProperty('scrollToBottom')
      expect(result.current).toHaveProperty('scrollToBottomAndActivate')
      expect(result.current).toHaveProperty('scrollHandlers')
    })
  })

  describe('status transition scrolling', () => {
    it('scrolls when status changes to submitted', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()

      const { rerender } = renderHook(
        ({ status }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll as never,
            useCurrentChatSession: createMockUseCurrentChatSession(status as ChatStatus) as never,
          }),
        { initialProps: { status: 'ready' } },
      )

      mockScrollToBottom.mockClear()

      act(() => {
        rerender({ status: 'submitted' })
      })

      expect(mockScrollToBottom).toHaveBeenCalledTimes(1)
      expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
    })

    it('does not scroll when status stays submitted', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()

      const { rerender } = renderHook(
        ({ status }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll as never,
            useCurrentChatSession: createMockUseCurrentChatSession(status as ChatStatus) as never,
          }),
        { initialProps: { status: 'submitted' } },
      )

      mockScrollToBottom.mockClear()

      act(() => {
        rerender({ status: 'submitted' })
      })

      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('first token detection', () => {
    it('scrolls when first text content arrives during streaming', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll as never,
            useCurrentChatSession: createMockUseCurrentChatSession(status as ChatStatus, messages) as never,
          }),
        {
          initialProps: {
            status: 'streaming' as string,
            messages: [] as unknown[],
          },
        },
      )

      mockScrollToBottom.mockClear()

      act(() => {
        rerender({
          status: 'streaming',
          messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] }],
        })
      })

      expect(mockScrollToBottom).toHaveBeenCalledTimes(1)
      expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
    })

    it('does not scroll on empty parts array', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll as never,
            useCurrentChatSession: createMockUseCurrentChatSession(status as ChatStatus, messages) as never,
          }),
        {
          initialProps: {
            status: 'streaming' as string,
            messages: [] as unknown[],
          },
        },
      )

      mockScrollToBottom.mockClear()

      act(() => {
        rerender({
          status: 'streaming',
          messages: [{ role: 'assistant', parts: [] }],
        })
      })

      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('scrollToBottomAndActivate', () => {
    it('calls scrollToBottom and resetUserScroll when scroll succeeds', () => {
      const { mockUseAutoScroll, mockScrollToBottom, mockResetUserScroll } = createMockUseAutoScroll()
      mockScrollToBottom.mockReturnValue(true)

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll as never,
          useCurrentChatSession: createMockUseCurrentChatSession() as never,
        }),
      )

      act(() => {
        result.current.scrollToBottomAndActivate(true)
      })

      expect(mockScrollToBottom).toHaveBeenCalledWith(true)
      expect(mockResetUserScroll).toHaveBeenCalled()
    })

    it('does not call resetUserScroll when scroll fails', () => {
      const { mockUseAutoScroll, mockScrollToBottom, mockResetUserScroll } = createMockUseAutoScroll()
      mockScrollToBottom.mockReturnValue(false)

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll as never,
          useCurrentChatSession: createMockUseCurrentChatSession() as never,
        }),
      )

      act(() => {
        result.current.scrollToBottomAndActivate(true)
      })

      expect(mockScrollToBottom).toHaveBeenCalledWith(true)
      expect(mockResetUserScroll).not.toHaveBeenCalled()
    })
  })
})
