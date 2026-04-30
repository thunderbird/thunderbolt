/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useChatScrollHandler } from './use-chat-scroll-handler'

// Create mock useCurrentChatSession via dependency injection (not mock.module to prevent test pollution)
const createMockUseCurrentChatSession = (): any =>
  mock(() => ({
    chatInstance: { id: 'test-chat' },
  }))

describe('useChatScrollHandler', () => {
  afterEach(() => {
    cleanup()
  })

  // Helper to create mock useChat with controlled status and messages
  const createMockUseChat = (status: string, messages: any[] = []): any => {
    return mock(() => ({ status, messages }))
  }

  // Helper to create mock useAutoScroll with spy-able scrollToBottom
  const createMockUseAutoScroll = (): any => {
    const mockScrollToBottom = mock(() => true)
    const mockResetUserScroll = mock()
    const mockOnWheel = mock()
    const mockOnTouchStart = mock()
    const mockScrollContainerRef = mock()
    const mockScrollTargetRef = mock()

    const mockUseAutoScroll = mock(() => ({
      scrollContainerRef: mockScrollContainerRef,
      scrollTargetRef: mockScrollTargetRef,
      scrollToBottom: mockScrollToBottom,
      resetUserScroll: mockResetUserScroll,
      scrollHandlers: {
        onWheel: mockOnWheel,
        onTouchStart: mockOnTouchStart,
      },
      isAtBottom: true,
    }))

    return {
      mockUseAutoScroll,
      mockScrollToBottom,
      mockResetUserScroll,
      mockScrollContainerRef,
      mockScrollTargetRef,
    }
  }

  describe('initialization', () => {
    it('should return all required refs and handlers', () => {
      const { mockUseAutoScroll } = createMockUseAutoScroll()
      const mockUseChat = createMockUseChat('idle')
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll,
          useChat: mockUseChat,
          useCurrentChatSession: mockUseCurrentChatSession,
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
    describe('submit trigger', () => {
      it('scrolls when status changes to submitted', () => {
        const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
        const mockUseCurrentChatSession = createMockUseCurrentChatSession()

        const { rerender } = renderHook(
          ({ status }) =>
            useChatScrollHandler({
              useAutoScroll: mockUseAutoScroll,
              useChat: createMockUseChat(status),
              useCurrentChatSession: mockUseCurrentChatSession,
            }),
          {
            initialProps: { status: 'idle' },
          },
        )

        // Clear any initial calls
        mockScrollToBottom.mockClear()

        // Change status to submitted
        act(() => {
          rerender({ status: 'submitted' })
        })

        // Should call scrollToBottom with smooth=true, programmatic=true
        expect(mockScrollToBottom).toHaveBeenCalledTimes(1)
        expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
      })

      it('does not scroll when status stays submitted', () => {
        const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
        const mockUseCurrentChatSession = createMockUseCurrentChatSession()

        const { rerender } = renderHook(
          ({ status }) =>
            useChatScrollHandler({
              useAutoScroll: mockUseAutoScroll,
              useChat: createMockUseChat(status),
              useCurrentChatSession: mockUseCurrentChatSession,
            }),
          {
            initialProps: { status: 'submitted' },
          },
        )

        mockScrollToBottom.mockClear()

        // Status doesn't change (still submitted)
        act(() => {
          rerender({ status: 'submitted' })
        })

        // Should NOT scroll
        expect(mockScrollToBottom).not.toHaveBeenCalled()
      })
    })

    describe('streaming start trigger', () => {
      it('does not scroll on submitted to streaming transition (viewport positioning handles this)', () => {
        // With viewport positioning, scrolling on submitted→streaming was removed
        // The scroll now happens on submit, not on streaming start
        const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
        const mockUseCurrentChatSession = createMockUseCurrentChatSession()

        const { rerender } = renderHook(
          ({ status }) =>
            useChatScrollHandler({
              useAutoScroll: mockUseAutoScroll,
              useChat: createMockUseChat(status),
              useCurrentChatSession: mockUseCurrentChatSession,
            }),
          {
            initialProps: { status: 'submitted' },
          },
        )

        mockScrollToBottom.mockClear()

        // Change from submitted to streaming
        act(() => {
          rerender({ status: 'streaming' })
        })

        // No scroll on this transition - viewport was already positioned on submit
        expect(mockScrollToBottom).not.toHaveBeenCalled()
      })

      it('does not scroll when transitioning to streaming from non-submitted status', () => {
        const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
        const mockUseCurrentChatSession = createMockUseCurrentChatSession()

        const { rerender } = renderHook(
          ({ status }) =>
            useChatScrollHandler({
              useAutoScroll: mockUseAutoScroll,
              useChat: createMockUseChat(status),
              useCurrentChatSession: mockUseCurrentChatSession,
            }),
          {
            initialProps: { status: 'idle' },
          },
        )

        mockScrollToBottom.mockClear()

        // Change from idle to streaming (not from submitted)
        act(() => {
          rerender({ status: 'streaming' })
        })

        // Should NOT scroll because previous status wasn't 'submitted'
        expect(mockScrollToBottom).not.toHaveBeenCalled()
      })
    })

    describe('rapid status transitions', () => {
      it('handles submitted → streaming → idle transitions correctly', () => {
        const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
        const mockUseCurrentChatSession = createMockUseCurrentChatSession()

        const { rerender } = renderHook(
          ({ status }) =>
            useChatScrollHandler({
              useAutoScroll: mockUseAutoScroll,
              useChat: createMockUseChat(status),
              useCurrentChatSession: mockUseCurrentChatSession,
            }),
          {
            initialProps: { status: 'idle' },
          },
        )

        mockScrollToBottom.mockClear()

        // Transition: idle → submitted
        act(() => {
          rerender({ status: 'submitted' })
        })
        // Should scroll on submit (for < 3 messages, uses scrollToBottom)
        expect(mockScrollToBottom).toHaveBeenCalledTimes(1)

        mockScrollToBottom.mockClear()

        // Transition: submitted → streaming
        act(() => {
          rerender({ status: 'streaming' })
        })
        // No scroll on this transition - viewport was already positioned on submit
        expect(mockScrollToBottom).not.toHaveBeenCalled()

        mockScrollToBottom.mockClear()

        // Transition: streaming → idle
        act(() => {
          rerender({ status: 'idle' })
        })
        // No scroll on this transition
        expect(mockScrollToBottom).not.toHaveBeenCalled()
      })
    })
  })

  describe('first token detection', () => {
    it('scrolls when first text content arrives during streaming', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat(status, messages),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        {
          initialProps: {
            status: 'streaming' as string,
            messages: [] as any[],
          },
        },
      )

      mockScrollToBottom.mockClear()

      // Add assistant message with text content
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ],
        })
      })

      expect(mockScrollToBottom).toHaveBeenCalledTimes(1)
      expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
    })

    it('does not scroll on empty parts array', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat(status, messages),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        {
          initialProps: {
            status: 'streaming' as string,
            messages: [] as any[],
          },
        },
      )

      mockScrollToBottom.mockClear()

      // Add assistant message with empty parts
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [],
            },
          ],
        })
      })

      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })

    it('does not scroll on parts with empty text', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat(status, messages),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        {
          initialProps: {
            status: 'streaming' as string,
            messages: [] as any[],
          },
        },
      )

      mockScrollToBottom.mockClear()

      // Add assistant message with empty text
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: '' }],
            },
          ],
        })
      })

      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })

    it('does not scroll on second token (only first token)', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat(status, messages),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        {
          initialProps: {
            status: 'streaming',
            messages: [
              {
                role: 'assistant',
                parts: [{ type: 'text', text: 'Hello' }],
              },
            ],
          },
        },
      )

      mockScrollToBottom.mockClear()

      // Add more content (second token)
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello world' }],
            },
          ],
        })
      })

      // Should NOT scroll on subsequent tokens
      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })

    it('does not crash when messages array is empty during streaming', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      expect(() => {
        renderHook(() =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat('streaming', []),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        )
      }).not.toThrow()

      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })

    it('ignores non-assistant messages for first token detection', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll,
          useChat: createMockUseChat('streaming', [
            {
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            },
          ]),
          useCurrentChatSession: mockUseCurrentChatSession,
        }),
      )

      // Should not scroll for user messages
      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('hasScrolledForFirstTokenRef reset', () => {
    it('resets flag on new message submit (flag tracks first-token scroll state)', () => {
      const { mockUseAutoScroll, mockScrollToBottom } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()

      const { rerender } = renderHook(
        ({ status, messages }) =>
          useChatScrollHandler({
            useAutoScroll: mockUseAutoScroll,
            useChat: createMockUseChat(status, messages),
            useCurrentChatSession: mockUseCurrentChatSession,
          }),
        {
          initialProps: {
            status: 'streaming',
            messages: [
              {
                role: 'assistant',
                parts: [{ type: 'text', text: 'First response' }],
              },
            ],
          },
        },
      )

      // First token scroll happens during init (1 message, so scrollToBottom is called)
      expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
      mockScrollToBottom.mockClear()

      // Complete first message
      act(() => {
        rerender({
          status: 'idle',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'First response complete' }],
            },
          ],
        })
      })

      // User submits second message (now 2 messages: 1 assistant + 1 user)
      act(() => {
        rerender({
          status: 'submitted',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'First response complete' }],
            },
            {
              role: 'user',
              parts: [{ type: 'text', text: 'Second question' }],
            },
          ],
        })
      })

      // Should scroll on submit (< 3 messages, so uses scrollToBottom)
      expect(mockScrollToBottom).toHaveBeenCalledWith(true, true)
      mockScrollToBottom.mockClear()

      // Start streaming second response
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'First response complete' }],
            },
            {
              role: 'user',
              parts: [{ type: 'text', text: 'Second question' }],
            },
          ],
        })
      })

      // No scroll on submitted→streaming transition
      expect(mockScrollToBottom).not.toHaveBeenCalled()
      mockScrollToBottom.mockClear()

      // Second assistant response arrives (now 3 messages)
      act(() => {
        rerender({
          status: 'streaming',
          messages: [
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'First response complete' }],
            },
            {
              role: 'user',
              parts: [{ type: 'text', text: 'Second question' }],
            },
            {
              role: 'assistant',
              parts: [{ type: 'text', text: 'Second response' }],
            },
          ],
        })
      })

      // With 3 messages, viewport positioning is used - no scrollToBottom on first token
      // (viewport was already positioned on submit)
      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('scrollToBottomAndActivate', () => {
    it('calls scrollToBottom and resetUserScroll when scroll succeeds', () => {
      const { mockUseAutoScroll, mockScrollToBottom, mockResetUserScroll } = createMockUseAutoScroll()
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()
      mockScrollToBottom.mockReturnValue(true) // Simulate successful scroll

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll,
          useChat: createMockUseChat('idle'),
          useCurrentChatSession: mockUseCurrentChatSession,
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
      const mockUseCurrentChatSession = createMockUseCurrentChatSession()
      mockScrollToBottom.mockReturnValue(false) // Simulate failed scroll

      const { result } = renderHook(() =>
        useChatScrollHandler({
          useAutoScroll: mockUseAutoScroll,
          useChat: createMockUseChat('idle'),
          useCurrentChatSession: mockUseCurrentChatSession,
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
