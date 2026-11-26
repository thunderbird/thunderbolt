/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMockChatInstance, createMockUseChat, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useChatScrollHandler } from './use-chat-scroll-handler'

type UseAutoScroll = typeof useAutoScroll

const createAutoScrollResult = (isAtBottom: boolean): ReturnType<UseAutoScroll> => ({
  scrollContainerRef: () => {},
  scrollTargetRef: () => {},
  scrollToBottom: mock(() => true),
  scrollToElement: mock(() => true),
  resetUserScroll: mock(() => {}),
  disableAutoScroll: mock(() => {}),
  scrollHandlers: { onWheel: () => {}, onTouchStart: () => {} },
  isAtBottom,
})

const createMockUseAutoScroll = (isAtBottom: boolean = true, scrollSucceeds: boolean = true) => {
  const scrollToBottom = mock((_smooth?: boolean, _programmatic?: boolean) => scrollSucceeds)
  const resetUserScroll = mock(() => {})
  const mockHook: UseAutoScroll = () => ({ ...createAutoScrollResult(isAtBottom), scrollToBottom, resetUserScroll })

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
    expect(result.current).toHaveProperty('scrollContainerRef')
    expect(result.current).toHaveProperty('scrollHandlers')
    expect(result.current).toHaveProperty('scrollTargetRef')
    expect(result.current).toHaveProperty('scrollToBottom')
    expect(result.current).toHaveProperty('scrollToBottomAndActivate')
    expect(result.current.scrollToBottom).toBeInstanceOf(Function)
    expect(result.current.scrollToBottomAndActivate).toBeInstanceOf(Function)
  })

  it('should return isAtBottom as true when at bottom', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll(true)

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

  it('should return isAtBottom as false when not at bottom', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook } = createMockUseAutoScroll(false)

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

  it('should only call scrollToBottom when scrollToBottom is called', () => {
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
    expect(resetUserScroll).not.toHaveBeenCalled()
  })

  it('should call both scrollToBottom and resetUserScroll when scrollToBottomAndActivate succeeds', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll(true, true)

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
      result.current.scrollToBottomAndActivate()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).toHaveBeenCalled()
  })

  it('should not call resetUserScroll when scrollToBottomAndActivate fails (container not ready)', () => {
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)
    const { mockHook, scrollToBottom, resetUserScroll } = createMockUseAutoScroll(true, false)

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
      result.current.scrollToBottomAndActivate()
    })

    expect(scrollToBottom).toHaveBeenCalled()
    expect(resetUserScroll).not.toHaveBeenCalled()
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
    const capturedOptions: Parameters<UseAutoScroll>[0][] = []

    const mockUseAutoScroll: UseAutoScroll = (options) => {
      capturedOptions.push(options)
      return createAutoScrollResult(true)
    }

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
    const [options] = capturedOptions
    expect(options?.smooth).toBe(true)
    expect(options?.isStreaming).toBe(true)
    expect(options?.dependencies).toBeDefined()
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

  describe('when the conversation container resizes', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const disconnect = mock(() => {})
    let resize = () => {}

    beforeEach(() => {
      disconnect.mockClear()
      globalThis.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this)
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect
      }
    })

    afterEach(() => {
      globalThis.ResizeObserver = originalResizeObserver
    })

    const renderAttached = (isAtBottom: boolean) => {
      const mockChatInstance = createMockChatInstance()
      const { mockHook, scrollToBottom } = createMockUseAutoScroll(isAtBottom)
      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })
      const view = renderHook(
        () => useChatScrollHandler({ useChat: createMockUseChat(mockChatInstance), useAutoScroll: mockHook }),
        { wrapper: createQueryTestWrapper() },
      )
      const container = document.createElement('div')
      act(() => view.result.current.scrollContainerRef(container))
      // The observer reports the size it starts with; that is not a resize.
      act(() => resize())
      scrollToBottom.mockClear()
      return { ...view, container, scrollToBottom }
    }

    it('keeps a conversation resting at the end pinned there, without animating', () => {
      const { result, container, scrollToBottom } = renderAttached(true)

      expect(result.current.scrollContainer).toBe(container)
      act(() => resize())

      expect(scrollToBottom).toHaveBeenCalledTimes(1)
      expect(scrollToBottom).toHaveBeenCalledWith(false, true)
    })

    it('leaves a conversation the user scrolled away from where it is', () => {
      const { scrollToBottom } = renderAttached(false)

      act(() => resize())

      expect(scrollToBottom).not.toHaveBeenCalled()
    })

    it('stops observing when the container detaches', () => {
      const { result } = renderAttached(true)

      act(() => result.current.scrollContainerRef(null))

      expect(disconnect).toHaveBeenCalled()
      expect(result.current.scrollContainer).toBeNull()
    })
  })
})
