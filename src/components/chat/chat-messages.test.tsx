/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockMode,
  createMockUseChat,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { ContentViewProvider } from '@/content-view/context'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from '@/chats/chat-store'
import { ChatMessages } from './chat-messages'
import { ExternalLinkDialogProvider } from './markdown-utils'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { builtInAgent } from '@/defaults/agents'
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

      expect(screen.getByText('Something went wrong. Retrying (1/3)...')).toBeInTheDocument()
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

  describe('mode-aware loading label', () => {
    const setupWithMode = (modeName: string, agent?: Agent) => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
      ]
      const mockChatInstance = createMockChatInstance(messages, 'submitted')
      const mockUseChat = createMockUseChat(mockChatInstance)
      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        models: [],
        selectedMode: createMockMode({ name: modeName }),
        selectedModel: null,
        triggerData: null,
      })
      // `hydrateStore` always assigns the built-in agent; patch the session for
      // tests that need a non-built-in (ACP) agent.
      if (agent) {
        useChatStore.setState((state) => {
          const session = state.sessions.get('thread-1')
          if (!session) {
            return state
          }
          const nextSessions = new Map(state.sessions)
          nextSessions.set('thread-1', { ...session, selectedAgent: agent })
          return { sessions: nextSessions }
        })
      }
      return render(<ChatMessages useChat={mockUseChat} />, { wrapper: createTestWrapper() })
    }

    it('shows a specific label in search mode', () => {
      setupWithMode('search')
      expect(screen.getByTestId('loading-status')).toHaveTextContent('Searching the web…')
    })

    it('shows a specific label in research mode', () => {
      setupWithMode('research')
      expect(screen.getByTestId('loading-status')).toHaveTextContent('Researching…')
    })

    it('keeps a plain spinner (no specific label) in chat mode', () => {
      const { container } = setupWithMode('chat')
      // The plain spinner still renders, but with no specific status text.
      expect(container.querySelector('.animate-spin')).not.toBeNull()
      expect(screen.getByTestId('loading-status').textContent?.trim()).toBe('')
    })

    it('keeps a plain spinner for ACP agents even when a search mode is stale-selected', () => {
      const acpAgent: Agent = { ...builtInAgent, id: 'acp-1', name: 'Some ACP', type: 'remote-acp' }
      setupWithMode('search', acpAgent)
      // ACP agents own their mode upstream — never leak a false "Searching…" label.
      expect(screen.getByTestId('loading-status').textContent?.trim()).toBe('')
    })
  })
})
