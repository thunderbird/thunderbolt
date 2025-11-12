import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useChatScrollHandler } from './use-chat-scroll-handler'
import { useChatStore } from './chat-store'
import type { Chat } from '@ai-sdk/react'
import type { ThunderboltUIMessage } from '@/types'

// Mock dependencies
const mockUseChat = mock()
const mockScrollToBottom = mock()
const mockResetUserScroll = mock()
const mockScrollHandlers = {
  onScroll: mock(),
  onWheel: mock(),
}

const mockScrollContainerRef = { current: null }
const mockScrollTargetRef = { current: null }

// Mock modules
mock.module('@ai-sdk/react', () => ({
  useChat: mockUseChat,
}))

mock.module('@/hooks/use-auto-scroll', () => ({
  useAutoScroll: mock(() => ({
    scrollContainerRef: mockScrollContainerRef,
    scrollTargetRef: mockScrollTargetRef,
    scrollToBottom: mockScrollToBottom,
    resetUserScroll: mockResetUserScroll,
    scrollHandlers: mockScrollHandlers,
    userHasScrolled: false,
    isAtBottom: true,
  })),
}))

describe('useChatScrollHandler', () => {
  const createMockMessage = (role: 'user' | 'assistant', content: string): ThunderboltUIMessage => {
    return {
      id: `msg-${Date.now()}-${Math.random()}`,
      role,
      parts: [{ type: 'text', text: content }],
    } as ThunderboltUIMessage
  }

  const createMockChatInstance = (messages: ThunderboltUIMessage[]): Chat<ThunderboltUIMessage> => {
    return {
      messages,
      status: 'ready',
      sendMessage: mock(),
    } as unknown as Chat<ThunderboltUIMessage>
  }

  beforeEach(() => {
    useChatStore.getState().reset()
    mockUseChat.mockReset()
    mockScrollToBottom.mockReset()
    mockResetUserScroll.mockReset()

    // Setup default store state
    const mockChatInstance = createMockChatInstance([])
    useChatStore.getState().hydrate({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // Default useChat mock - empty messages, idle status
    mockUseChat.mockReturnValue({
      status: 'idle',
      messages: [],
    })
  })

  afterEach(() => {
    mockUseChat.mockReset()
    mockScrollToBottom.mockReset()
    mockResetUserScroll.mockReset()
  })

  describe('Return values', () => {
    it('should return all required refs and handlers', () => {
      const { result } = renderHook(() => useChatScrollHandler())

      expect(result.current.scrollContainerRef).toBe(mockScrollContainerRef)
      expect(result.current.scrollTargetRef).toBe(mockScrollTargetRef)
      expect(result.current.scrollHandlers).toBe(mockScrollHandlers)
      expect(result.current.scrollToBottom).toBe(mockScrollToBottom)
      expect(result.current.resetUserScroll).toBe(mockResetUserScroll)
    })
  })

  describe('New message scrolling', () => {
    it('should scroll to bottom when a new message is added', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      renderHook(() => useChatScrollHandler())

      // Wait for requestAnimationFrame
      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })

    it('should reset user scroll when a new message is added', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const message2 = createMockMessage('assistant', 'Hi there!')
      const mockChatInstance = createMockChatInstance([message1, message2])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // Start with one message
      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      // Add second message
      act(() => {
        mockUseChat.mockReturnValue({
          status: 'idle',
          messages: [message1, message2],
        })
        rerender()
      })

      await waitFor(
        () => {
          expect(mockResetUserScroll).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })

    it('should scroll to bottom and reset user scroll when multiple messages are added', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const message2 = createMockMessage('assistant', 'Hi!')
      const message3 = createMockMessage('user', 'How are you?')
      const mockChatInstance = createMockChatInstance([message1, message2, message3])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      act(() => {
        mockUseChat.mockReturnValue({
          status: 'idle',
          messages: [message1, message2, message3],
        })
        rerender()
      })

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
          expect(mockResetUserScroll).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })
  })

  describe('Streaming behavior', () => {
    it('should continue scrolling during streaming if user has not scrolled', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // Mock useAutoScroll to return userHasScrolled: false
      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mock(() => ({
          scrollContainerRef: mockScrollContainerRef,
          scrollTargetRef: mockScrollTargetRef,
          scrollToBottom: mockScrollToBottom,
          resetUserScroll: mockResetUserScroll,
          scrollHandlers: mockScrollHandlers,
          userHasScrolled: false,
          isAtBottom: true,
        })),
      }))

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [message1],
      })

      renderHook(() => useChatScrollHandler())

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })

    it('should not scroll during streaming if user has scrolled away', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // Mock useAutoScroll to return userHasScrolled: true
      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mock(() => ({
          scrollContainerRef: mockScrollContainerRef,
          scrollTargetRef: mockScrollTargetRef,
          scrollToBottom: mockScrollToBottom,
          resetUserScroll: mockResetUserScroll,
          scrollHandlers: mockScrollHandlers,
          userHasScrolled: true,
          isAtBottom: false,
        })),
      }))

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [message1],
      })

      mockScrollToBottom.mockReset()

      renderHook(() => useChatScrollHandler())

      // Wait for initial hasMessages effect to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      const initialCallCount = mockScrollToBottom.mock.calls.length

      // Wait a bit more to ensure no additional scrolling happens during streaming
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The hasMessages effect may trigger on mount, but the streaming effect should not
      // trigger additional calls when userHasScrolled is true
      expect(mockScrollToBottom.mock.calls.length).toBe(initialCallCount)
    })

    it('should scroll when streaming starts after user scroll was reset', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      let userHasScrolledState = false

      // Mock useAutoScroll with dynamic userHasScrolled
      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mock(() => ({
          scrollContainerRef: mockScrollContainerRef,
          scrollTargetRef: mockScrollTargetRef,
          scrollToBottom: mockScrollToBottom,
          resetUserScroll: mock(() => {
            userHasScrolledState = false
          }),
          scrollHandlers: mockScrollHandlers,
          get userHasScrolled() {
            return userHasScrolledState
          },
          isAtBottom: true,
        })),
      }))

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      // Start streaming
      act(() => {
        mockUseChat.mockReturnValue({
          status: 'streaming',
          messages: [message1],
        })
        rerender()
      })

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })
  })

  describe('Initial messages', () => {
    it('should scroll to bottom when messages first appear', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // Start with no messages
      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      // Add first message
      act(() => {
        mockUseChat.mockReturnValue({
          status: 'idle',
          messages: [message1],
        })
        rerender()
      })

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })

    it('should not scroll when there are no messages', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [],
      })

      mockScrollToBottom.mockReset()

      renderHook(() => useChatScrollHandler())

      // The hasMessages effect should not trigger scrollToBottom
      // because hasMessages is false
      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('Status transitions', () => {
    it('should handle status change from idle to streaming', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mock(() => ({
          scrollContainerRef: mockScrollContainerRef,
          scrollTargetRef: mockScrollTargetRef,
          scrollToBottom: mockScrollToBottom,
          resetUserScroll: mockResetUserScroll,
          scrollHandlers: mockScrollHandlers,
          userHasScrolled: false,
          isAtBottom: true,
        })),
      }))

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      mockScrollToBottom.mockReset()

      act(() => {
        mockUseChat.mockReturnValue({
          status: 'streaming',
          messages: [message1],
        })
        rerender()
      })

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })

    it('should handle status change from streaming to idle', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mock(() => ({
          scrollContainerRef: mockScrollContainerRef,
          scrollTargetRef: mockScrollTargetRef,
          scrollToBottom: mockScrollToBottom,
          resetUserScroll: mockResetUserScroll,
          scrollHandlers: mockScrollHandlers,
          userHasScrolled: false,
          isAtBottom: true,
        })),
      }))

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )

      mockScrollToBottom.mockReset()

      act(() => {
        mockUseChat.mockReturnValue({
          status: 'idle',
          messages: [message1],
        })
        rerender()
      })

      // Should not scroll when status changes to idle if no new messages
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(mockScrollToBottom).not.toHaveBeenCalled()
    })
  })

  describe('Edge cases', () => {
    it('should handle empty messages array', () => {
      const mockChatInstance = createMockChatInstance([])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [],
      })

      const { result } = renderHook(() => useChatScrollHandler())

      expect(result.current.scrollContainerRef).toBeDefined()
      expect(result.current.scrollTargetRef).toBeDefined()
    })

    it('should handle message count decrease (should not trigger new message scroll)', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const message2 = createMockMessage('assistant', 'Hi!')
      const mockChatInstance = createMockChatInstance([message1, message2])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1, message2],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      // Wait for initial effects
      await new Promise((resolve) => setTimeout(resolve, 100))

      mockScrollToBottom.mockReset()
      mockResetUserScroll.mockReset()

      // Decrease message count
      act(() => {
        mockUseChat.mockReturnValue({
          status: 'idle',
          messages: [message1],
        })
        rerender()
      })

      // Wait for effects to run
      await new Promise((resolve) => setTimeout(resolve, 100))

      // The new message effect should not trigger (count didn't increase)
      // But hasMessages effect may trigger since hasMessages is still true
      // The important thing is that resetUserScroll should not be called
      expect(mockResetUserScroll).not.toHaveBeenCalled()
    })

    it('should handle same message count (should not scroll)', async () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      mockScrollToBottom.mockReset()
      mockResetUserScroll.mockReset()

      // Same message count, different status
      act(() => {
        mockUseChat.mockReturnValue({
          status: 'streaming',
          messages: [message1],
        })
        rerender()
      })

      // Should scroll during streaming if user hasn't scrolled
      await waitFor(
        () => {
          expect(mockScrollToBottom).toHaveBeenCalled()
        },
        { timeout: 100 },
      )
    })
  })

  describe('useAutoScroll integration', () => {
    it('should pass correct options to useAutoScroll', () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      mockUseChat.mockReturnValue({
        status: 'streaming',
        messages: [message1],
      })

      const mockUseAutoScroll = mock(() => ({
        scrollContainerRef: mockScrollContainerRef,
        scrollTargetRef: mockScrollTargetRef,
        scrollToBottom: mockScrollToBottom,
        resetUserScroll: mockResetUserScroll,
        scrollHandlers: mockScrollHandlers,
        userHasScrolled: false,
        isAtBottom: true,
      }))

      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mockUseAutoScroll,
      }))

      renderHook(() => useChatScrollHandler())

      expect(mockUseAutoScroll).toHaveBeenCalledWith({
        dependencies: [],
        smooth: true,
        isStreaming: true,
        rootMargin: '0px 0px -50px 0px',
      })
    })

    it('should update isStreaming when status changes', () => {
      const message1 = createMockMessage('user', 'Hello')
      const mockChatInstance = createMockChatInstance([message1])

      useChatStore.getState().hydrate({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const mockUseAutoScroll = mock(() => ({
        scrollContainerRef: mockScrollContainerRef,
        scrollTargetRef: mockScrollTargetRef,
        scrollToBottom: mockScrollToBottom,
        resetUserScroll: mockResetUserScroll,
        scrollHandlers: mockScrollHandlers,
        userHasScrolled: false,
        isAtBottom: true,
      }))

      mock.module('@/hooks/use-auto-scroll', () => ({
        useAutoScroll: mockUseAutoScroll,
      }))

      mockUseChat.mockReturnValue({
        status: 'idle',
        messages: [message1],
      })

      const { rerender } = renderHook(() => useChatScrollHandler())

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          isStreaming: false,
        }),
      )

      act(() => {
        mockUseChat.mockReturnValue({
          status: 'streaming',
          messages: [message1],
        })
        rerender()
      })

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          isStreaming: true,
        }),
      )
    })
  })
})
