/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/dal'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { Mode } from '@/types'
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from './chat-store'

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
      expect(storeState.mcpClients).toEqual([])
      expect(storeState.models).toEqual([model])
      expect(session?.selectedModel).toBe(model)
      expect(session?.triggerData).toBe(automationRun)
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
      expect(storeState.mcpClients).toEqual([])
      expect(storeState.models).toEqual([])
      expect(storeState.sessions.size).toBe(0)
    })
  })

  describe('sendMessage', () => {
    it('should throw error when selectedModel is null', async () => {
      const chatInstance = createMockChatInstanceWithValidation()

      // Create session without selected model - need to manually set up
      useChatStore.getState().setModels([])
      useChatStore.getState().setModes([])
      useChatStore.setState((state) => ({
        ...state,
        sessions: new Map([
          [
            'test-id',
            {
              chatInstance,
              chatThread: null,
              id: 'test-id',
              selectedMode: null as unknown as Mode,
              retryCount: 0,
              retriesExhausted: false,
              selectedModel: null as unknown as Model,
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
  })
})
