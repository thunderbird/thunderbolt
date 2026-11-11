/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Chat } from '@ai-sdk/react'
import * as quoteUtils from '@/lib/quotes'
import * as attachmentStorage from '@/lib/file-blob-storage'
import { buildAttachmentPart, getAttachments } from '@/lib/attachments'
import { getClock } from '@/testing-library'
import { useChatStore } from '@/chats/chat-store'
import { useConfigStore } from '@/api/config-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMessageMetadata } from '@/ai/message-metadata'
import { ChatMessages } from './chat-messages'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { builtInAgent } from '@/defaults/agents'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
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
    it('does not rerender the unchanged user bubble for assistant deltas', async () => {
      const userMessage = createTestMessage({ id: 'user-1' })
      const chatInstance = new Chat<ThunderboltUIMessage>({ messages: [userMessage] })
      hydrateStore({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        selectedModel: null,
        triggerData: null,
      })
      // Quote extraction runs when the actual user bubble renders, including
      // its attachment and markdown children. Keep those children real here.
      const extractQuotes = spyOn(quoteUtils, 'getQuotes')
      try {
        render(<ChatMessages />, { wrapper: createTestWrapper() })
        const initialCalls = extractQuotes.mock.calls.length
        for (let token = 1; token <= 20; token++) {
          await act(async () => {
            chatInstance.messages = [
              userMessage,
              createTestMessage({
                id: 'answer-1',
                role: 'assistant',
                parts: [{ type: 'text', text: 'x'.repeat(token) }],
              }),
            ]
            await getClock().tickAsync(50)
          })
        }
        expect(extractQuotes.mock.calls.length - initialCalls).toBe(0)
        expect(screen.getByText('x'.repeat(20))).toBeInTheDocument()
      } finally {
        extractQuotes.mockRestore()
      }
    })

    it('resends only the selected attachment from the latest user turn after a new turn arrives', async () => {
      const attachment = buildAttachmentPart({
        localFileId: 'shared-pdf',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        deliverAs: 'text',
      })
      const first = createTestMessage({ id: 'user-1', parts: [attachment] })
      const latest = createTestMessage({
        id: 'user-2',
        parts: [attachment, { ...attachment, data: { ...attachment.data, localFileId: 'other-pdf' } }],
      })
      const chatInstance = new Chat<ThunderboltUIMessage>({ messages: [first] })
      const regenerate = spyOn(chatInstance, 'regenerate').mockResolvedValue(undefined)
      const readAttachment = spyOn(attachmentStorage, 'getAttachment').mockResolvedValue(null)
      hydrateStore({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        selectedModel: null,
        triggerData: null,
      })
      try {
        render(<ChatMessages />, { wrapper: createTestWrapper() })
        expect(screen.getAllByRole('button', { name: 'Resend as images' })).toHaveLength(1)
        await act(async () => {
          chatInstance.messages = [first, latest]
          await getClock().tickAsync(50)
        })
        const controls = screen.getAllByRole('button', { name: 'Resend as images' })
        expect(controls).toHaveLength(2)
        fireEvent.click(controls[0])
        expect(chatInstance.messages[0]).toBe(first)
        expect(
          getAttachments(chatInstance.messages[1]).map(({ localFileId, deliverAs }) => [localFileId, deliverAs]),
        ).toEqual([
          ['shared-pdf', 'images'],
          ['other-pdf', 'text'],
        ])
        expect(regenerate).toHaveBeenCalledTimes(1)
      } finally {
        cleanup()
        regenerate.mockRestore()
        readAttachment.mockRestore()
      }
    })

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

  it.each([false, true])(
    'inherits private-source protection across later replies without merging citation indices (hidden source turn: %s)',
    async (hidden) => {
      const privateSource = {
        index: 1,
        url: 'https://private.example/source',
        title: 'Private source',
        toolName: 'search' as const,
        allowRemoteImages: false,
      }
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          id: 'before',
          role: 'assistant',
          parts: [{ type: 'text', text: '![Before](https://images.example/before.png)' }],
        }),
        createTestMessage({
          id: 'private',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Private evidence' }],
          metadata: { sources: [privateSource], ...(hidden ? { oauthRetry: true } : {}) },
        }),
        createTestMessage({ id: 'follow-up', role: 'user', parts: [{ type: 'text', text: 'Tell me more' }] }),
        createTestMessage({
          id: 'follow-up-reply',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: '![Follow-up image](https://images.example/private.png)\n\n<widget:link-preview url="https://private.example/source" />',
            },
          ],
        }),
        createTestMessage({
          id: 'new-provider',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'New evidence [1]\n\n<widget:link-preview source="1" url="https://public.example/new" />',
            },
          ],
          metadata: {
            sources: [
              {
                index: 1,
                url: 'https://public.example/new',
                title: 'New source',
                siteName: 'Public site',
                toolName: 'search',
                image: 'https://public.example/preview.png',
              },
            ],
          },
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
      const { container, getByRole } = render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })
      await act(async () => {
        await Bun.sleep(20)
      })
      expect(Array.from(container.querySelectorAll('img')).map((image) => image.getAttribute('src'))).toEqual([
        'https://images.example/before.png',
      ])
      expect(container.textContent).toContain('Follow-up image')
      expect(container.textContent).toContain('private.example')
      expect(container.textContent).toContain('New source')
      // The new turn's [1] still refers to its own source, and a portal inherits the policy.
      fireEvent.click(getByRole('button', { name: 'View source: Public site' }))
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New source')
      expect(document.querySelector('[role="dialog"] img')).toBeNull()
      expect(messages[4].metadata?.sources).toHaveLength(1)
      expect(messages[4].metadata?.sources?.[0].allowRemoteImages).toBeUndefined()
    },
  )

  it('applies a streamed private source marker before rendering the following answer', () => {
    const message = createTestMessage({ id: 'stream', role: 'assistant', parts: [{ type: 'text', text: 'Searching' }] })
    const chatInstance = createMockChatInstance([message], 'streaming')
    hydrateStore({
      chatInstance,
      chatThread: createMockChatThread(),
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })
    const view = render(<ChatMessages useChat={createMockUseChat(chatInstance)} />, { wrapper: createTestWrapper() })
    const metadata = createMessageMetadata('model', [
      {
        index: 1,
        url: 'https://private.example/source',
        title: 'Private source',
        toolName: 'search',
        allowRemoteImages: false,
      },
    ])
    const withEvidence = { ...message, metadata: metadata({ part: { type: 'tool-result', toolCallId: 'search' } }) }
    view.rerender(<ChatMessages useChat={createMockUseChat(createMockChatInstance([withEvidence], 'streaming'))} />)
    const answer: ThunderboltUIMessage = {
      ...withEvidence,
      parts: [...message.parts, { type: 'text', text: '![Streamed image](https://private.example/image.png)' }],
    }
    view.rerender(<ChatMessages useChat={createMockUseChat(createMockChatInstance([answer], 'streaming'))} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).toContain('Streamed image')
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
    // Lazy module resolution uses real I/O; advance React until the action appears.
    for (let attempt = 0; attempt < 100; attempt++) {
      await act(async () => {
        await Bun.sleep(5)
      })
      const action = screen.queryByRole('button', { name: 'Share debug transcript' })
      if (action) {
        return action
      }
    }
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

    describe('a model that rejects tools', () => {
      const toolsError = new Error(
        '400: {"error":{"message":"registry.ollama.ai/library/gemma3:4b does not support tools"}}',
      )
      const hostedAgent: Agent = {
        ...builtInAgent,
        id: 'hosted-agent',
        type: 'managed-http',
        transport: 'http',
        url: '/v1/agent/chat',
      }

      const failedModel = createMockModel({ id: 'gemma-model' })

      /** Renders a turn that the failed model rejected, with the given agent and model selected now. */
      const renderToolsRejection = (selectedAgent: Agent, selectedModel = failedModel) => {
        const mockChatInstance = createMockChatInstance([createTestMessage({ metadata: { modelId: failedModel.id } })])
        hydrateStore({
          chatInstance: mockChatInstance,
          chatThread: createMockChatThread(),
          id: 'thread-1',
          mcpClients: [],
          models: [],
          selectedModel,
          triggerData: null,
        })
        useChatStore.getState().updateSession('thread-1', { retriesExhausted: true, selectedAgent })
        render(<ChatMessages useChat={createMockUseChat(mockChatInstance, toolsError)} />, {
          wrapper: createTestWrapper(),
        })
      }

      it('offers to turn tools off for the built-in agent', () => {
        renderToolsRejection(builtInAgent)

        expect(screen.getByText('Turn off tools and retry')).toBeInTheDocument()
        expect(screen.queryByText('Retry')).not.toBeInTheDocument()
      })

      it('offers Retry instead once the user has picked another model', () => {
        renderToolsRejection(builtInAgent, createMockModel({ id: 'llama-model' }))

        expect(screen.queryByText('Turn off tools and retry')).not.toBeInTheDocument()
        expect(screen.getByText('Retry')).toBeInTheDocument()
      })

      it('offers no fix for an external agent, whose model Settings → Models does not reach', () => {
        renderToolsRejection(hostedAgent)

        expect(screen.queryByText('Turn off tools and retry')).not.toBeInTheDocument()
        expect(screen.getByText('Retry')).toBeInTheDocument()
      })
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
