/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { seedTestTrustDomain } from '@/test-utils/powersync-reactivity-test'

import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase, wsId } from '@/dal/test-utils'

// Workspace id is injected via the `workspaceId` param now (DI pattern from THU-553);
// no `mock.module('@/lib/active-workspace')` shim — that pattern leaked across files
// and made every consumer of `useActiveWorkspaceId` in other test files see the stub.
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useHandleIntegrationCompletion } from './use-handle-integration-completion'
import { oauthRetryEvent, getOAuthWidgetKey } from '@/widgets/connect-integration/constants'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { v7 as uuidv7 } from 'uuid'
import { saveMessagesWithContextUpdate, getMessage } from '@/dal/chat-messages'
import { saveIntegrationCredentials } from '@/dal'
import type { ThunderboltUIMessage } from '@/types'
import { getClock } from '@/testing-library'

/**
 * Dispatches an oauthRetryEvent on the real `window` so the hook's registered listener
 * runs naturally. Replaces the previous (fragile) pattern of permanently overwriting
 * `window.addEventListener` to capture the handler — that pattern leaked to sibling tests
 * (auth-token.test.ts, auth-context.test.ts) under `--randomize --rerun-each` and silently
 * broke any test that registered storage listeners after this file loaded.
 */
const dispatchOAuthRetry = (widgetMessageId: string) => {
  window.dispatchEvent(new CustomEvent(oauthRetryEvent, { detail: { widgetMessageId } }))
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('useHandleIntegrationCompletion', () => {
  beforeEach(() => {
    seedTestTrustDomain()
    resetStore()
    sessionStorage.clear()
  })

  afterEach(async () => {
    resetStore()
    await resetTestDatabase()
    sessionStorage.clear()
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
      workspaceId: wsId,
    })

    return threadId
  }

  /**
   * Saves test messages to a thread in the database
   */
  const createTestMessages = async (threadId: string, messages: ThunderboltUIMessage[]) => {
    await saveMessagesWithContextUpdate(getDb(), wsId, threadId, messages)
    return messages
  }

  it('should set up event listener on mount', async () => {
    const mockSaveMessages = createMockSaveMessages()
    const mockChatInstance = createMockChatInstance()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // No integration credentials — local-only table is empty by default

    const addEventListenerSpy = spyOn(window, 'addEventListener')

    try {
      renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
        wrapper: createQueryTestWrapper(),
      })

      expect(addEventListenerSpy).toHaveBeenCalledWith(oauthRetryEvent, expect.any(Function))
    } finally {
      addEventListenerSpy.mockRestore()
    }
  })

  it('should remove event listener on unmount', async () => {
    const mockSaveMessages = createMockSaveMessages()
    const mockChatInstance = createMockChatInstance()

    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // No integration credentials — local-only table is empty by default

    const removeEventListenerSpy = spyOn(window, 'removeEventListener')

    try {
      const { unmount } = renderHook(
        () => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }),
        {
          wrapper: createQueryTestWrapper(),
        },
      )

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith(oauthRetryEvent, expect.any(Function))
    } finally {
      removeEventListenerSpy.mockRestore()
    }
  })

  it('should not process retry if widgetMessageId is missing', async () => {
    const mockSaveMessages = createMockSaveMessages()
    const mockChatInstance = createMockChatInstance()

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

    // No integration credentials — local-only table is empty by default

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper(),
    })

    dispatchOAuthRetry('')

    await act(async () => {
      await getClock().tickAsync(100)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should not process retry if chatThreadId is missing', async () => {
    const mockSaveMessages = createMockSaveMessages()

    // Use the real store and hydrate it with test data (id is null - no session created)
    resetStore()

    // No integration credentials — local-only table is empty by default

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper(),
    })

    dispatchOAuthRetry('widget-1')

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
    const mockSendMessage = mock(() => Promise.resolve())
    const mockChatInstance = createMockChatInstance([userMessage, widgetMessage])

    mockChatInstance.sendMessage = mockSendMessage

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      }),
    })

    dispatchOAuthRetry(widgetMessageId)

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

    const updatedWidgetMessage = await getMessage(getDb(), wsId, widgetMessageId)
    expect(updatedWidgetMessage).toBeDefined()
    expect(updatedWidgetMessage?.cache).toBeDefined()
    const cacheEntry = updatedWidgetMessage?.cache?.['connectIntegrationWidget']
    expect(cacheEntry).toEqual({ isHidden: true })

    expect(mockSendMessage).toHaveBeenCalled()
    const sendCall = (mockSendMessage.mock.calls[0] as unknown[] | undefined)?.[0] as
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
    const mockChatInstance = createMockChatInstance([userMessage, widgetMessage])

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      }),
    })

    dispatchOAuthRetry(widgetMessageId)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(mockSaveMessages).toHaveBeenCalled()

    mockSaveMessages.mockClear()

    dispatchOAuthRetry(widgetMessageId)

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
    const mockChatInstance = createMockChatInstance([userMessage, widgetMessage])

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    // Start with no credentials
    // No integration credentials — local-only table is empty by default

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      }),
    })

    dispatchOAuthRetry(widgetMessageId)

    await act(async () => {
      await getClock().tickAsync(200)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()

    // Now add credentials to simulate connection
    await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(mockSaveMessages).toHaveBeenCalled()
  })

  it('should handle missing widget message in chat', async () => {
    const threadId = await createTestThread()
    const widgetMessageId = uuidv7()

    const mockSaveMessages = createMockSaveMessages()
    const mockChatInstance = createMockChatInstance([])

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

    const originalWarn = console.warn
    const consoleWarnSpy = mock(() => {})
    console.warn = consoleWarnSpy

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      }),
    })

    dispatchOAuthRetry(widgetMessageId)

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
    const mockChatInstance = createMockChatInstance([widgetMessage])

    sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

    // Use the real store and hydrate it with test data
    hydrateStore({
      chatInstance: mockChatInstance,
      chatThread: null,
      id: threadId,
      mcpClients: [],
      models: [],
      selectedModel: null,
      triggerData: null,
    })

    await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

    const originalWarn = console.warn
    const consoleWarnSpy = mock(() => {})
    console.warn = consoleWarnSpy

    renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
      wrapper: createQueryTestWrapper({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      }),
    })

    dispatchOAuthRetry(widgetMessageId)

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
      const mockSendMessage = mock(() => Promise.resolve())
      const mockChatInstance = createMockChatInstance([userMessage, widgetMessage])

      Object.assign(mockChatInstance, { status: 'streaming' as const })
      mockChatInstance.sendMessage = mockSendMessage

      sessionStorage.setItem(getOAuthWidgetKey(widgetMessageId, 'provider'), 'google')

      // Use the real store and hydrate it with test data
      hydrateStore({
        chatInstance: mockChatInstance,
        chatThread: null,
        id: threadId,
        mcpClients: [],
        models: [],
        selectedModel: null,
        triggerData: null,
      })

      await saveIntegrationCredentials(getDb(), 'google', { access_token: 'test_token' }, true)

      renderHook(() => useHandleIntegrationCompletion({ saveMessages: mockSaveMessages, workspaceId: wsId }), {
        wrapper: createQueryTestWrapper({
          defaultOptions: {
            queries: {
              retry: false,
              gcTime: 0,
              staleTime: 0,
            },
          },
        }),
      })

      dispatchOAuthRetry(widgetMessageId)

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
      expect(mockSendMessage).not.toHaveBeenCalled()

      // Change status to ready before waitForChatReady times out
      Object.assign(mockChatInstance, { status: 'ready' as const })

      // Advance timers to allow waitForChatReady to poll and detect the status change
      await act(async () => {
        await getClock().tickAsync(200)
      })

      expect(mockSendMessage).toHaveBeenCalled()
    },
    // CI VMs have slower async processing overhead
    { timeout: 5000 },
  )
})
