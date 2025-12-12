import { createMockChatInstance, createMockUseChat, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatAutomation } from './use-chat-automation'

describe('useChatAutomation', () => {
  let consoleErrorSpy: ReturnType<typeof mock>

  beforeEach(() => {
    // Reset store state before each test
    resetStore()

    // Suppress console.error for tests that intentionally trigger errors
    consoleErrorSpy = mock(() => {})
    console.error = consoleErrorSpy
  })

  afterEach(() => {
    // Cleanup rendered components before resetting store to prevent errors during unmount
    cleanup()
    // Reset store state after each test
    resetStore()
    consoleErrorSpy?.mockRestore()
  })

  it('should trigger regenerate when all conditions are met', async () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    // Wait for useEffect to run
    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).toHaveBeenCalled()
  })

  it('should not trigger if status is not ready', async () => {
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).not.toHaveBeenCalled()
  })

  it('should not trigger if there are no messages', async () => {
    const mockChatInstance = createMockChatInstance([], 'ready')
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).not.toHaveBeenCalled()
  })

  it('should not trigger if last message is not from user', async () => {
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).not.toHaveBeenCalled()
  })

  it('should not trigger multiple times (hasTriggeredRef prevents duplicate triggers)', async () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
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

    const { rerender } = renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    // First render - should trigger
    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).toHaveBeenCalledTimes(1)

    // Re-render - should not trigger again
    rerender()
    await act(async () => {
      await getClock().tickAsync(10)
    })

    // Should still be called only once
    expect(mockChatInstance.regenerate).toHaveBeenCalledTimes(1)
  })

  it('should handle regenerate errors gracefully', async () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'ready')
    const regenerateError = mock(() => Promise.reject(new Error('Regenerate failed')))
    mockChatInstance.regenerate = regenerateError

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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    // Should have attempted to regenerate
    expect(regenerateError).toHaveBeenCalled()
    // Should have logged the error
    expect(consoleErrorSpy).toHaveBeenCalledWith('Auto regenerate error', expect.any(Error))
  })

  it('should trigger when messages array has multiple messages and last is from user', async () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'First response' }],
      },
      {
        id: 'msg-2',
        role: 'user',
        parts: [{ type: 'text', text: 'Second message' }],
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).toHaveBeenCalled()
  })

  it('should not trigger when messages array has multiple messages but last is not from user', async () => {
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'First message' }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Response' }],
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

    renderHook(() => useChatAutomation({ useChat: mockUseChat }), {
      wrapper: createQueryTestWrapper(),
    })

    await act(async () => {
      await getClock().tickAsync(10)
    })

    expect(mockChatInstance.regenerate).not.toHaveBeenCalled()
  })
})
