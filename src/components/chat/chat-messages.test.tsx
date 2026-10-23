/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from '@/chats/chat-store'
import { useConfigStore } from '@/api/config-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { ChatMessages } from './chat-messages'
import { ExternalLinkDialogProvider } from './markdown-utils'
import type { ThunderboltUIMessage } from '@/types'
import { type ReactNode } from 'react'

const createTestWrapper = () => {
  const QueryWrapper = createQueryTestWrapper()
  return ({ children }: { children: ReactNode }) => (
    <QueryWrapper>
      <ContentViewProvider>
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </ContentViewProvider>
    </QueryWrapper>
  )
}

const createTestMessage = (overrides?: Partial<ThunderboltUIMessage>): ThunderboltUIMessage => ({
  id: 'msg-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  ...overrides,
})

/** Expose the actual sidebar selection without mounting its unrelated viewers. */
const SummarySelection = () => {
  const { state } = useContentView()
  return (
    <output data-testid="summary-selection">{state.type === 'compaction-summary' ? state.data.summary : ''}</output>
  )
}

describe('ChatMessages', () => {
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
    useConfigStore.setState({ config: {} })
    await resetTestDatabase()
  })

  describe('basic rendering', () => {
    it('should render user and assistant messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
        createTestMessage({ role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createTestWrapper(),
      })

      // Messages should be rendered - check if text content is present
      expect(container.textContent).toContain('Hello')
      expect(container.textContent).toContain('Hi there')
    })
  })

  describe('compaction history', () => {
    it.each([false, true])('keeps the streaming viewport reservation during compaction (content: %s)', (hasContent) => {
      const { container } = renderHistory(
        [
          createTestMessage({ id: 'old-user' }),
          createTestMessage({ id: 'old-answer', role: 'assistant' }),
          createTestMessage({ id: 'current-user' }),
          createTestMessage({
            id: 'streaming-answer',
            role: 'assistant',
            parts: hasContent ? [{ type: 'text', text: 'Response so far' }] : [{ type: 'step-start' }],
          }),
        ],
        'streaming',
      )
      const wrapper = container.querySelector('[data-message-id="streaming-answer"]')
      expect(wrapper).toHaveStyle({ minHeight: '72dvh' })
      act(() => useChatStore.getState().updateSession('thread-1', { compactionStatus: 'compacting' }))
      expect(container.querySelector('[data-message-id="streaming-answer"]')).toBe(wrapper)
      expect(wrapper).toHaveStyle({ minHeight: '72dvh' })
      expect(wrapper).toHaveTextContent('Compacting…')
      expect(screen.queryByTestId('loading-status')).toBeNull()
      act(() => useChatStore.getState().updateSession('thread-1', { compactionStatus: 'idle' }))
      expect(wrapper).toHaveStyle({ minHeight: '72dvh' })
      expect(screen.queryByTestId('loading-status') !== null).toBe(!hasContent)
    })

    const savedMessage = (id: string, summary: string, role: 'user' | 'assistant' = 'assistant') =>
      createTestMessage({
        id,
        role,
        parts: [{ type: 'text', text: id }],
        metadata: {
          contextCompaction: { version: 1, summary, tokensBefore: 8_000, contextTokens: 2_000, retainedTail: [] },
        },
      })

    const renderHistory = (messages: ThunderboltUIMessage[], status: 'ready' | 'submitted' | 'streaming' = 'ready') => {
      const chatInstance = createMockChatInstance(messages, status)
      const useChat = createMockUseChat(chatInstance)
      hydrateStore({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        selectedModel: null,
        triggerData: null,
      })
      return {
        chatInstance,
        ...render(
          <>
            <ChatMessages useChat={useChat} />
            <SummarySelection />
          </>,
          { wrapper: createTestWrapper() },
        ),
      }
    }

    it.each(['user', 'assistant'] as const)(
      'restores completed rows at their %s boundary and opens each saved summary',
      (role) => {
        const { container } = renderHistory([
          savedMessage('earlier-boundary', 'Earlier summary', role),
          createTestMessage({ id: 'later-turn', parts: [{ type: 'text', text: 'A later turn' }] }),
          savedMessage('latest-boundary', 'Latest summary'),
        ])
        const rows = screen.getAllByRole('button', { name: 'Compacted View summary' })
        expect(rows).toHaveLength(2)
        expect(container.querySelector('[data-message-id="earlier-boundary"]')?.nextElementSibling).toBe(rows[0])
        expect(rows[0].nextElementSibling).toHaveAttribute('data-message-id', 'later-turn')
        expect(container.querySelector('[data-message-id="latest-boundary"]')?.nextElementSibling).toBe(rows[1])

        fireEvent.click(rows[1])
        expect(screen.getByTestId('summary-selection')).toHaveTextContent('Latest summary')
        fireEvent.click(rows[0])
        expect(screen.getByTestId('summary-selection')).toHaveTextContent('Earlier summary')
      },
    )

    it.each(['ready', 'submitted', 'streaming'] as const)(
      'shows one progress row during %s and removes it on cancellation',
      (status) => {
        renderHistory(
          [
            createTestMessage(),
            ...(status === 'streaming'
              ? [createTestMessage({ id: 'stub', role: 'assistant', parts: [{ type: 'step-start' }] })]
              : []),
          ],
          status,
        )
        act(() => useChatStore.getState().updateSession('thread-1', { compactionStatus: 'compacting' }))
        expect(screen.getAllByText('Compacting…')).toHaveLength(1)
        expect(screen.queryByTestId('loading-status')).toBeNull()
        expect(screen.queryByText('Compacted')).toBeNull()

        act(() => useChatStore.getState().updateSession('thread-1', { compactionStatus: 'idle' }))
        expect(screen.queryByText('Compacting…')).toBeNull()
        expect(screen.queryByText('Compacted')).toBeNull()
      },
    )

    it('does not create a completed history row before a checkpoint is saved', () => {
      renderHistory([createTestMessage()])
      act(() => useChatStore.getState().updateSession('thread-1', { compactionStatus: 'compacted' }))
      expect(screen.queryByText('Compacted')).toBeNull()
    })

    it('removes a completed row when regeneration removes its checkpoint', () => {
      const { chatInstance, rerender } = renderHistory([savedMessage('boundary', 'Saved summary')])
      expect(screen.getByRole('button', { name: 'Compacted View summary' })).toBeInTheDocument()
      chatInstance.messages = [createTestMessage({ id: 'replacement', role: 'assistant' })]
      rerender(<ChatMessages useChat={createMockUseChat(chatInstance)} />)
      expect(screen.queryByText('Compacted')).toBeNull()
    })
  })

  const renderWithSharingEnabled = async (messages: ThunderboltUIMessage[]) => {
    const mockChatInstance = createMockChatInstance(messages, 'ready')
    const mockUseChat = createMockUseChat(mockChatInstance)
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: createMockChatThread(),
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })
    useConfigStore.setState({ config: { debugTranscriptsEnabled: true } })

    const TestProvider = createTestProvider({
      authClient: createMockAuthClient({
        session: { user: { id: 'user-1', email: 'user@example.com' } },
      }),
    })
    render(
      <TestProvider>
        <ContentViewProvider>
          <ExternalLinkDialogProvider>
            <ChatMessages useChat={mockUseChat} />
          </ExternalLinkDialogProvider>
        </ContentViewProvider>
      </TestProvider>,
    )
    await act(async () => {
      await Bun.sleep(20)
    })
    return screen.getByRole('button', { name: 'Share debug transcript' })
  }

  const expectShareInUserActionRow = (shareButton: HTMLElement, messageId: string) => {
    expect(shareButton.closest('[data-message-id]')).toHaveAttribute('data-message-id', messageId)
    expect(shareButton.previousElementSibling).toHaveAccessibleName('Copy message')
    expect(shareButton.parentElement).toHaveClass(
      'ml-auto',
      'w-fit',
      'opacity-0',
      'group-hover/user-message:opacity-100',
    )
  }

  it('places sharing in the right-aligned action row when the last visible message is from the user', async () => {
    const shareButton = await renderWithSharingEnabled([
      createTestMessage({ id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] }),
      createTestMessage({ id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Follow-up' }] }),
    ])
    expectShareInUserActionRow(shareButton, 'user-2')
  })

  it('skips a failed turn’s content-less assistant stub and hosts sharing on the user message', async () => {
    // A failed request leaves an assistant message with only a `step-start` part — nothing
    // renders for it, so the share button must sit beside the copy button of the user bubble.
    const shareButton = await renderWithSharingEnabled([
      createTestMessage({ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      createTestMessage({ id: 'assistant-stub', role: 'assistant', parts: [{ type: 'step-start' }] }),
    ])
    expectShareInUserActionRow(shareButton, 'user-1')
  })

  describe('message filtering', () => {
    it('should skip OAuth retry messages and render other messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'OAuth retry message' }],
          metadata: { oauthRetry: true },
        }),
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Regular message' }],
        }),
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createTestWrapper(),
      })

      // OAuth retry message should be skipped
      expect(container.textContent).not.toContain('OAuth retry message')
      // Other messages should still be visible
      expect(container.textContent).toContain('Regular message')
      expect(container.textContent).toContain('Response')
    })
  })

  describe('error handling', () => {
    it('should show retrying banner while retries are in progress', () => {
      const mockChatInstance = createMockChatInstance([])
      const chatError = new Error('Network error')
      const mockUseChat = createMockUseChat(mockChatInstance, chatError)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // Simulate an active retry in progress
      useChatStore.getState().updateSession('thread-1', { retryCount: 1 })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Retrying (1/3)…')).toBeInTheDocument()
      expect(screen.queryByText('Retry')).not.toBeInTheDocument()
    })

    it('should show retry button when error occurs before any retry is scheduled', () => {
      const mockChatInstance = createMockChatInstance([])
      const chatError = new Error('Network error')
      const mockUseChat = createMockUseChat(mockChatInstance, chatError)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      // retryCount defaults to 0 — no active retry (e.g. stale error after page refresh)
      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    it('should show error message with retry button when retries are exhausted', () => {
      const mockChatInstance = createMockChatInstance([])
      const chatError = new Error('Network error')
      const mockUseChat = createMockUseChat(mockChatInstance, chatError)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      useChatStore.getState().updateSession('thread-1', { retriesExhausted: true })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    it('should show error message when last message is assistant with no parts and not streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [], // Empty parts
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      useChatStore.getState().updateSession('thread-1', { retriesExhausted: true })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })

    it('shows the loading indicator instead of an error while an empty turn awaits auto-retry', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Prompt' }] }),
        createTestMessage({ id: 'msg-2', role: 'assistant', parts: [] }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument()
      expect(screen.queryByText('Retry')).not.toBeInTheDocument()
      expect(screen.getByTestId('loading-status')).toBeInTheDocument()
    })

    it('should not show error message when last message is assistant with no parts but streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [], // Empty parts but streaming
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      // ErrorMessage should not be rendered when streaming
      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument()
    })

    it('should not show error message when last message has parts', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Valid response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'ready')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      // ErrorMessage should not be rendered when message has parts
      expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument()
    })
  })

  describe('streaming state', () => {
    const setupMultiTurnThread = (status: 'ready' | 'streaming') => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'First question' }] }),
        createTestMessage({
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'First response' }],
        }),
        createTestMessage({ id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Second question' }] }),
        createTestMessage({
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, status)
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      return render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })
    }

    it('reserves viewport space for the active streaming response', () => {
      const { container } = setupMultiTurnThread('streaming')

      const lastAssistantMessage = container.querySelector<HTMLElement>('[data-message-id="assistant-2"]')
      expect(lastAssistantMessage?.style.minHeight).toBe('72dvh')
    })

    it('returns settled responses to their natural height', () => {
      const { container } = setupMultiTurnThread('ready')

      const lastAssistantMessage = container.querySelector<HTMLElement>('[data-message-id="assistant-2"]')
      expect(lastAssistantMessage?.style.minHeight).toBe('')
    })

    it('should pass isStreaming to last assistant message when streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Streaming response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      // Message should be rendered (isStreaming prop is passed to AssistantMessage)
      expect(screen.getByText('Streaming response')).toBeInTheDocument()
    })

    it('should not pass isStreaming to non-last assistant messages', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'First response' }],
        }),
        createTestMessage({
          id: 'msg-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second response' }],
        }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'streaming')
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })

      // Both messages should be rendered
      expect(screen.getByText('First response')).toBeInTheDocument()
      expect(screen.getByText('Second response')).toBeInTheDocument()
    })
  })

  describe('dependency injection', () => {
    it('should work with dependency injection for useChat', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      ]
      const mockChatInstance = createMockChatInstance(messages)
      const mockUseChat = createMockUseChat(mockChatInstance)

      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages useChat={mockUseChat} />, {
        wrapper: createTestWrapper(),
      })

      // Component should render without errors
      expect(container).toBeInTheDocument()
      expect(screen.getByText('Hello')).toBeInTheDocument()
    })
  })

  describe('submitted loading indicator', () => {
    const setup = (status: 'submitted' | 'ready' | 'streaming', messages: ThunderboltUIMessage[]) => {
      const mockChatInstance = createMockChatInstance(messages, status)
      const mockUseChat = createMockUseChat(mockChatInstance)
      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })
      return render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })
    }

    it('renders the synthetic loading indicator when status is submitted and last message is user', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      ]
      const { container } = setup('submitted', messages)

      const spinner = container.querySelector('.animate-spin')
      expect(spinner).not.toBeNull()
    })

    it('does not render the indicator when status is ready', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      ]
      const { container } = setup('ready', messages)
      expect(container.querySelector('.animate-spin')).toBeNull()
    })

    it('does not render the indicator when an assistant message already exists', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }),
        createTestMessage({ id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] }),
      ]
      const { container } = setup('submitted', messages)
      expect(container.querySelector('.animate-spin')).toBeNull()
    })
  })
})
