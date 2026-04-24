import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  createMockChatThread,
  createMockLocalAgent,
  createMockModel,
  createMockRemoteAgent,
  defaultTestAgent,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { Model } from '@/types'
import type { SessionConfigOption, SessionMode } from '@agentclientprotocol/sdk'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement, type ReactNode, type RefObject } from 'react'
import { BrowserRouter } from 'react-router'
import { ChatPromptInput, type ChatPromptInputRef } from './chat-prompt-input'

const createMockUseContextTracking =
  (
    isOverflowing: boolean = false,
    isContextKnown: boolean = true,
    usedTokens: number | null = 1000,
    maxTokens: number | null = 2000,
  ) =>
  (_options?: { model?: Model | null; chatThreadId?: string; currentInput?: string; onOverflow?: () => void }) => ({
    usedTokens,
    maxTokens,
    isContextKnown,
    isOverflowing,
    isLoading: false,
    estimateTokensForInput: (_input: string) => 0,
  })

const createMockUseIsMobile =
  (isMobile: boolean = false) =>
  () => ({
    isMobile,
  })

const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryWrapper = createQueryTestWrapper()
  return createElement(BrowserRouter, null, createElement(queryWrapper, null, children))
}

/** Hydrate the chat store with sensible defaults for testing */
const setupStore = () => {
  const mockModel = createMockModel()

  hydrateStore({
    chatThread: createMockChatThread(),
    id: 'thread-1',
    mcpClients: [],
    selectedModel: mockModel,
    triggerData: null,
  })

  return { mockModel }
}

describe('ChatPromptInput', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    resetStore()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  describe('rendering', () => {
    it('should render textarea with placeholder', () => {
      setupStore()

      render(<ChatPromptInput useIsMobile={createMockUseIsMobile()} />, {
        wrapper: TestWrapper,
      })

      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })
  })

  describe('mobile layout', () => {
    it('should apply mobile class names', () => {
      setupStore()

      const { container } = render(<ChatPromptInput useIsMobile={createMockUseIsMobile(true)} />, {
        wrapper: TestWrapper,
      })

      const form = container.querySelector('form')
      expect(form?.className).toContain('gap-0')
      expect(form?.className).toContain('p-2')
    })

    it('should apply unified class names when not mobile', () => {
      setupStore()

      const { container } = render(<ChatPromptInput useIsMobile={createMockUseIsMobile(false)} />, {
        wrapper: TestWrapper,
      })

      const form = container.querySelector('form')
      expect(form?.className).toContain('gap-0')
      expect(form?.className).toContain('p-2')
    })

    it('should hide context usage indicator on mobile', () => {
      setupStore()

      render(
        <ChatPromptInput
          useIsMobile={createMockUseIsMobile(true)}
          useContextTracking={createMockUseContextTracking(false, true, 1000, 2000)}
        />,
        { wrapper: TestWrapper },
      )

      expect(screen.queryByText('50%')).toBeNull()
    })

    it('should show context usage indicator on desktop', () => {
      setupStore()

      render(
        <ChatPromptInput
          useIsMobile={createMockUseIsMobile(false)}
          useContextTracking={createMockUseContextTracking(false, true, 1000, 2000)}
        />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText('50%')).toBeInTheDocument()
    })
  })

  describe('ref methods', () => {
    it('should expose focus method that focuses textarea', () => {
      setupStore()
      const ref = { current: null } as unknown as RefObject<ChatPromptInputRef>

      render(<ChatPromptInput ref={ref} useIsMobile={createMockUseIsMobile()} />, {
        wrapper: TestWrapper,
      })

      const textarea = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
      const focusSpy = mock(() => {})
      const setSelectionRangeSpy = mock(() => {})
      textarea.focus = focusSpy
      textarea.setSelectionRange = setSelectionRangeSpy

      act(() => {
        ref.current?.focus()
      })

      expect(focusSpy).toHaveBeenCalled()
      expect(setSelectionRangeSpy).toHaveBeenCalled()
    })

    it('should expose setInput method that updates textarea value', () => {
      setupStore()
      const ref = { current: null } as unknown as RefObject<ChatPromptInputRef>

      render(<ChatPromptInput ref={ref} useIsMobile={createMockUseIsMobile()} />, {
        wrapper: TestWrapper,
      })

      act(() => {
        ref.current?.setInput('Test input')
      })

      const textarea = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
      expect(textarea.value).toBe('Test input')
    })
  })

  describe('submitOnEnter', () => {
    it('should disable submit on enter when mobile viewport', () => {
      setupStore()

      const { container } = render(<ChatPromptInput useIsMobile={createMockUseIsMobile(true)} />, {
        wrapper: TestWrapper,
      })

      const textarea = container.querySelector('textarea')!
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      const preventDefaultSpy = mock(() => {})
      Object.defineProperty(enterEvent, 'preventDefault', { value: preventDefaultSpy })

      textarea.dispatchEvent(enterEvent)

      // On mobile, Enter should NOT be prevented (it creates a newline naturally)
      expect(preventDefaultSpy).not.toHaveBeenCalled()
    })
  })

  describe('dependency injection', () => {
    it('should render with store-based state', () => {
      setupStore()

      const { container } = render(<ChatPromptInput useIsMobile={createMockUseIsMobile()} />, {
        wrapper: TestWrapper,
      })

      expect(container.querySelector('form')).not.toBeNull()
    })

    it('should accept injected useContextTracking', () => {
      setupStore()

      const { container } = render(
        <ChatPromptInput useContextTracking={createMockUseContextTracking()} useIsMobile={createMockUseIsMobile()} />,
        { wrapper: TestWrapper },
      )

      expect(container.querySelector('form')).not.toBeNull()
    })
  })

  describe('agent connection states', () => {
    it('shows connecting spinner in footer and textarea when non-built-in agent is connecting', () => {
      const localAgent = createMockLocalAgent()
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: localAgent,
        isAgentAvailable: true,
        status: 'connecting',
        availableModes: [],
      })

      const { container } = render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Connecting indicator should be visible inside the form
      expect(screen.getByText('Connecting to Claude Code...')).toBeInTheDocument()
      const form = container.querySelector('form')
      expect(form).not.toBeNull()
      expect(form!.textContent).toContain('Connecting to Claude Code...')

      // Textarea should still be visible and typeable
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })

    it('disables submit button when connecting', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'connecting',
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      const submitButton = screen.getByRole('button', { name: '' })
      expect(submitButton).toBeDisabled()
    })

    it('shows neither spinner nor mode selector when ready with no modes', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'ready',
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.queryByText(/Connecting to/)).toBeNull()
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })

    it('shows mode selector when fully connected with modes', () => {
      const modes: SessionMode[] = [
        { id: 'code', name: 'Code' },
        { id: 'ask', name: 'Ask' },
      ]
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'ready',
        availableModes: modes,
        currentModeId: 'code',
        selectedMode: {
          id: 'code',
          name: 'code',
          label: 'Code',
          icon: 'terminal',
          systemPrompt: null,
          isDefault: 0,
          order: 0,
        } as never,
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Mode selector should be visible
      expect(screen.getByText('Code')).toBeInTheDocument()
      // No connecting indicator
      expect(screen.queryByText(/Connecting to/)).toBeNull()
      // Textarea visible
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })

    it('shows model selector when connected with 2+ models', () => {
      const modes: SessionMode[] = [{ id: 'code', name: 'Code' }]
      const configOptions: SessionConfigOption[] = [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'model-a',
          options: [
            { value: 'model-a', name: 'Model A' },
            { value: 'model-b', name: 'Model B' },
          ],
        } as SessionConfigOption,
      ]
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'ready',
        availableModes: modes,
        currentModeId: 'code',
        configOptions,
        selectedMode: {
          id: 'code',
          name: 'code',
          label: 'Code',
          icon: 'terminal',
          systemPrompt: null,
          isDefault: 0,
          order: 0,
        } as never,
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Model selector should be visible (shows current model name)
      expect(screen.getByText('Model A')).toBeInTheDocument()
    })

    it('shows read-only unavailable message for unavailable agent', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: false,
        status: 'ready',
      })

      const { container } = render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText(/This chat uses Claude Code/)).toBeInTheDocument()
      expect(screen.getByText(/desktop only/)).toBeInTheDocument()
      // No textarea should be present
      expect(container.querySelector('textarea')).toBeNull()
    })

    it('shows unavailable message with "unavailable" for non-local agent types', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockRemoteAgent(),
        isAgentAvailable: false,
        status: 'ready',
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText(/This chat uses Remote Agent/)).toBeInTheDocument()
      expect(screen.getByText(/unavailable/)).toBeInTheDocument()
    })

    it('shows modes immediately for built-in agent', () => {
      const modes: SessionMode[] = [
        { id: 'chat', name: 'Chat' },
        { id: 'search', name: 'Search' },
      ]
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: defaultTestAgent,
        isAgentAvailable: true,
        status: 'ready',
        availableModes: modes,
        currentModeId: 'chat',
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText('Chat')).toBeInTheDocument()
      expect(screen.queryByText(/Connecting to/)).toBeNull()
    })

    it('transitions from connecting spinner to mode selector when connection completes', () => {
      const localAgent = createMockLocalAgent()
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: localAgent,
        isAgentAvailable: true,
        status: 'connecting',
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Initially shows connecting
      expect(screen.getByText('Connecting to Claude Code...')).toBeInTheDocument()

      // Simulate connection completing: update session with modes and ready status
      act(() => {
        useChatStore.getState().updateSession('thread-1', {
          status: 'ready',
          availableModes: [{ id: 'code', name: 'Code' }],
          currentModeId: 'code',
          selectedMode: {
            id: 'code',
            name: 'code',
            label: 'Code',
            icon: 'terminal',
            systemPrompt: null,
            isDefault: 0,
            order: 0,
          } as never,
        })
      })

      // Connecting indicator should be gone, mode selector should appear
      expect(screen.queryByText(/Connecting to/)).toBeNull()
      expect(screen.getByText('Code')).toBeInTheDocument()
    })

    it('shows connecting spinner for remote agent', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockRemoteAgent(),
        isAgentAvailable: true,
        status: 'connecting',
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText('Connecting to Remote Agent...')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })

    it('shows error message when connection fails', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'error',
        error: new Error('Agent did not respond within 15s'),
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      expect(screen.getByText('Failed to connect to Claude Code')).toBeInTheDocument()
      // Textarea should still be visible so user can retry
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
      // No connecting spinner
      expect(screen.queryByText(/Connecting to/)).toBeNull()
    })

    it('transitions from connecting to error on failure', () => {
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'connecting',
        availableModes: [],
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Initially shows connecting
      expect(screen.getByText('Connecting to Claude Code...')).toBeInTheDocument()

      // Simulate connection failure
      act(() => {
        useChatStore.getState().setSessionStatus('thread-1', 'error', new Error('Connection timeout'))
      })

      // Error message should replace connecting spinner
      expect(screen.getByText('Failed to connect to Claude Code')).toBeInTheDocument()
      expect(screen.queryByText(/Connecting to/)).toBeNull()
      expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument()
    })

    it('does not show error when modes are already loaded', () => {
      // If the agent was previously connected (has modes) but then errors on a reconnect,
      // keep showing the mode selector instead of the error message
      const modes: SessionMode[] = [{ id: 'code', name: 'Code' }]
      hydrateStore({
        chatThread: createMockChatThread(),
        id: 'thread-1',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
        agentConfig: createMockLocalAgent(),
        isAgentAvailable: true,
        status: 'error',
        error: new Error('Reconnect failed'),
        availableModes: modes,
        currentModeId: 'code',
        selectedMode: {
          id: 'code',
          name: 'code',
          label: 'Code',
          icon: 'terminal',
          systemPrompt: null,
          isDefault: 0,
          order: 0,
        } as never,
      })

      render(
        <ChatPromptInput useIsMobile={createMockUseIsMobile()} useContextTracking={createMockUseContextTracking()} />,
        { wrapper: TestWrapper },
      )

      // Mode selector should be shown, not the error
      expect(screen.getByText('Code')).toBeInTheDocument()
      expect(screen.queryByText(/Failed to connect/)).toBeNull()
    })
  })
})
