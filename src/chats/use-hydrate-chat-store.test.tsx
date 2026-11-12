/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import * as chatDal from '@/dal'
import { createMockChatInstance, getCurrentSession, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { moveChatToProject } from '@/projects/use-move-chat-to-project'
import { createProject, setChatThreadProject, softDeleteProject } from '@/dal/projects'
import { useHydrateChatStore } from './use-hydrate-chat-store'
import { useChatStore } from './chat-store'
import { getDb } from '@/db/database'
import { agentsSystemTable, chatThreadsTable, modelsTable, projectsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import { v7 as uuidv7 } from 'uuid'
import { eq } from 'drizzle-orm'
import { createChatThread, getChatThread as getThread } from '@/dal/chat-threads'
import { createAgent } from '@/dal/agents'
import { updateSettings } from '@/dal/settings'
import { getModel, updateModel } from '@/dal/models'
import { saveProviderConnection } from '@/dal/provider-connections'
import * as modelPrewarm from '@/ai/prewarm-tinfoil-model'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { saveMessagesWithContextUpdate } from '@/dal/chat-messages'
import type { ThunderboltUIMessage } from '@/types'
import { createElement, type ReactNode } from 'react'
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router'
import { MCPProvider } from '@/lib/mcp-provider'
import { DatabaseProvider } from '@/contexts/database-context'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getClock } from '@/testing-library'
import { defaultChatTitle } from '@/lib/constants'

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
 * Helper function to create a test thread
 */
const createTestThread = async (modelId: string, title: string = 'Test Thread') => {
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
    },
    model,
  )
  return threadId
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
 * The test database, except that building a read of `agents_system` first calls
 * `onRead`: discovery landing while hydration is mid-way through its queries.
 */
const withAgentsSystemRead = (db: AnyDrizzleDatabase, onRead: () => void): AnyDrizzleDatabase =>
  new Proxy(db, {
    get: (target, property) => {
      const value = Reflect.get(target, property, target)
      if (property !== 'select') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (...args: Parameters<AnyDrizzleDatabase['select']>) => {
        const builder = target.select(...args)
        const from = builder.from.bind(builder)
        builder.from = ((table: Parameters<typeof from>[0]) => {
          if (table === agentsSystemTable) {
            onRead()
          }
          return from(table)
        }) as typeof builder.from
        return builder
      }
    },
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

/** The hosted agent's row as discovery writes it, named as the default. */
const seedDiscoveredDefault = () =>
  getDb().insert(agentsSystemTable).values({
    id: 'hosted-agent',
    name: 'Assistant',
    type: 'managed-http',
    transport: 'http',
    url: '/v1/agent/chat',
    fetchedAt: new Date().toISOString(),
    isDefault: 1,
  })

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
    // Create system model (required for getDefaultModelForThread)
    await createSystemModel()
  })

  afterEach(async () => {
    // Cleanup rendered components before resetting store to prevent errors during unmount
    cleanup()
    // Reset store state after each test
    resetStore()
    await resetTestDatabase()
  })

  it.each(['streaming', 'done'] as const)(
    'restores a %s reasoning-only reply without running it again',
    async (state) => {
      const threadId = await createTestThread(await createTestModel())
      const prompt = createTestMessage()
      const partial = createTestMessage({
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'Long unfinished reasoning', state }],
      })
      await saveMessagesWithContextUpdate(getDb(), threadId, [prompt, partial])
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      expect(getCurrentSession()?.interruptedReplyId).toBe(state === 'streaming' ? partial.id : undefined)
      expect(getCurrentSession()?.chatInstance.status).toBe('ready')
      expect(getCurrentSession()?.chatInstance.messages.at(-1)?.parts).toEqual(partial.parts)
    },
  )

  it.each(['error', 'completed', 'stopped', undefined] as const)(
    'restores framing-only outcome %s without silently losing failures or restarting it',
    async (turnOutcome) => {
      const threadId = await createTestThread(await createTestModel())
      const prompt = createTestMessage()
      const reply = createTestMessage({ role: 'assistant', parts: [{ type: 'step-start' }], metadata: { turnOutcome } })
      await saveMessagesWithContextUpdate(getDb(), threadId, [prompt, reply])
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      expect(getCurrentSession()?.retriesExhausted).toBe(turnOutcome === 'error' || turnOutcome === undefined)
      expect(getCurrentSession()?.interruptedReplyId).toBeUndefined()
      expect(getCurrentSession()?.chatInstance.status).toBe('ready')
      expect(getCurrentSession()?.chatInstance.messages.at(-1)?.metadata?.turnOutcome).toBe(turnOutcome)
    },
  )

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

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(result.current.isReady).toBe(true)
    })
  })

  describe('hydrateChatStore', () => {
    it.each(['managed', 'model key', 'connection OAuth'] as const)(
      'warms the selected Tinfoil transport on initial and cached hydration: %s',
      async (credentials) => {
        const managed = credentials === 'managed'
        if (!managed) {
          useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
        }
        const modelId = await createTestModel()
        const connectionId =
          credentials === 'connection OAuth'
            ? await saveProviderConnection(getDb(), {
                provider: 'tinfoil',
                name: 'Personal Tinfoil',
                authMethod: 'oauth',
                credentials: { access_token: 'connection-token', refresh_token: 'refresh' },
              })
            : null
        await updateModel(getDb(), modelId, {
          provider: 'tinfoil',
          isSystem: managed ? 1 : 0,
          isConfidential: 1,
          apiKey: credentials === 'model key' ? 'model-key' : null,
          providerConnectionId: connectionId,
        })
        await updateSettings(getDb(), { selected_model: modelId })
        const prewarm = spyOn(modelPrewarm, 'prewarmTinfoilModel').mockResolvedValue(undefined)
        try {
          const id = uuidv7()
          const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true }), {
            wrapper: TestWrapper,
          })
          await act(async () => {
            await result.current.hydrateChatStore()
          })
          expect(prewarm).toHaveBeenCalledTimes(1)
          expect(prewarm).toHaveBeenCalledWith(getCurrentSession()?.selectedModel)
          expect(getCurrentSession()?.selectedModel.id).toBe(modelId)
          prewarm.mockClear()
          await act(async () => {
            await result.current.hydrateChatStore()
          })
          expect(prewarm).toHaveBeenCalledTimes(1)
          expect(prewarm).toHaveBeenCalledWith(getCurrentSession()?.selectedModel)
        } finally {
          prewarm.mockRestore()
        }
      },
    )

    it('never warms the local model when the selected agent owns inference', async () => {
      await createAgent(getDb(), {
        id: 'remote-private',
        name: 'Remote agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.test/ws',
        userId: 'u1',
      })
      const modelId = await createTestModel()
      await updateModel(getDb(), modelId, { provider: 'tinfoil', isSystem: 1, isConfidential: 1 })
      await updateSettings(getDb(), { selected_agent: 'remote-private', selected_model: modelId })
      const prewarm = spyOn(modelPrewarm, 'prewarmTinfoilModel').mockResolvedValue(undefined)
      try {
        const id = uuidv7()
        const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true }), {
          wrapper: TestWrapper,
        })
        await act(async () => {
          await result.current.hydrateChatStore()
          await result.current.hydrateChatStore()
        })
        expect(getCurrentSession()?.selectedAgent.id).toBe('remote-private')
        expect(prewarm).not.toHaveBeenCalled()
      } finally {
        prewarm.mockRestore()
      }
    })

    it('lets a changed provider mode replace pending hydration without creating the session twice', async () => {
      const id = uuidv7()
      const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true }), { wrapper: TestWrapper })
      const previous = new AbortController()

      await act(async () => {
        const superseded = result.current.hydrateChatStore(previous.signal)
        previous.abort()
        await Promise.all([superseded, result.current.hydrateChatStore(new AbortController().signal)])
      })

      expect(useChatStore.getState().sessions.size).toBe(1)
      expect(getCurrentSession()?.id).toBe(id)
      expect(result.current.isReady).toBe(true)
    })

    it('does not create a session after its host unmounts', async () => {
      const id = uuidv7()
      const { result, unmount } = renderHook(() => useHydrateChatStore({ id, isNew: true }), {
        wrapper: TestWrapper,
      })
      const controller = new AbortController()
      const pending = result.current.hydrateChatStore(controller.signal)
      controller.abort()
      unmount()
      await pending

      expect(useChatStore.getState().sessions.has(id)).toBe(false)
      expect(getCurrentSession()).toBeNull()
    })

    it('does not let a previous route publish its session after the next route hydrates', async () => {
      const previousId = uuidv7()
      const nextId = uuidv7()
      const { result, rerender } = renderHook(({ id }) => useHydrateChatStore({ id, isNew: true }), {
        initialProps: { id: previousId },
        wrapper: TestWrapper,
      })
      const controller = new AbortController()
      const previous = result.current.hydrateChatStore(controller.signal)
      controller.abort()
      rerender({ id: nextId })
      await act(async () => {
        await Promise.all([previous, result.current.hydrateChatStore(new AbortController().signal)])
      })

      expect(useChatStore.getState().sessions.has(previousId)).toBe(false)
      expect(getCurrentSession()?.id).toBe(nextId)
    })

    it('does not publish a cancelled refresh of an existing session', async () => {
      const id = uuidv7()
      const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      const originalSession = getCurrentSession()
      const models = [...useChatStore.getState().models]
      useChatStore.getState().setModels(models)
      const controller = new AbortController()
      const pending = result.current.hydrateChatStore(controller.signal)
      controller.abort()
      await pending

      expect(getCurrentSession()).toBe(originalSession)
      expect(useChatStore.getState().models).toBe(models)
      expect(useChatStore.getState().sessions.size).toBe(1)

      await act(async () => {
        await result.current.hydrateChatStore(new AbortController().signal)
      })
      expect(useChatStore.getState().models).not.toBe(models)
      expect(getCurrentSession()?.chatInstance).toBe(originalSession?.chatInstance)
      expect(useChatStore.getState().sessions.size).toBe(1)
    })

    it('should hydrate useChatStore with correct state', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId, 'My Test Thread')

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(storeState.currentSessionId).toBe(threadId)
      expect(session?.chatThread).not.toBeNull()
      expect(session?.chatThread?.id).toBe(threadId)
      expect(session?.chatThread?.title).toBe('My Test Thread')
      expect(session?.selectedModel).not.toBeNull()
      // getDefaultModelForThread returns the system model when no messages exist
      expect(session?.selectedModel?.isSystem).toBe(1)
      expect(storeState.models).toBeDefined()
      expect(storeState.models.length).toBeGreaterThan(0)
      expect(session?.chatInstance).toBeDefined()
      expect(session?.chatInstance?.id).toBe(threadId)
      expect(storeState.getMcpClients()).toBeDefined()
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
      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const firstState = useChatStore.getState()
      expect(firstState.currentSessionId).toBe(threadId1)

      // Second hydration with different thread
      const { result: result2 } = renderHook(() => useHydrateChatStore({ id: threadId2, isNew: false }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result2.current.hydrateChatStore()
      })

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

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const session = getCurrentSession()
      expect(session?.chatInstance).toBeDefined()
      expect(session?.chatInstance?.messages).toBeDefined()
      expect(session?.chatInstance?.messages.length).toBe(2)
    })

    it('should hydrate store with empty messages when thread has no messages', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const session = getCurrentSession()
      expect(session?.chatInstance).toBeDefined()
      expect(session?.chatInstance?.messages).toBeDefined()
      expect(session?.chatInstance?.messages.length).toBe(0)
    })

    it('defaults a new chat to the last-used agent from settings, not the built-in', async () => {
      // A new chat has no `chat_threads` row, so the agent resolves from the
      // global `selected_agent` setting (the user's last pick). It must win over
      // `allAgents[0]`, which is always the built-in.
      await createAgent(getDb(), {
        id: 'custom-last-used',
        name: 'Last Used Agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.test/ws',
        userId: 'u1',
      })
      await updateSettings(getDb(), { selected_agent: 'custom-last-used' })

      const threadId = uuidv7()
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: true }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const session = getCurrentSession()
      expect(session?.selectedAgent.id).toBe('custom-last-used')
    })

    const hydrateNewChat = async () => {
      const { result } = renderHook(() => useHydrateChatStore({ id: uuidv7(), isNew: true }), {
        wrapper: TestWrapper,
      })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
    }

    it('restores the selected model for a new chat without creating a thread', async () => {
      const modelId = await createTestModel()
      await updateSettings(getDb(), { selected_model: modelId })

      await hydrateNewChat()

      const session = getCurrentSession()
      expect(session?.selectedModel.id).toBe(modelId)
      expect(session?.chatThread).toBeNull()
      expect(session?.chatInstance.messages).toEqual([])
      expect(session?.triggerData).toBeNull()
    })

    it('falls back to a system model when the selected model is disabled', async () => {
      const modelId = await createTestModel()
      await updateSettings(getDb(), { selected_model: modelId })
      await updateModel(getDb(), modelId, { enabled: 0 })

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedModel.isSystem).toBe(1)
      expect(getCurrentSession()?.selectedModel.id).not.toBe(modelId)
    })

    it('keeps the last-used agent for a new chat ahead of the agent discovery names as default', async () => {
      await createAgent(getDb(), {
        id: 'custom-last-used',
        name: 'Last Used Agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.test/ws',
        userId: 'u1',
      })
      await updateSettings(getDb(), { selected_agent: 'custom-last-used' })
      await seedDiscoveredDefault()

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent.id).toBe('custom-last-used')
    })

    it('opens on the discovered default when discovery lands while hydration is reading', async () => {
      // Discovery reports its default as hydration reads `agents_system`: too late
      // for the rows (none are written yet), too early to move a session (none exists).
      const hostedAgent = {
        ...builtInAgent,
        id: 'hosted-agent',
        type: 'managed-http' as const,
        transport: 'http' as const,
        url: '/v1/agent/chat',
      }
      const db = withAgentsSystemRead(getDb(), () =>
        useChatStore.getState().applyDiscoveredDefaultAgent(hostedAgent, [builtInAgent, hostedAgent], {}),
      )
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(TestWrapper, null, createElement(DatabaseProvider, { db, children }))
      const { result } = renderHook(() => useHydrateChatStore({ id: uuidv7(), isNew: true }), { wrapper })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(getCurrentSession()?.selectedAgent.id).toBe('hosted-agent')
    })

    it('keeps a persisted thread with no agent of its own off the discovered default', async () => {
      // Automation runs and threads from before `agent_id` existed have none.
      const threadId = await createTestThread(await createTestModel())
      await seedDiscoveredDefault()

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })
      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(getCurrentSession()?.selectedAgent.id).toBe(builtInAgent.id)
    })

    it('keeps a new chat on the built-in agent when the user has picked a model', async () => {
      await updateSettings(getDb(), { selected_model: await createTestModel() })
      await seedDiscoveredDefault()

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent.id).toBe(builtInAgent.id)
    })

    it('opens a returning visitor on the cached default row while discovery has not answered yet', async () => {
      await seedDiscoveredDefault()
      expect(useChatStore.getState().agentDiscovery).toEqual({ status: 'pending' })

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent.id).toBe('hosted-agent')
    })

    it('ignores a stale cached default row once discovery has reported no default', async () => {
      // Discovery cleared the default (a 403, or none named) before this chat
      // opened, but hydration still reads the row it removed.
      await seedDiscoveredDefault()
      useChatStore.getState().applyDiscoveredDefaultAgent(null, [builtInAgent], {})

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent.id).toBe(builtInAgent.id)
    })

    it('uses the cached default row again once discovery restarts for a new account or server', async () => {
      await seedDiscoveredDefault()
      // The previous server answered 403; the run for the new one has just started.
      useChatStore.getState().applyDiscoveredDefaultAgent(null, [builtInAgent], {})
      useChatStore.getState().resetAgentDiscovery()

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent.id).toBe('hosted-agent')
    })

    it('opens a first-time visitor with no last-used agent on the agent discovery names as default', async () => {
      await seedDiscoveredDefault()

      await hydrateNewChat()

      expect(getCurrentSession()?.selectedAgent).toMatchObject({ id: 'hosted-agent', type: 'managed-http' })
    })
  })

  describe('messages that sync after the chat opens', () => {
    /** Opens `threadId` while the device is still downloading; resolve the returned promise when it lands. */
    const openDuringDownload = async (threadId: string) => {
      const download = Promise.withResolvers<void>()
      const { result } = renderHook(
        () => useHydrateChatStore({ id: threadId, isNew: false, waitForSyncCatchUp: () => download.promise }),
        { wrapper: TestWrapper },
      )
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      const finishDownload = async () => {
        await act(async () => {
          download.resolve()
          await getClock().runAllAsync()
        })
      }
      return finishDownload
    }

    const messageIds = () => getCurrentSession()?.chatInstance.messages.map((message) => message.id)

    it('shows the messages of a chat opened before they were downloaded', async () => {
      const threadId = await createTestThread(await createTestModel())
      const finishDownload = await openDuringDownload(threadId)
      expect(messageIds()).toEqual([])

      const synced = [createTestMessage(), createTestMessage({ role: 'assistant' })]
      await saveMessagesWithContextUpdate(getDb(), threadId, synced)
      await finishDownload()

      expect(messageIds()).toEqual(synced.map((message) => message.id))
    })

    it('marks an empty chat as waiting for its messages until the download lands', async () => {
      const threadId = await createTestThread(await createTestModel())
      const finishDownload = await openDuringDownload(threadId)
      expect(getCurrentSession()?.awaitingSyncedMessages).toBe(true)

      await saveMessagesWithContextUpdate(getDb(), threadId, [createTestMessage()])
      await finishDownload()

      expect(getCurrentSession()?.awaitingSyncedMessages).toBe(false)
    })

    it('does not mark a chat that already has messages as waiting', async () => {
      const threadId = await createTestThread(await createTestModel())
      await saveMessagesWithContextUpdate(getDb(), threadId, [createTestMessage()])
      await openDuringDownload(threadId)

      expect(getCurrentSession()?.awaitingSyncedMessages).toBe(false)
    })

    it('appends the messages that arrived after the ones the chat opened with', async () => {
      const threadId = await createTestThread(await createTestModel())
      const opened = createTestMessage()
      await saveMessagesWithContextUpdate(getDb(), threadId, [opened])
      const finishDownload = await openDuringDownload(threadId)

      const synced = [createTestMessage({ role: 'assistant' }), createTestMessage()]
      await saveMessagesWithContextUpdate(getDb(), threadId, synced)
      await finishDownload()

      expect(messageIds()).toEqual([opened.id, ...synced.map((message) => message.id)])
    })

    it.each([{ parts: [] }, { parts: [{ type: 'step-start' }] }] satisfies { parts: ThunderboltUIMessage['parts'] }[])(
      'shows a synced failed turn with parts %j as failed',
      async ({ parts }) => {
        const threadId = await createTestThread(await createTestModel())
        const finishDownload = await openDuringDownload(threadId)

        await saveMessagesWithContextUpdate(getDb(), threadId, [
          createTestMessage(),
          createTestMessage({ role: 'assistant', parts, metadata: { turnOutcome: 'error' } }),
        ])
        await finishDownload()

        expect(messageIds()).toHaveLength(2)
        expect(getCurrentSession()?.retriesExhausted).toBe(true)
      },
    )

    it('leaves a chat alone once it no longer matches the start of the saved messages', async () => {
      const threadId = await createTestThread(await createTestModel())
      const finishDownload = await openDuringDownload(threadId)
      // The user wrote in the empty-looking chat before its history landed.
      const typed = createTestMessage()
      getCurrentSession()!.chatInstance.messages = [typed]

      await saveMessagesWithContextUpdate(getDb(), threadId, [
        createTestMessage(),
        createTestMessage({ role: 'assistant' }),
      ])
      await finishDownload()

      expect(messageIds()).toEqual([typed.id])
      expect(getCurrentSession()?.awaitingSyncedMessages).toBe(false)
    })

    it.each([
      ['the user is stopping a reply', { stopping: true }],
      ['its context is being compacted', { compactionStatus: 'compacting' as const }],
    ])('leaves a chat alone while %s', async (_, busy) => {
      const threadId = await createTestThread(await createTestModel())
      const finishDownload = await openDuringDownload(threadId)
      useChatStore.getState().updateSession(threadId, busy)

      await saveMessagesWithContextUpdate(getDb(), threadId, [createTestMessage()])
      await finishDownload()

      expect(messageIds()).toEqual([])
      expect(getCurrentSession()?.awaitingSyncedMessages).toBe(false)
    })
  })

  describe('model for a thread that falls back to the built-in agent', () => {
    /** A system Tinfoil model: confidential, and server-keyed so the picker enables it. */
    const createConfidentialModel = async () => {
      const modelId = uuidv7()
      await getDb().insert(modelsTable).values({
        id: modelId,
        provider: 'tinfoil',
        name: 'Confidential Model',
        model: 'kimi-k2',
        isSystem: 1,
        enabled: 1,
        isConfidential: 1,
        toolUsage: 1,
        startWithReasoning: 0,
      })
      return modelId
    }

    /** Hydrates a persisted thread on a device whose `selected_model` is confidential. */
    const hydrateThread = async (thread: { agentId?: string; isEncrypted: 0 | 1 }) => {
      const confidentialModelId = await createConfidentialModel()
      await updateSettings(getDb(), { selected_model: confidentialModelId })
      const threadId = uuidv7()
      await createChatThread(
        getDb(),
        { id: threadId, title: 'Synced', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0, ...thread },
        (await getModel(getDb(), confidentialModelId))!,
      )
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      return getCurrentSession()
    }

    it('swaps in a non-confidential model when a hosted thread opens before discovery seeds its agent', async () => {
      // Fresh device: the thread synced, `agents_system` has no hosted row yet.
      const session = await hydrateThread({ agentId: 'hosted-agent', isEncrypted: 0 })

      expect(session?.selectedAgent.id).toBe(builtInAgent.id)
      expect(session?.selectedModel).toMatchObject({ name: 'System Model', isConfidential: 0 })
    })

    it('keeps the model of a thread whose confidentiality already matches it', async () => {
      const session = await hydrateThread({ isEncrypted: 1 })

      expect(session?.selectedModel).toMatchObject({ name: 'Confidential Model', isConfidential: 1 })
    })
  })

  describe('project assignment', () => {
    it('preserves a newer project move while a cached hydration is waiting for models', async () => {
      const db = getDb()
      const original = await createProject(db, { name: 'Original workspace' })
      const destination = await createProject(db, { name: 'Destination workspace' })
      const threadId = await createTestThread(await createSystemModel())
      await setChatThreadProject(db, threadId, original.id)
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => result.current.hydrateChatStore())
      const modelsRequested = Promise.withResolvers<void>()
      const releaseModels = Promise.withResolvers<void>()
      const query = chatDal.getAvailableModels(db)
      const readRows = query.all.bind(query)
      const execution = spyOn(query, 'all').mockImplementationOnce(async (...args) => {
        modelsRequested.resolve()
        await releaseModels.promise
        return readRows(...args)
      })
      const models = spyOn(chatDal, 'getAvailableModels').mockReturnValueOnce(query)
      try {
        await act(async () => {
          const hydration = result.current.hydrateChatStore()
          await modelsRequested.promise
          await moveChatToProject(
            { chatThreadId: threadId, projectId: destination.id },
            {
              db,
              setProject: setChatThreadProject,
              updateOpenSession: (id, projectId) => useChatStore.getState().updateSession(id, { projectId }),
              refreshChatList: async () => {},
            },
          )
          releaseModels.resolve()
          await hydration
        })
        expect(getCurrentSession()?.projectId).toBe(destination.id)
        expect((await getThread(db, threadId))?.projectId).toBe(destination.id)
      } finally {
        releaseModels.resolve()
        models.mockRestore()
        execution.mockRestore()
      }
    })

    it('does not reactivate a cached chat when navigation aborts while stopping its old environment', async () => {
      const db = getDb()
      const project = await createProject(db, { name: 'Old environment' })
      const threadId = await createTestThread(await createSystemModel())
      await setChatThreadProject(db, threadId, project.id)
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => result.current.hydrateChatStore())
      const controller = new AbortController()
      const stop = spyOn(getCurrentSession()!.chatInstance, 'stop').mockImplementationOnce(async () =>
        controller.abort(),
      )
      useChatStore.getState().setCurrentSessionId('new-navigation')
      await db.update(chatThreadsTable).set({ projectId: null }).where(eq(chatThreadsTable.id, threadId))
      try {
        await act(async () => result.current.hydrateChatStore(controller.signal))
        expect(stop).toHaveBeenCalledTimes(1)
        expect(useChatStore.getState().currentSessionId).toBe('new-navigation')
      } finally {
        stop.mockRestore()
      }
    })

    it.each(['local', 'synced'])(
      'reopens a cached chat after a %s project deletion without reloading',
      async (source) => {
        const db = getDb()
        const project = await createProject(db, { name: 'Removed workspace' })
        const threadId = await createTestThread(await createSystemModel())
        await setChatThreadProject(db, threadId, project.id)
        const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
          wrapper: TestWrapper,
        })
        await act(async () => result.current.hydrateChatStore())
        const chatInstance = getCurrentSession()!.chatInstance
        expect(getCurrentSession()?.projectId).toBe(project.id)
        useChatStore.getState().setCurrentSessionId('another-chat')

        await act(async () => {
          if (source === 'local') {
            await softDeleteProject(db, project.id)
          } else {
            await db
              .update(projectsTable)
              .set({ deletedAt: new Date().toISOString() })
              .where(eq(projectsTable.id, project.id))
            await db.update(chatThreadsTable).set({ projectId: null }).where(eq(chatThreadsTable.id, threadId))
          }
          await result.current.hydrateChatStore()
        })

        expect(getCurrentSession()?.projectId).toBeNull()
        expect(getCurrentSession()?.chatThread?.projectId).toBeNull()
        expect(getCurrentSession()?.chatInstance).toBe(chatInstance)
        expect((await getThread(db, threadId))?.projectId).toBeNull()
      },
    )

    it('starts a new chat in the project it was opened from', async () => {
      const { result } = renderHook(() => useHydrateChatStore({ id: uuidv7(), isNew: true, projectId: 'project-a' }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(getCurrentSession()?.projectId).toBe('project-a')
    })

    it('starts a loose chat with no project', async () => {
      // The reported bug: leaving `/chats/new?projectId=…` for `/chats/new` kept
      // the old project, and the first message was filed under it. The route now
      // makes the project part of the new chat's identity, so this hook is asked
      // for a fresh chat with none.
      const { result } = renderHook(() => useHydrateChatStore({ id: uuidv7(), isNew: true, projectId: null }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(getCurrentSession()?.projectId).toBeNull()
    })

    it('ignores the URL project for a chat that already exists', async () => {
      // A persisted thread owns its project; a stale query string must not move it.
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId, 'Existing')

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false, projectId: 'project-b' }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      expect(getCurrentSession()?.projectId).toBeNull()
    })
  })

  describe('partial/final save ordering', () => {
    it('keeps an already-started partial write ahead of the authoritative final save', async () => {
      const modelId = await createSystemModel()
      const threadId = await createTestThread(modelId)
      const prompt = createTestMessage()
      const partial = createTestMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Part', state: 'streaming' }],
      })
      const completed: ThunderboltUIMessage = {
        ...partial,
        parts: [{ type: 'text', text: 'Complete answer', state: 'done' }],
        metadata: { turnOutcome: 'completed' },
      }
      await saveMessagesWithContextUpdate(getDb(), threadId, [prompt])
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      useChatStore
        .getState()
        .updateSession(threadId, { chatInstance: createMockChatInstance([prompt, partial], 'streaming') })
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const persistPartial = chatDal.saveStreamingAssistantMessage
      const partialSpy = spyOn(chatDal, 'saveStreamingAssistantMessage').mockImplementation(async (...args) => {
        started.resolve()
        await release.promise
        return persistPartial(...args)
      })
      const finalSpy = spyOn(chatDal, 'saveMessagesWithContextUpdate')
      try {
        const partialSave = result.current.saveStreamingMessage({ threadId, message: partial, parentId: prompt.id })
        await started.promise
        useChatStore.getState().updateSession(threadId, { chatInstance: createMockChatInstance([prompt, completed]) })
        const finalSave = result.current.saveMessages({ id: threadId, messages: [completed] })
        await getClock().tickAsync(50)
        expect(finalSpy).not.toHaveBeenCalled()
        release.resolve()
        await act(async () => {
          await Promise.all([partialSave, finalSave])
        })
        const saved = (await chatDal.getChatMessages(getDb(), threadId)).find((message) => message.id === partial.id)
        expect(saved?.parts).toEqual(completed.parts)
        expect(saved?.metadata).toMatchObject({ turnOutcome: 'completed' })
      } finally {
        release.resolve()
        partialSpy.mockRestore()
        finalSpy.mockRestore()
      }
    })

    it.each(['finished', 'next reply'] as const)('drops a queued partial after the turn is %s', async (boundary) => {
      const modelId = await createSystemModel()
      const threadId = await createTestThread(modelId)
      const prompt = createTestMessage()
      const completed = createTestMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Complete answer', state: 'done' }],
        metadata: { turnOutcome: 'completed' },
      })
      await saveMessagesWithContextUpdate(getDb(), threadId, [prompt, completed])
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      useChatStore.getState().updateSession(threadId, {
        chatInstance:
          boundary === 'finished'
            ? createMockChatInstance([prompt, completed])
            : createMockChatInstance([prompt, completed, createTestMessage({ role: 'assistant' })], 'streaming'),
      })
      await result.current.saveStreamingMessage({
        threadId,
        message: {
          ...completed,
          metadata: undefined,
          parts: [{ type: 'text', text: 'Old partial', state: 'streaming' }],
        },
        parentId: prompt.id,
      })
      const saved = (await chatDal.getChatMessages(getDb(), threadId)).find((message) => message.id === completed.id)
      expect(saved?.parts).toEqual(completed.parts)
      expect(saved?.metadata).toMatchObject({ turnOutcome: 'completed' })
    })
  })

  describe('saveMessages', () => {
    it.each(['Original topic', ''])(
      'keeps title generation tied to the first prompt %j when saving only the tail',
      async (firstText) => {
        const modelId = await createSystemModel()
        const threadId = await createTestThread(modelId, defaultChatTitle)
        const history = [
          createTestMessage({ parts: [{ type: 'text', text: firstText }] }),
          createTestMessage({ role: 'assistant', parts: [{ type: 'text', text: 'Previous reply' }] }),
          createTestMessage({ parts: [{ type: 'text', text: 'Later topic' }] }),
        ]
        await saveMessagesWithContextUpdate(getDb(), threadId, history)
        const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
          wrapper: TestWrapper,
        })

        await act(async () => {
          await result.current.hydrateChatStore()
          await result.current.saveMessages({ id: threadId, messages: history.slice(-2) })
        })

        expect((await getThread(getDb(), threadId))?.title).toBe(firstText || defaultChatTitle)
      },
    )

    it('should save messages and update store state', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      // First hydrate to set up the store
      await act(async () => {
        await result.current.hydrateChatStore()
      })

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

    it.each([
      ['the hosted agent, never private, since its content reaches the backend', true, 0],
      ['the built-in agent, private on a confidential model', false, 1],
    ])('creates a new thread on %s', async (_label, onHostedAgent, isEncrypted) => {
      const confidentialModelId = uuidv7()
      await getDb().insert(modelsTable).values({
        id: confidentialModelId,
        provider: 'tinfoil',
        name: 'Confidential Model',
        model: 'confidential-model',
        isSystem: 1,
        enabled: 1,
        isConfidential: 1,
        contextWindow: 131072,
        toolUsage: 1,
        startWithReasoning: 0,
        deletedAt: null,
        url: null,
        defaultHash: null,
      })
      if (onHostedAgent) {
        await seedDiscoveredDefault()
      }
      const threadId = uuidv7()
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: true }), { wrapper: TestWrapper })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      const confidentialModel = await getModel(getDb(), confidentialModelId)
      useChatStore.getState().updateSession(threadId, { selectedModel: confidentialModel! })

      await act(async () => {
        await result.current.saveMessages({ id: threadId, messages: [createTestMessage()] })
      })

      expect(getCurrentSession()?.selectedAgent.type).toBe(onHostedAgent ? 'managed-http' : 'built-in')
      expect((await getThread(getDb(), threadId))?.isEncrypted).toBe(isEncrypted)
    })

    it.each(['project-b', null])(
      'keeps first-save membership consistent when a move to %s starts first',
      async (projectId) => {
        if (projectId) {
          await getDb().insert(projectsTable).values({ id: projectId, name: 'Move target' })
        }
        const id = uuidv7()
        const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true, projectId: 'project-a' }), {
          wrapper: TestWrapper,
        })
        await act(async () => {
          await result.current.hydrateChatStore()
        })
        const wroteProject = Promise.withResolvers<void>()
        const releaseMove = Promise.withResolvers<void>()
        await act(async () => {
          const moving = moveChatToProject(
            { chatThreadId: id, projectId },
            {
              db: getDb(),
              setProject: async (...args) => {
                const assigned = await setChatThreadProject(...args)
                wroteProject.resolve()
                await releaseMove.promise
                return assigned
              },
              updateOpenSession: (chatThreadId, nextProjectId) =>
                useChatStore.getState().updateSession(chatThreadId, { projectId: nextProjectId }),
              refreshChatList: async () => {},
            },
          )
          await wroteProject.promise
          const saving = result.current.saveMessages({ id, messages: [createTestMessage()] })
          releaseMove.resolve()
          await Promise.all([moving, saving])
        })
        expect((await getThread(getDb(), id))?.projectId).toBe(projectId)
        expect(getCurrentSession()?.projectId).toBe(projectId)
      },
    )

    it.each(['project-b', null])(
      'keeps first-save membership consistent when a move to %s starts during insertion',
      async (projectId) => {
        if (projectId) {
          await getDb().insert(projectsTable).values({ id: projectId, name: 'Move target' })
        }
        const id = uuidv7()
        const { result } = renderHook(() => useHydrateChatStore({ id, isNew: true, projectId: 'project-a' }), {
          wrapper: TestWrapper,
        })
        await act(async () => {
          await result.current.hydrateChatStore()
        })
        const moved = Promise.withResolvers<void>()
        const db = getDb()
        const insert = db.insert.bind(db)
        // Start the move after saveMessages has read the old project but before
        // the thread's insert is executed, so an uncoordinated UPDATE finds no row.
        const insertSpy = spyOn(db, 'insert').mockImplementation((table) => {
          if (Object.is(table, chatThreadsTable)) {
            moved.resolve(
              moveChatToProject(
                { chatThreadId: id, projectId },
                {
                  db,
                  setProject: setChatThreadProject,
                  updateOpenSession: (chatThreadId, nextProjectId) =>
                    useChatStore.getState().updateSession(chatThreadId, { projectId: nextProjectId }),
                  refreshChatList: async () => {},
                },
              ),
            )
          }
          return insert(table)
        })
        try {
          await act(async () => {
            await result.current.saveMessages({ id, messages: [createTestMessage()] })
            await moved.promise
          })
          expect((await getThread(db, id))?.projectId).toBe(projectId)
          expect(getCurrentSession()?.projectId).toBe(projectId)
        } finally {
          insertSpy.mockRestore()
        }
      },
    )

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

    it('persists selectedAgent.id on the thread row when the first message creates it', async () => {
      // Regression test for: agent selection on a brand-new chat (no thread row
      // yet) was lost on reload because `createChatThread` was called without
      // `agentId`. The fix is to thread `selectedAgent.id` through
      // `getOrCreateChatThread`, which `saveMessages` calls on every message.
      await createSystemModel()
      const threadId = uuidv7()

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: true }), {
        wrapper: TestWrapper,
      })

      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const customAgent = {
        id: 'haystack-rag',
        name: 'Haystack',
        type: 'managed-acp' as const,
        transport: 'websocket' as const,
        url: 'wss://example.test',
        description: null,
        icon: null,
        isSystem: 1 as const,
        enabled: 1 as const,
        deletedAt: null,
        userId: null,
      }

      await act(async () => {
        await useChatStore.getState().setSelectedAgent(threadId, customAgent)
      })

      await act(async () => {
        await result.current.saveMessages({
          id: threadId,
          messages: [createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'First message' }] })],
        })
      })

      // The newly-created thread row should carry the agent the user picked.
      const stored = await getThread(getDb(), threadId)
      expect(stored?.agentId).toBe('haystack-rag')
    })

    it('should save messages when model is selected', async () => {
      const systemModelId = await createSystemModel()
      const threadId = await createTestThread(systemModelId)

      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })

      // Hydrate to set up the store with a model
      await act(async () => {
        await result.current.hydrateChatStore()
      })

      const newMessages: ThunderboltUIMessage[] = [
        createTestMessage({ role: 'user', parts: [{ type: 'text', text: 'Test message' }] }),
      ]

      await act(async () => {
        await result.current.saveMessages({ id: threadId, messages: newMessages })
      })

      // Verify no error was thrown
      expect(result.current.saveMessages).toBeDefined()
    })

    it('preserves current context for historical edits and updates it for ordinary saves', async () => {
      const modelId = await createSystemModel()
      const threadId = await createTestThread(modelId)
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
        wrapper: TestWrapper,
      })
      const message = createTestMessage({ role: 'assistant', metadata: { contextTokens: 2000 } })
      await act(async () => {
        await result.current.hydrateChatStore()
        await result.current.saveMessages({ id: threadId, messages: [message] })
        await result.current.saveMessages({
          id: threadId,
          messages: [{ ...message, metadata: { contextTokens: 500 } }],
          updateContext: false,
        })
      })
      expect((await getThread(getDb(), threadId))?.contextSize).toBe(2000)

      await act(async () => {
        await result.current.saveMessages({
          id: threadId,
          messages: [{ ...message, metadata: { contextTokens: 600 } }],
        })
      })
      expect((await getThread(getDb(), threadId))?.contextSize).toBe(600)
    })
  })
  describe('navigation on create', () => {
    /** Renders nothing; mirrors the router's current path into `seen`. */
    const makeRouterWrapper = (initialPath: string, seen: { path: string }) => {
      const LocationProbe = () => {
        seen.path = useLocation().pathname
        return null
      }
      return ({ children }: { children: ReactNode }) => {
        const queryWrapper = createQueryTestWrapper()
        return createElement(
          MemoryRouter,
          { initialEntries: [initialPath] },
          createElement(LocationProbe),
          createElement(queryWrapper, null, createElement(MCPProvider, null, children)),
        )
      }
    }

    const hydrateAndSave = async (threadId: string, wrapper: ReturnType<typeof makeRouterWrapper>) => {
      const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: true }), {
        wrapper,
      })
      await act(async () => {
        await result.current.hydrateChatStore()
      })
      await act(async () => {
        await result.current.saveMessages({ id: threadId, messages: [createTestMessage()] })
      })
    }

    it('navigates to the new thread on first save by default', async () => {
      await createSystemModel()
      const threadId = uuidv7()
      const seen = { path: '' }

      await hydrateAndSave(threadId, makeRouterWrapper('/chats/new', seen))

      expect(seen.path).toBe(`/chats/${threadId}`)
    })
  })
})
