import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createMockAutomationRun, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { ContentViewProvider } from '@/content-view/context'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from '@/chats/chat-store'
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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages />, {
        wrapper: createTestWrapper(),
      })

      // Messages should be rendered - check if text content is present
      expect(container.textContent).toContain('Hello')
      expect(container.textContent).toContain('Hi there')
    })
  })

  describe('encryption message', () => {
    it('should show encryption message when thread is encrypted', () => {
      hydrateStore({
        chatThread: createMockChatThread({ isEncrypted: 1 }),
        id: 'thread-1',
        messages: [],
        status: 'ready',
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages />, {
        wrapper: createTestWrapper(),
      })

      // EncryptionMessage should be rendered with the confidential text
      expect(container.textContent).toContain('This conversation is confidential')
    })
  })

  describe('trigger message', () => {
    it('should show trigger message when automation was triggered', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Automation prompt' }],
        }),
      ]

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: createMockAutomationRun({
          wasTriggeredByAutomation: true,
          prompt: {
            id: 'prompt-1',
            title: 'Test Automation',
            prompt: 'Automation prompt',
            deletedAt: null,
            defaultHash: null,
            userId: null,
            modelId: 'model-1',
          },
        }),
      })

      const { container } = render(<ChatMessages />, {
        wrapper: createTestWrapper(),
      })

      // TriggerMessage should be rendered with "Triggered by automation" text
      expect(container.textContent).toContain('Triggered by automation')
    })

    it('should skip first user message when automation was triggered', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'user',
          parts: [{ type: 'text', text: 'Automation prompt' }],
        }),
        createTestMessage({
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
        }),
      ]

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: createMockAutomationRun({
          wasTriggeredByAutomation: true,
        }),
      })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

      // First user message should be skipped, only assistant message should be visible
      expect(screen.queryByText('Automation prompt')).not.toBeInTheDocument()
      expect(screen.getByText('Response')).toBeInTheDocument()
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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: null,
      })

      const { container } = render(<ChatMessages />, {
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
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages: [],
        status: 'error',
        error: new Error('Something went wrong'),
        selectedModel: null,
        triggerData: null,
      })

      // Simulate an active retry in progress
      useChatStore.getState().updateSession('thread-1', { retryCount: 1 })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Retrying (1/3)...')).toBeInTheDocument()
      expect(screen.queryByText('Retry')).not.toBeInTheDocument()
    })

    it('should show retry button when error occurs before any retry is scheduled', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages: [],
        status: 'error',
        error: new Error('Something went wrong'),
        selectedModel: null,
        triggerData: null,
      })

      // retryCount defaults to 0 — no active retry (e.g. stale error after page refresh)
      render(<ChatMessages />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
      expect(screen.getByText('Retry')).toBeInTheDocument()
    })

    it('should show error message with retry button when retries are exhausted', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages: [],
        status: 'error',
        error: new Error('Something went wrong'),
        selectedModel: null,
        triggerData: null,
      })

      useChatStore.getState().updateSession('thread-1', { retriesExhausted: true })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: null,
      })

      useChatStore.getState().updateSession('thread-1', { retriesExhausted: true })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })

    it('should not show error message when last message is assistant with no parts but streaming', () => {
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({
          role: 'assistant',
          parts: [], // Empty parts but streaming
        }),
      ]

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'streaming',
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'ready',
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'streaming',
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

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

      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        messages,
        status: 'streaming',
        selectedModel: null,
        triggerData: null,
      })

      render(<ChatMessages />, { wrapper: createTestWrapper() })

      // Both messages should be rendered
      expect(screen.getByText('First response')).toBeInTheDocument()
      expect(screen.getByText('Second response')).toBeInTheDocument()
    })
  })
})
