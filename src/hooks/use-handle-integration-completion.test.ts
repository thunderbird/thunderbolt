import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { hydrateStore, resetStore, createMockModel } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useHandleIntegrationCompletion } from './use-handle-integration-completion'
import { oauthRetryEvent, getOAuthWidgetKey } from '@/widgets/connect-integration/constants'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { v7 as uuidv7 } from 'uuid'
import { saveMessagesWithContextUpdate, getMessage } from '@/dal/chat-messages'
import { updateSettings } from '@/dal/settings'
import { useChatStore } from '@/chats/chat-store'
import type { ThunderboltUIMessage } from '@/types'
import { getClock } from '@/testing-library'

const mockSendAcpPrompt = mock(() => Promise.resolve())

const mockAddEventListener = mock()
const mockRemoveEventListener = mock()

beforeAll(async () => {
  await setupTestDatabase()

  if (typeof global.window === 'undefined') {
    Object.defineProperty(global, 'window', {
      value: {
        addEventListener: mockAddEventListener,
        removeEventListener: mockRemoveEventListener,
      },
      writable: true,
      configurable: true,
    })
  } else {
    global.window.addEventListener = mockAddEventListener
    global.window.removeEventListener = mockRemoveEventListener
  }

  if (typeof global.sessionStorage === 'undefined') {
    const store = new Map<string, string>()
    Object.defineProperty(global, 'sessionStorage', {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
      },
      writable: true,
      configurable: true,
    })
  }
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('useHandleIntegrationCompletion', () => {
  beforeEach(() => {
    // Reset the real store state before each test
    resetStore()

    if (global.sessionStorage) {
      global.sessionStorage.clear()
    }
    mockAddEventListener.mockClear()
    mockRemoveEventListener.mockClear()
    mockSendAcpPrompt.mockClear()
  })

  afterEach(async () => {
    // Reset the real store state after each test
    resetStore()

    await resetTestDatabase()
    if (global.sessionStorage) {
      global.sessionStorage.clear()
    }
  })

  /**
   * Creates a mock saveMessages function for testing
   */
  const createMockSaveMessages = () => mock(() => Promise.resolve())

  /**
   * Creates a test thread in the database
   */
  const createTestThread = async () => {
    const threadId = uuidv7()
    const db = getDb()

    await db.insert(chatThreadsTable).values({
      id: threadId,
      title: 'Test Thread',
      isEncrypted: 0,
    })

    return threadId
  }

  /**
   * Saves test messages to a thread in the database
   */
  const createTestMessages = async (threadId: string, messages: ThunderboltUIMessage[]) => {
    await saveMessagesWithContextUpdate(getDb(), threadId, messages)
    return messages
  }

  it('should set up event listener on mount', async () => {
    const mockSaveMessages = createMockSaveMessages()

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: '',
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper(),
      },
    )

    expect(mockAddEventListener).toHaveBeenCalledWith(oauthRetryEvent, expect.any(Function))
  })

  it('should remove event listener on unmount', async () => {
    const mockSaveMessages = createMockSaveMessages()

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: '',
      integrations_microsoft_credentials: '',
    })

    const { unmount } = renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper(),
      },
    )

    unmount()

    expect(mockRemoveEventListener).toHaveBeenCalledWith(oauthRetryEvent, expect.any(Function))
  })

  it('should not process retry if widgetMessageId is missing', async () => {
    const mockSaveMessages = createMockSaveMessages()

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: '',
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper(),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId: '' } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().tickAsync(100)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should not process retry if chatThreadId is missing', async () => {
    const mockSaveMessages = createMockSaveMessages()

    // Use the real store and hydrate it with test data (id is null - no session created)
    resetStore()

    await updateSettings(getDb(), {
      integrations_google_credentials: '',
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper(),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId: 'widget-1' } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().tickAsync(100)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should process retry and store widget hidden state in cache for google provider', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()
    const userMessageId = uuidv7()

    const userMessage: ThunderboltUIMessage = {
      id: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: 'Send me an email' }],
    }

    const widgetMessage: ThunderboltUIMessage = {
      id: widgetMessageId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Please connect <widget:connect-integration>' }],
    }

    await createTestMessages(threadId, [userMessage, widgetMessage])

    const mockSaveMessages = createMockSaveMessages()

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: threadId,
      messages: [userMessage, widgetMessage],
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(mockSaveMessages).toHaveBeenCalled()

    const saveCall = (mockSaveMessages.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { messages: ThunderboltUIMessage[] }
      | undefined
    const savedMessage = saveCall?.messages?.[0]
    expect(savedMessage).toBeDefined()
    expect(savedMessage?.role).toBe('user')
    expect(savedMessage?.metadata?.oauthRetry).toBe(true)
    expect(savedMessage?.parts[0]?.type === 'text' && savedMessage.parts[0].text).toContain('Send me an email')

    const updatedWidgetMessage = await getMessage(getDb(), widgetMessageId)
    expect(updatedWidgetMessage).toBeDefined()
    expect(updatedWidgetMessage?.cache).toBeDefined()
    const cacheEntry = updatedWidgetMessage?.cache?.['connectIntegrationWidget']
    expect(cacheEntry).toEqual({ isHidden: true })

    expect(mockSendAcpPrompt).toHaveBeenCalled()
    const sendCall = (mockSendAcpPrompt.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { metadata?: { oauthRetry?: boolean } }
      | undefined
    const sendMessageCall = sendCall || {}
    expect(sendMessageCall?.metadata?.oauthRetry).toBe(true)
  })

  it('should not process duplicate retries for the same widget', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()
    const userMessageId = uuidv7()

    const userMessage: ThunderboltUIMessage = {
      id: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: 'Send email' }],
    }

    const widgetMessage: ThunderboltUIMessage = {
      id: widgetMessageId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Please connect <widget:connect-integration>' }],
    }

    await createTestMessages(threadId, [userMessage, widgetMessage])

    const mockSaveMessages = createMockSaveMessages()

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: threadId,
      messages: [userMessage, widgetMessage],
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(mockSaveMessages).toHaveBeenCalled()

    mockSaveMessages.mockClear()

    eventHandler(event as Event)

    await act(async () => {
      await getClock().tickAsync(500)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should wait for provider connection before processing', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()
    const userMessageId = uuidv7()

    const userMessage: ThunderboltUIMessage = {
      id: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: 'Send email' }],
    }

    const widgetMessage: ThunderboltUIMessage = {
      id: widgetMessageId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Please connect <widget:connect-integration>' }],
    }

    await createTestMessages(threadId, [userMessage, widgetMessage])

    const mockSaveMessages = createMockSaveMessages()

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatThread: null,
      id: threadId,
      messages: [userMessage, widgetMessage],
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    // Start with no credentials
    await updateSettings(getDb(), {
      integrations_google_credentials: '',
      integrations_microsoft_credentials: '',
    })

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
    eventHandler(event)

    await act(async () => {
      await getClock().tickAsync(200)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()

    // Now add credentials to simulate connection
    await updateSettings(getDb(), { integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }) })

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(mockSaveMessages).toHaveBeenCalled()
  })

  it('should handle missing widget message in chat', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()

    const mockSaveMessages = createMockSaveMessages()

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data (no messages)
    hydrateStore({
      chatThread: null,
      id: threadId,
      messages: [],
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
      integrations_microsoft_credentials: '',
    })

    const originalWarn = console.warn
    const consoleWarnSpy = mock(() => {})
    console.warn = consoleWarnSpy

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith('Widget message not found:', widgetMessageId)
    expect(mockSaveMessages).not.toHaveBeenCalled()

    console.warn = originalWarn
  })

  it('should handle missing original user text', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()

    const widgetMessage: ThunderboltUIMessage = {
      id: widgetMessageId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Please connect <widget:connect-integration>' }],
    }

    await createTestMessages(threadId, [widgetMessage])

    const mockSaveMessages = createMockSaveMessages()

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data (only widget message, no user message before it)
    hydrateStore({
      chatThread: null,
      id: threadId,
      messages: [widgetMessage],
      mcpClients: [],
      selectedModel: createMockModel(),
      triggerData: null,
    })

    await updateSettings(getDb(), {
      integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
      integrations_microsoft_credentials: '',
    })

    const originalWarn = console.warn
    const consoleWarnSpy = mock(() => {})
    console.warn = consoleWarnSpy

    renderHook(
      () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
      {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      },
    )

    const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
    if (!eventHandler) {
      throw new Error('Event handler not found')
    }

    const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
    eventHandler(event as Event)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith('Original user text not found for widget message:', widgetMessageId)
    expect(mockSaveMessages).not.toHaveBeenCalled()

    console.warn = originalWarn
  })

  it(
    'should wait for chat to be ready before sending message',
    async () => {
      const threadId = await createTestThread()
      const widgetMessageId = uuidv7()
      const userMessageId = uuidv7()

      const userMessage: ThunderboltUIMessage = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'Send email' }],
      }

      const widgetMessage: ThunderboltUIMessage = {
        id: widgetMessageId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Please connect <widget:connect-integration>' }],
      }

      await createTestMessages(threadId, [userMessage, widgetMessage])

      const mockSaveMessages = createMockSaveMessages()

      sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

      // Use the real store and hydrate it with test data, starting with 'streaming' status
      hydrateStore({
        chatThread: null,
        id: threadId,
        messages: [userMessage, widgetMessage],
        status: 'streaming',
        mcpClients: [],
        selectedModel: createMockModel(),
        triggerData: null,
      })

      await updateSettings(getDb(), {
        integrations_google_credentials: JSON.stringify({ access_token: 'test_token' }),
        integrations_microsoft_credentials: '',
      })

      renderHook(
        () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, sendPrompt: mockSendAcpPrompt }),
        {
          wrapper: createQueryTestWrapper({
            defaultOptions: {
              queries: {
                retry: false,
                gcTime: 0,
                staleTime: 0,
              },
            },
          }),
        },
      )

      const eventHandler = mockAddEventListener.mock.calls[0]?.[1] as ((event: Event) => void) | undefined
      if (!eventHandler) {
        throw new Error('Event handler not found')
      }

      const event = new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } })
      eventHandler(event as Event)

      // Advance timers step by step to allow the hook to process through its polling stages
      await act(async () => {
        // Let the integration status polling complete
        await getClock().tickAsync(1000)
      })

      await act(async () => {
        // Let the message-in-chat polling complete
        await getClock().tickAsync(1000)
      })

      expect(mockSaveMessages).toHaveBeenCalled()
      expect(mockSendAcpPrompt).not.toHaveBeenCalled()

      // Change session status to ready before waitForSessionReady times out
      useChatStore.getState().setSessionStatus(threadId, 'ready')

      // Advance timers to allow waitForSessionReady to poll and detect the status change
      await act(async () => {
        await getClock().tickAsync(200)
      })

      expect(mockSendAcpPrompt).toHaveBeenCalled()
    },
    // CI VMs have slower async processing overhead
    { timeout: 5000 },
  )
})
