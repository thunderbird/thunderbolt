/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createMockChatInstance, createMockUseChat, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { getClock } from '@/testing-library'
import type { ThunderboltUIMessage } from '@/types'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'

type StreamingSaveParams = { threadId: string; message: ThunderboltUIMessage; parentId: string | null }

/** Flip a mock chat instance's read-only `status` for a rerender. */
const setStatus = (instance: ReturnType<typeof createMockChatInstance>, status: 'streaming' | 'ready' | 'error') => {
  ;(instance as unknown as { status: string }).status = status
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
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance()
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        <div data-testid="child">Test Child</div>
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument()
    expect(container.textContent).toBe('Test Child')
  })

  it('should not save messages when not streaming', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'ready')
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(600)
    })

    expect(mockSaveStreamingMessage).not.toHaveBeenCalled()
  })

  it('should not save messages when latest message is not from assistant', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(600)
    })

    expect(mockSaveStreamingMessage).not.toHaveBeenCalled()
  })

  it('should save partial assistant message when streaming', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi' }],
      },
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello, this is a partial response...' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // The first throttled call fires immediately (no clock tick needed).
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)
    expect(mockSaveStreamingMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      message: messages[1],
      parentId: 'user-1',
    })
  })

  it('should save with correct thread id', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // No user message before it → parent is null.
    expect(mockSaveStreamingMessage).toHaveBeenCalledWith({
      threadId,
      message: messages[0],
      parentId: null,
    })
  })

  it('should save only the latest message and derive parent from the one before it', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    expect(mockSaveStreamingMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      message: messages[2], // only the latest message
      parentId: 'msg-2', // the message immediately before it
    })
  })

  it('should not save when messages array is empty', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance([], 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      await getClock().tickAsync(600)
    })

    expect(mockSaveStreamingMessage).not.toHaveBeenCalled()
  })

  it('should throttle rapid partial updates', async () => {
    const mockSaveStreamingMessage = mock((_params: StreamingSaveParams) => Promise.resolve())
    const mockChatInstance = createMockChatInstance(
      [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
      ],
      'streaming',
    )
    const mockUseChat = createMockUseChat(mockChatInstance)

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { rerender } = render(
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // First render → immediate save.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // Rapid subsequent partials within the throttle window are coalesced.
    await act(async () => {
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'ab' }] },
      ]
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'abc' }] },
      ]
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })

    // Still only the immediate call — the trailing one is pending.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    await act(async () => {
      await getClock().tickAsync(600)
    })

    // Trailing call flushed once with the freshest snapshot.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(2)
    expect(mockSaveStreamingMessage.mock.calls[1]?.[0]).toEqual({
      threadId: 'thread-1',
      message: { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'abc' }] },
      parentId: 'user-1',
    })
  })

  it('should cancel a pending trailing save when streaming stops (no stale overwrite)', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance(
      [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
      ],
      'streaming',
    )
    const mockUseChat = createMockUseChat(mockChatInstance)

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { rerender } = render(
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Immediate first save.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // A later partial within the window schedules a trailing save.
    await act(async () => {
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'partial-more' }] },
      ]
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // Stream ends before the trailing timer fires (mirrors onFinish taking over).
    await act(async () => {
      setStatus(mockChatInstance, 'ready')
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })

    // Advance well past the throttle interval: the trailing save must NOT fire,
    // so it can't clobber onFinish's complete save with a stale snapshot.
    await act(async () => {
      await getClock().tickAsync(1000)
    })

    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)
  })

  it('should flush the pending trailing save immediately when the stream ends with an error', async () => {
    // onFinish does NOT persist on an error terminal (see chat-instance.ts), so
    // the pending trailing partial is the only record of what streamed before the
    // error — it must fire deterministically (flushed on the error transition)
    // rather than be cancelled or left to the trailing timer.
    const mockSaveStreamingMessage = mock((_params: StreamingSaveParams) => Promise.resolve())
    const mockChatInstance = createMockChatInstance(
      [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
      ],
      'streaming',
    )
    const mockUseChat = createMockUseChat(mockChatInstance)

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { rerender } = render(
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Immediate first (leading-edge) save.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // A later partial within the throttle window schedules a trailing save.
    await act(async () => {
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'partial-more' }] },
      ]
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // Stream ends with an error before the trailing timer fires.
    await act(async () => {
      setStatus(mockChatInstance, 'error')
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })

    // The pending save is flushed synchronously on the error transition (no timer
    // wait), persisting the error partial before a fast remediation retry could
    // pre-empt it.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(2)
    expect(mockSaveStreamingMessage.mock.calls[1]?.[0]).toMatchObject({
      message: { parts: [{ text: 'partial-more' }] },
    })

    // No further save when the (already-drained) timer would have fired.
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(2)
  })

  it('should persist the FINAL content when the last delta and the error land in one commit', async () => {
    // Coalesced terminal: the final content delta and the `error` status flip
    // arrive in the SAME React commit. A blind `flush()` would replay the
    // *previous* delta's args (the last snapshot handed to the throttle while
    // streaming) and permanently drop this final chunk. The handler must instead
    // persist the freshest live message directly.
    const mockSaveStreamingMessage = mock((_params: StreamingSaveParams) => Promise.resolve())
    const mockChatInstance = createMockChatInstance(
      [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'delta-1' }] },
      ],
      'streaming',
    )
    const mockUseChat = createMockUseChat(mockChatInstance)

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    const { rerender } = render(
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Leading save with the first delta.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // A second delta within the throttle window schedules a trailing save whose
    // pending args hold `delta-2`.
    await act(async () => {
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'delta-2' }] },
      ]
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(1)

    // Coalesced commit: the final delta AND the error status flip land together.
    await act(async () => {
      mockChatInstance.messages = [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'delta-final' }] },
      ]
      setStatus(mockChatInstance, 'error')
      rerender(
        <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
          Test
        </SavePartialAssistantMessagesHandler>,
      )
    })

    // The freshest snapshot (`delta-final`) is persisted — NOT the stale
    // `delta-2` a blind flush would have replayed.
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(2)
    expect(mockSaveStreamingMessage.mock.calls[1]?.[0]).toEqual({
      threadId: 'thread-1',
      message: { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'delta-final' }] },
      parentId: 'user-1',
    })

    // The now-redundant pending trailing must not fire afterwards.
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(mockSaveStreamingMessage).toHaveBeenCalledTimes(2)
  })

  it('should work with dependency injection for useChat', async () => {
    const mockSaveStreamingMessage = mock(() => Promise.resolve())
    const messages: ThunderboltUIMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Test' }],
      },
    ]
    const mockChatInstance = createMockChatInstance(messages, 'streaming')
    const mockUseChat = createMockUseChat(mockChatInstance)

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
      <SavePartialAssistantMessagesHandler saveStreamingMessage={mockSaveStreamingMessage} useChat={mockUseChat}>
        Test
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    expect(mockSaveStreamingMessage).toHaveBeenCalled()
  })
})
