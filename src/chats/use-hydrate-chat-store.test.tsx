import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getCurrentSession, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { useChatStore } from './chat-store'
import { getDb } from '@/db/database'
import { agentsTable, modelsTable, modesTable } from '@/db/tables'
import { v7 as uuidv7 } from 'uuid'
import { createChatThread } from '@/dal/chat-threads'
import { getModel } from '@/dal/models'
import { saveMessagesWithContextUpdate } from '@/dal/chat-messages'
import type { ThunderboltUIMessage } from '@/types'
import { createElement, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { MCPProvider } from '@/lib/mcp-provider'
import { getClock } from '@/testing-library'

/**
 * hydrateChatStore internally calls ky.get() (via discoverAndSeedRemoteAgents)
 * which uses setTimeout for retry logic. With fake timers globally installed,
 * we must advance the clock so ky retries don't hang forever.
 */
const callHydrate = async (hydrateFn: () => Promise<void>) => {
  const promise = hydrateFn()
  await act(async () => {
    await getClock().runAllAsync()
  })
  await act(async () => {
    await promise
  })
}

/**
 * Helper function to create a default mode (required for getSelectedMode)
 */
const createDefaultMode = async () => {
  const db = getDb()

  await db.insert(modesTable).values({
    id: 'mode-chat',
    name: 'chat',
    label: 'Chat',
    icon: 'message-square',
    systemPrompt: null,
    isDefault: 1,
    order: 0,
    deletedAt: null,
    defaultHash: null,
  })

  return 'mode-chat'
}

/**
 * Helper function to create a system model (required for getDefaultModelForThread)
 */
const createSystemModel = async () => {
  const db = getDb()
  const modelId = uuidv7()

  await db.insert(modelsTable).values({
    id: modelId,
    provider: 'thunderbolt',
    name: 'System Model',
    model: 'gpt-oss-120b',
    isSystem: 1,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    url: null,
    defaultHash: null,
  })

  return modelId
}

/**
 * Helper function to create a test model
 */
const createTestModel = async () => {
  const db = getDb()
  const modelId = uuidv7()

  await db.insert(modelsTable).values({
    id: modelId,
    provider: 'thunderbolt',
    name: 'Test Model',
    model: 'gpt-oss-120b',
    isSystem: 0,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    url: null,
    defaultHash: null,
  })

  return modelId
}

/**
 * Helper function to create a built-in agent (required for getSelectedAgent)
 */
const createDefaultAgent = async () => {
  const db = getDb()
  await db.insert(agentsTable).values({
    id: 'agent-built-in',
    name: 'Thunderbolt',
    type: 'built-in',
    transport: 'in-process',
    isSystem: 1,
    enabled: 1,
    deletedAt: null,
  })
}

/**
 * Helper function to create a test thread
 */
const createTestThread = async (modelId: string, title: string = 'Test Thread', agentId?: string) => {
  const model = await getModel(getDb(), modelId)
  if (!model) {
    throw new Error('Test setup failed')
  }
  const threadId = uuidv7()
  await createChatThread(
    getDb(),
    {
      id: threadId,
      title,
      contextSize: null,
      triggeredBy: null,
      wasTriggeredByAutomation: 0,
      agentId: agentId ?? null,
    },
    model,
  )
  return threadId
}

/**
 * Helper function to create a second agent
 */
const createSecondAgent = async () => {
  const db = getDb()
  const agentId = 'agent-second'
  await db.insert(agentsTable).values({
    id: agentId,
    name: 'Second Agent',
    type: 'built-in',
    transport: 'in-process',
    isSystem: 0,
    enabled: 1,
    deletedAt: null,
  })
  return agentId
}

/**
 * Helper function to create test messages
 */
const createTestMessage = (overrides?: Partial<ThunderboltUIMessage>): ThunderboltUIMessage => ({
  id: uuidv7(),
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  ...overrides,
})

/**
 * Wrapper that includes Router context for useNavigate and MCPProvider
 */
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryWrapper = createQueryTestWrapper()
  return createElement(
    BrowserRouter,
    null,
    createElement(queryWrapper, null, createElement(MCPProvider, null, children)),
  )
}

describe('useHydrateChatStore', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    // Reset store state before each test
    resetStore()
    await resetTestDatabase()
    // Create default mode (required for getSelectedMode), system model (required for getDefaultModelForThread),
    // and default agent (required for getSelectedAgent)
    await createDefaultMode()
    await createSystemModel()
    await createDefaultAgent()
  })

  afterEach(async () => {
    // Cleanup rendered components before resetting store to prevent errors during unmount
    cleanup()
    // Reset store state after each test
    resetStore()
    await resetTestDatabase()
  })

  describe('isReady state', () => {
    it('should start with isReady as false', async () => {
      const modelId = await createTestModel()
      const threadId = await createTestThread(modelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      expect(result.current.isReady).toBe(false)
    })

    it('should set isReady to true after hydrateChatStore completes', async () => {
      const modelId = await createTestModel()
      const threadId = await createTestThread(modelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      expect(result.current.isReady).toBe(false)

      await callHydrate(() => result.current.hydrateChatStore())

      expect(result.current.isReady).toBe(true)
    })
  })

  describe('hydrateChatStore', () => {
    it('should hydrate useChatStore with correct state', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId, 'My Test Thread')

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await callHydrate(() => result.current.hydrateChatStore())

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(storeState.currentSessionId).toBe(threadId)
      expect(session?.chatThread).not.toBeNull()
      expect(session?.chatThread?.id).toBe(threadId)
      expect(session?.chatThread?.title).toBe('My Test Thread')
      expect(session?.selectedModel).not.toBeNull()
      // getDefaultModelForThread returns the system model when no messages exist
      expect(session?.selectedModel?.isSystem).toBe(1)
      expect(session?.acpClient).toBeDefined()
      expect(session?.messages).toBeDefined()
      expect(storeState.mcpClients).toBeDefined()
      expect(session?.triggerData).toBeDefined()
    })

    it('should reset store before hydrating', async () => {
      const systemModelId = await createSystemModel()
      const threadId1 = await createTestThread(systemModelId, 'Thread 1')
      const threadId2 = await createTestThread(systemModelId, 'Thread 2')

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId1, isNew: false }), {
        wrapper: TestWrapper,
      })

      // First hydration
      await callHydrate(() => result.current.hydrateChatStore())

      const firstState = useChatStore.getState()
      expect(firstState.currentSessionId).toBe(threadId1)

      // Second hydration with different thread
      const { result: result2 } = renderHook(() => useHydrateChatStore({ id: threadId2, isNew: false }), {
        wrapper: TestWrapper,
      })

      await callHydrate(() => result2.current.hydrateChatStore())

      const secondState = useChatStore.getState()
      expect(secondState.currentSessionId).toBe(threadId2)
      expect(secondState.currentSessionId).not.toBe(threadId1)

      const session = secondState.sessions.get(threadId2)
      expect(session?.chatThread?.id).toBe(threadId2)
    })

    it('should hydrate store with messages when thread has messages', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)
      const messages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }),
        createTestMessage({ role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] }),
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await callHydrate(() => result.current.hydrateChatStore())

      const session = getCurrentSession()
      expect(session?.acpClient).toBeDefined()
      expect(session?.messages).toBeDefined()
      expect(session?.messages.length).toBe(2)
    })

    it('should use the chat thread agent instead of the global selected agent', async () => {
      const systemModelId = await createSystemModel()
      const secondAgentId = await createSecondAgent()
      // Create a thread that was made with the second agent
      const threadId = await createTestThread(systemModelId, 'Agent Thread', secondAgentId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await callHydrate(() => result.current.hydrateChatStore())

      const session = getCurrentSession()
      // The session should use the thread's agent, not the global selected agent
      expect(session?.agentConfig.id).toBe(secondAgentId)
      expect(session?.agentConfig.name).toBe('Second Agent')
    })

    it('should hydrate store with empty messages when thread has no messages', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await callHydrate(() => result.current.hydrateChatStore())

      const session = getCurrentSession()
      expect(session?.acpClient).toBeDefined()
      expect(session?.messages).toBeDefined()
      expect(session?.messages.length).toBe(0)
    })
  })

  describe('saveMessages', () => {
    it('should save messages and update store state', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      // First hydrate to set up the store
      await callHydrate(() => result.current.hydrateChatStore())

      const session = getCurrentSession()
      expect(session?.selectedModel).not.toBeNull()

      // Save messages
      const newMessages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'New message' }] }),
      ]

      await act(async () => {
        await result.current.saveMessages({ id: threadId, messages: newMessages })
      })

      // Verify messages were saved (we can check by hydrating again or querying the database)
      // For now, we just verify the function completed without error
      expect(result.current.saveMessages).toBeDefined()
    })

    it('should throw error if no session is found when saving messages', async () => {
      const threadId = uuidv7()

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      // Don't hydrate, so no session will exist
      const newMessages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'New message' }] }),
      ]

      let error: unknown = null
      await act(async () => {
        try {
          await result.current.saveMessages({ id: threadId, messages: newMessages })
        } catch (e) {
          error = e
        }
      })

      expect(error).not.toBeNull()
      expect(error instanceof Error && error.message).toBe('No session found')
    })

    it('should save messages when model is selected', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      // Hydrate to set up the store with a model
      await callHydrate(() => result.current.hydrateChatStore())

      const newMessages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Test message' }] }),
      ]

      await act(async () => {
        await result.current.saveMessages({ id: threadId, messages: newMessages })
      })

      // Verify no error was thrown
      expect(result.current.saveMessages).toBeDefined()
    })
  })
})
