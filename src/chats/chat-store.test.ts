/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/dal'
import { getChatThread } from '@/dal/chat-threads'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import type { ChatThread } from '@/types'
import {
  createMockAutomationRun,
  createMockChatInstanceWithValidation,
  createMockChatThread,
  createMockModel,
  getCurrentSession,
  hydrateStore,
  resetStore,
} from '@/test-utils/chat-store-mocks'
import type { Model, ThunderboltUIMessage } from '@/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { deriveToolKey, findAllowOption, useChatStore } from './chat-store'

describe('chat-store', () => {
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
  })

  afterEach(async () => {
    // Ensure store is reset after each test to prevent test pollution
    resetStore()
  })

  describe('createSession', () => {
    it('should set all state values correctly', () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const chatThread = createMockChatThread()
      const model = createMockModel()
      const automationRun = createMockAutomationRun()

      hydrateStore({
        chatInstance,
        chatThread,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: automationRun,
      })

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session?.chatInstance).toBe(chatInstance)
      expect(session?.chatThread).toBe(chatThread)
      expect(session?.id).toBe('test-id')
      expect(storeState.getMcpClients()).toEqual([])
      expect(storeState.models).toEqual([model])
      expect(session?.selectedModel).toBe(model)
      expect(session?.triggerData).toBe(automationRun)
    })
  })

  describe('project membership on a session', () => {
    it('carries the thread’s project so the header badge can read it', () => {
      const chatThread = createMockChatThread()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: { ...chatThread, projectId: 'proj-1' },
        id: 'test-id',
        selectedModel: createMockModel(),
        triggerData: null,
      })
      expect(getCurrentSession()?.projectId).toBe('proj-1')
    })

    it('updates in place when a chat is dragged into a project', () => {
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: createMockChatThread(),
        id: 'test-id',
        selectedModel: createMockModel(),
        triggerData: null,
      })
      expect(getCurrentSession()?.projectId).toBeNull()

      useChatStore.getState().updateSession('test-id', { projectId: 'proj-1' })
      expect(getCurrentSession()?.projectId).toBe('proj-1')
    })

    it('throws for a chat that has no open session — callers must guard', () => {
      // The sidebar drop handler relies on this: dragging a chat that was never
      // opened this run must not blow up the drop.
      expect(() => useChatStore.getState().updateSession('never-opened', { projectId: 'p' })).toThrow()
    })
  })

  describe('reset', () => {
    it('should reset store to initial state', () => {
      // First hydrate with some data
      const chatInstance = createMockChatInstanceWithValidation()
      const model = createMockModel()

      hydrateStore({
        chatInstance,
        chatThread: createMockChatThread(),
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: createMockAutomationRun(),
      })

      // Then reset
      resetStore()

      const session = getCurrentSession()
      const storeState = useChatStore.getState()

      expect(session).toBeNull()
      expect(storeState.currentSessionId).toBeNull()
      expect(storeState.getMcpClients()).toEqual([])
      expect(storeState.models).toEqual([])
      expect(storeState.sessions.size).toBe(0)
    })
  })

  describe('sendMessage', () => {
    it('should throw error when selectedModel is null', async () => {
      const chatInstance = createMockChatInstanceWithValidation()

      // Create session without selected model - need to manually set up
      useChatStore.getState().setModels([])
      useChatStore.setState((state) => ({
        ...state,
        sessions: new Map([
          [
            'test-id',
            {
              chatInstance,
              chatThread: null,
              connectionStatus: 'idle' as const,
              connectionError: null,
              id: 'test-id',
              pendingPermission: null,
              miniAppApprovalQueue: [],
              selectedAgent: builtInAgent,
              agentChosenByUser: false,
              retryCount: 0,
              retriesExhausted: false,
              stopping: false,
              selectedModel: null as unknown as Model,
              projectId: null,
              miniAppId: null,
              triggerData: null,
            },
          ],
        ]),
        currentSessionId: 'test-id',
      }))

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow('No selected model')
    })

    it('should throw error when chatThread encryption does not match model confidentiality', async () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const encryptedThread = createMockChatThread({ isEncrypted: 1 })
      const nonConfidentialModel = createMockModel({ isConfidential: 0 })

      hydrateStore({
        chatInstance,
        chatThread: encryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [nonConfidentialModel],
        selectedModel: nonConfidentialModel,
        triggerData: null,
      })

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'This model is not available for encrypted conversations.',
      )
    })

    it('should throw error when unencrypted thread is used with confidential model', async () => {
      const chatInstance = createMockChatInstanceWithValidation()
      const unencryptedThread = createMockChatThread({ isEncrypted: 0 })
      const confidentialModel = createMockModel({ isConfidential: 1 })

      hydrateStore({
        chatInstance,
        chatThread: unencryptedThread,
        id: 'test-id',
        mcpClients: [],
        models: [confidentialModel],
        selectedModel: confidentialModel,
        triggerData: null,
      })

      const session = getCurrentSession()
      await expect(session?.chatInstance?.sendMessage({ text: 'test message' })).rejects.toThrow(
        'This model is not available for unencrypted conversations.',
      )
    })

    it('should send message successfully when all conditions are met', async () => {
      const model = createMockModel()
      const messages: ThunderboltUIMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ]
      const chatInstanceWithMessages = createMockChatInstanceWithValidation(messages)

      hydrateStore({
        chatInstance: chatInstanceWithMessages,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      const session = getCurrentSession()
      await session?.chatInstance?.sendMessage({ text: 'test message' })

      expect(chatInstanceWithMessages._originalSendMessage).toHaveBeenCalledWith({
        text: 'test message',
      })

      // trackEvent is called but we don't verify it to avoid module mocking
      // The function is safe to call and won't throw even if posthogClient is null
    })

    it('should track event with correct prompt number', async () => {
      const messages: ThunderboltUIMessage[] = [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'First' }] },
        { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Response' }] },
        { id: 'msg-3', role: 'user', parts: [{ type: 'text', text: 'Second' }] },
      ]
      const chatInstance = createMockChatInstanceWithValidation(messages)
      const model = createMockModel()

      hydrateStore({
        chatInstance,
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      const session = getCurrentSession()
      await session?.chatInstance?.sendMessage({ text: 'third message' })

      // Verify sendMessage was called with correct parameters
      expect(chatInstance._originalSendMessage).toHaveBeenCalledWith({
        text: 'third message',
      })

      // trackEvent is called but we don't verify it to avoid module mocking
    })
  })

  describe('setSelectedModel', () => {
    it('should throw error when model is not found', async () => {
      const model1 = createMockModel({ id: 'model-1' })
      const model2 = createMockModel({ id: 'model-2' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await expect(useChatStore.getState().setSelectedModel('test-id', 'nonexistent-model')).rejects.toThrow(
        'Model not found',
      )
    })

    it('should set selected model and update settings', async () => {
      const model1 = createMockModel({ id: 'model-1', name: 'Model 1' })
      const model2 = createMockModel({ id: 'model-2', name: 'Model 2' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model1, model2],
        selectedModel: model1,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'model-2')

      const session = getCurrentSession()
      expect(session?.selectedModel).toBe(model2)
      expect(session?.selectedModel?.id).toBe('model-2')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('model-2')
    })

    it('should update settings with correct model id', async () => {
      const model = createMockModel({ id: 'custom-model-id' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', 'custom-model-id')

      // Verify updateSettings was called by checking the database
      const settings = await getSettings(getDb(), { selected_model: String })
      expect(settings.selectedModel).toBe('custom-model-id')
    })

    it('should complete without errors when setting model', async () => {
      const model = createMockModel({ id: 'tracked-model' })

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      // trackEvent is called but we don't verify it to avoid module mocking
      // The function is safe to call and won't throw even if posthogClient is null
      await useChatStore.getState().setSelectedModel('test-id', 'tracked-model')

      const session = getCurrentSession()
      expect(session?.selectedModel?.id).toBe('tracked-model')
    })

    it('invokes the prewarm wrapper with the selected model (wrapper owns the tinfoil/system guard)', async () => {
      const model = createMockModel({ id: 'tinfoil-system-model', provider: 'tinfoil', isSystem: 1 })
      const prewarmSystemModel = mock(async () => {})

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedModel('test-id', model.id, { prewarmSystemModel })

      expect(prewarmSystemModel).toHaveBeenCalledTimes(1)
      expect(prewarmSystemModel).toHaveBeenCalledWith(model)
    })

    it('does not propagate prewarm errors into model selection', async () => {
      const model = createMockModel({ id: 'tinfoil-system-model', provider: 'tinfoil', isSystem: 1 })
      const prewarmFailure = Promise.reject(new Error('attestation failed'))
      void prewarmFailure.catch(() => undefined)
      const prewarmSystemModel = mock(() => prewarmFailure)

      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'test-id',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await expect(
        useChatStore.getState().setSelectedModel('test-id', model.id, { prewarmSystemModel }),
      ).resolves.toBeUndefined()
      expect(prewarmSystemModel).toHaveBeenCalledTimes(1)
      expect(getCurrentSession()?.selectedModel).toBe(model)
    })
  })

  describe('setSelectedAgent', () => {
    const customAgent = {
      id: 'custom-agent-1',
      name: 'My Agent',
      type: 'remote-acp' as const,
      transport: 'websocket' as const,
      url: 'wss://example.test/ws',
      description: null,
      icon: null,
      isSystem: 0 as const,
      enabled: 1 as const,
      deletedAt: null,
      userId: 'u1',
    }

    /** Seeds a persisted thread and matching hydrated chat session. */
    const seedThreadSession = async (id: string, agent: Agent, acpSessionId: string): Promise<ChatThread> => {
      const model = createMockModel()
      const chatThread = createMockChatThread({ id, agentId: agent.id, acpSessionId })
      await getDb().insert(chatThreadsTable).values({ id, title: 'x', agentId: agent.id, acpSessionId })
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread,
        id,
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })
      useChatStore.getState().updateSession(id, { selectedAgent: agent })
      return chatThread
    }

    it('updates the in-memory session selectedAgent', async () => {
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedAgent('thread-1', customAgent)

      const session = getCurrentSession()
      expect(session?.selectedAgent.id).toBe(customAgent.id)
    })

    it('switches the thread agent and clears its ACP session in memory and storage', async () => {
      const chatThread = await seedThreadSession('thread-persist', builtInAgent, 'session-from-previous-agent')

      await useChatStore.getState().setSelectedAgent(chatThread.id, customAgent)

      const session = getCurrentSession()
      const stored = await getChatThread(getDb(), chatThread.id)
      expect(session?.chatThread?.agentId).toBe(customAgent.id)
      expect(session?.chatThread?.acpSessionId).toBeNull()
      expect(stored?.agentId).toBe(customAgent.id)
      expect(stored?.acpSessionId).toBeNull()
    })

    it('preserves the ACP session when selecting the current agent', async () => {
      const chatThread = await seedThreadSession('thread-same-agent', customAgent, 'current-session')

      await useChatStore.getState().setSelectedAgent(chatThread.id, customAgent)

      expect(getCurrentSession()?.chatThread?.acpSessionId).toBe('current-session')
      expect((await getChatThread(getDb(), chatThread.id))?.acpSessionId).toBe('current-session')
    })

    it('refreshes active agent wire identity and clears matching in-memory ACP sessions', async () => {
      await seedThreadSession('thread-wire-edit', customAgent, 'stale-session')

      useChatStore.getState().applyAgentWireIdentityChange({ ...customAgent, url: 'wss://new.example.test/ws' })

      expect(getCurrentSession()?.selectedAgent.url).toBe('wss://new.example.test/ws')
      expect(getCurrentSession()?.chatThread?.acpSessionId).toBeNull()
    })

    describe('applyDiscoveredDefaultAgent', () => {
      const model = createMockModel()
      const newChat = { chatThread: null, mcpClients: [], models: [model], selectedModel: model, triggerData: null }
      const hydrateNewChat = (id: string) =>
        hydrateStore({ ...newChat, id, chatInstance: createMockChatInstanceWithValidation() })
      const hostedDefault: Agent = { ...customAgent, id: 'hosted-agent', isSystem: 1 }
      const agentOf = (id: string) => useChatStore.getState().sessions.get(id)?.selectedAgent.id

      it('moves only unstarted new chats on the fallback chain onto the discovered default', async () => {
        const startedMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as ThunderboltUIMessage
        hydrateNewChat('unstarted')
        hydrateStore({
          ...newChat,
          id: 'sending',
          chatInstance: createMockChatInstanceWithValidation([startedMessage]),
        })
        await seedThreadSession('persisted', builtInAgent, 'persisted-session')

        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, hostedDefault], {})

        expect(agentOf('unstarted')).toBe(hostedDefault.id)
        expect(agentOf('sending')).toBe(builtInAgent.id)
        expect(agentOf('persisted')).toBe(builtInAgent.id)
      })

      it("leaves an unstarted chat on the user's last-used agent", () => {
        hydrateNewChat('last-used')

        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, hostedDefault], {
          lastUsedAgentId: builtInAgent.id,
        })

        expect(agentOf('last-used')).toBe(builtInAgent.id)
      })

      it('leaves every unstarted chat whose agent the user picked, not only the latest pick', async () => {
        const laterPick: Agent = { ...customAgent, id: 'later-pick' }
        hydrateNewChat('first-pick')
        hydrateNewChat('second-pick')
        await useChatStore.getState().setSelectedAgent('first-pick', customAgent)
        await useChatStore.getState().setSelectedAgent('second-pick', laterPick)

        // `selected_agent` now remembers only the later pick.
        useChatStore
          .getState()
          .applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, customAgent, laterPick, hostedDefault], {
            lastUsedAgentId: laterPick.id,
          })

        expect(agentOf('first-pick')).toBe(customAgent.id)
        expect(agentOf('second-pick')).toBe(laterPick.id)
      })

      it('leaves an unstarted chat whose model the user picked before discovery landed', async () => {
        hydrateNewChat('model-pick')
        await useChatStore.getState().setSelectedModel('model-pick', model.id)

        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, hostedDefault], {})

        expect(agentOf('model-pick')).toBe(builtInAgent.id)
      })

      it("moves a chat to the user's synced pick once discovery seeds it, not to the default", () => {
        // On a fresh device the synced `selected_agent` names a system agent that
        // isn't seeded yet, so hydration fell back to the built-in.
        const syncedPick: Agent = { ...customAgent, id: 'synced-system-pick', isSystem: 1 }
        hydrateNewChat('synced-pick')

        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, syncedPick, hostedDefault], {
          lastUsedAgentId: syncedPick.id,
        })

        expect(agentOf('synced-pick')).toBe(syncedPick.id)
      })

      it('records the discovered default for chats that hydrate later, and forgets it on null', () => {
        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, hostedDefault], {})
        expect(useChatStore.getState().agentDiscovery).toMatchObject({ status: 'done', defaultAgent: hostedDefault })

        useChatStore.getState().applyDiscoveredDefaultAgent(null, [builtInAgent], {})
        expect(useChatStore.getState().agentDiscovery).toMatchObject({ status: 'done', defaultAgent: null })
      })

      it('moves unstarted chats off a cleared default through the fallback chain, but not picked ones', async () => {
        const lastUsedAgent: Agent = { ...customAgent, id: 'last-used-agent' }
        hydrateNewChat('moved')
        hydrateNewChat('picked')
        useChatStore.getState().applyDiscoveredDefaultAgent(hostedDefault, [builtInAgent, hostedDefault], {})
        await useChatStore.getState().setSelectedAgent('picked', hostedDefault)

        // Discovery now answers 403: the hosted agent's row is gone.
        useChatStore
          .getState()
          .applyDiscoveredDefaultAgent(null, [builtInAgent, lastUsedAgent], { lastUsedAgentId: lastUsedAgent.id })

        expect(agentOf('moved')).toBe(lastUsedAgent.id)
        expect(agentOf('picked')).toBe(hostedDefault.id)
      })

      it('moves a chat off a cleared default it only knew from the deleted row', () => {
        hydrateNewChat('from-row')
        // Hydration resolved the default from `is_default`; this boot's discovery never set the store copy.
        useChatStore.getState().updateSession('from-row', { selectedAgent: hostedDefault })

        useChatStore.getState().applyDiscoveredDefaultAgent(null, [builtInAgent], {})

        expect(agentOf('from-row')).toBe(builtInAgent.id)
      })
    })

    it('updates in-memory state and skips the DB write when no chat thread exists yet', async () => {
      // For brand-new chats (no `chat_threads` row yet) the selection is held
      // in memory until the first message is sent. Persistence happens inside
      // `getOrCreateChatThread` — see `use-hydrate-chat-store.ts` saveMessages.
      // This test covers the pre-first-message path only.
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-no-row',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      // Should not throw despite no DB row existing.
      await useChatStore.getState().setSelectedAgent('thread-no-row', customAgent)

      const session = getCurrentSession()
      expect(session?.selectedAgent.id).toBe(customAgent.id)

      // Verify no row was created behind the scenes.
      const stored = await getChatThread(getDb(), 'thread-no-row')
      expect(stored).toBeNull()
    })

    it('persists the global last-used agent in settings so new chats default to it', async () => {
      const model = createMockModel()
      hydrateStore({
        chatInstance: createMockChatInstanceWithValidation(),
        chatThread: null,
        id: 'thread-1',
        mcpClients: [],
        models: [model],
        selectedModel: model,
        triggerData: null,
      })

      await useChatStore.getState().setSelectedAgent('thread-1', customAgent)

      const settings = await getSettings(getDb(), { selected_agent: String })
      expect(settings.selectedAgent).toBe(customAgent.id)
    })

    describe('model on a switch to the built-in agent', () => {
      const hostedAgent: Agent = { ...customAgent, id: 'hosted-agent', type: 'managed-http', transport: 'http' }
      const confidentialModel = createMockModel({
        id: 'confidential',
        provider: 'tinfoil',
        isSystem: 1,
        isConfidential: 1,
      })
      const standardModel = createMockModel({ id: 'standard', provider: 'thunderbolt', isConfidential: 0 })

      /** A hosted-agent thread (never private) whose session holds `selectedModel`. */
      const seedHostedThread = async (models: Model[], selectedModel: Model) => {
        await getDb().insert(chatThreadsTable).values({ id: 'hosted-thread', title: 'x', agentId: hostedAgent.id })
        hydrateStore({
          chatInstance: createMockChatInstanceWithValidation(),
          chatThread: createMockChatThread({ id: 'hosted-thread', agentId: hostedAgent.id, isEncrypted: 0 }),
          id: 'hosted-thread',
          mcpClients: [],
          models,
          selectedModel,
          triggerData: null,
        })
        useChatStore.getState().updateSession('hosted-thread', { selectedAgent: hostedAgent })
      }

      it('swaps a confidential model for a compatible one so the next send goes through', async () => {
        await seedHostedThread([confidentialModel, standardModel], confidentialModel)

        await useChatStore.getState().setSelectedAgent('hosted-thread', builtInAgent)

        expect(getCurrentSession()?.selectedModel.id).toBe(standardModel.id)
        const chatInstance = getCurrentSession()!.chatInstance as ReturnType<
          typeof createMockChatInstanceWithValidation
        >
        await chatInstance.sendMessage({ text: 'hello' })
        expect(chatInstance._originalSendMessage).toHaveBeenCalledTimes(1)
      })

      it('leaves a model that already matches the thread alone', async () => {
        const otherStandard = createMockModel({ id: 'other-standard', provider: 'thunderbolt' })
        await seedHostedThread([standardModel, otherStandard], otherStandard)

        await useChatStore.getState().setSelectedAgent('hosted-thread', builtInAgent)

        expect(getCurrentSession()?.selectedModel.id).toBe(otherStandard.id)
      })

      it('keeps the model when no compatible one exists, for the composer to hold the send', async () => {
        await seedHostedThread([confidentialModel], confidentialModel)

        await useChatStore.getState().setSelectedAgent('hosted-thread', builtInAgent)

        expect(getCurrentSession()?.selectedModel.id).toBe(confidentialModel.id)
      })
    })

    it('throws when the session is missing', async () => {
      await expect(useChatStore.getState().setSelectedAgent('nope', customAgent)).rejects.toThrow('No session found')
    })
  })

  describe('session permission allowances', () => {
    afterEach(() => {
      useChatStore.setState({ alwaysAllowedAgentIds: new Set(), alwaysAllowedAgentToolKeys: new Set() })
    })

    it('limits an action-kind allowance to the matching kind and agent', () => {
      const { allowAlwaysForTool, isAlwaysAllowed } = useChatStore.getState()

      allowAlwaysForTool('agent-a', 'read')

      expect(isAlwaysAllowed('agent-a', 'read')).toBe(true)
      expect(isAlwaysAllowed('agent-a', 'edit')).toBe(false)
      expect(isAlwaysAllowed('agent-b', 'read')).toBe(false)
    })

    it('allows every tool for an allowed agent without affecting other agents', () => {
      const { allowAlwaysForAgent, isAlwaysAllowed } = useChatStore.getState()

      allowAlwaysForAgent('agent-wholesale')

      expect(isAlwaysAllowed('agent-wholesale', 'read')).toBe(true)
      expect(isAlwaysAllowed('agent-wholesale', 'edit')).toBe(true)
      expect(isAlwaysAllowed('agent-other', 'read')).toBe(false)
    })
  })

  describe('permission request helpers', () => {
    it('derives a tool key from kind regardless of the argument-bearing title', () => {
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/passwd', kind: 'read' } } as never)).toBe('read')
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/shadow', kind: 'read' } } as never)).toBe('read')
      expect(deriveToolKey({ toolCall: { title: 'Read /etc/passwd', kind: 'execute' } } as never)).toBe('execute')
      expect(deriveToolKey({ toolCall: {} } as never)).toBe('unknown')
    })

    it('prefers allow-once, falls back to allow-always, and rejects non-allow options', () => {
      const allowAlways = { optionId: 'always', name: 'Always', kind: 'allow_always' } as const
      const allowOnce = { optionId: 'once', name: 'Once', kind: 'allow_once' } as const

      expect(findAllowOption([allowAlways, allowOnce])).toBe(allowOnce)
      expect(findAllowOption([allowAlways])).toBe(allowAlways)
      expect(findAllowOption([{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }])).toBeUndefined()
    })
  })
})
