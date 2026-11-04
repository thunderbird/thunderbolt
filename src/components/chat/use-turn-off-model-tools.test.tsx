/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { createModel, getModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import type { Model } from '@/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { useTurnOffModelTools } from './use-turn-off-model-tools'

const sessionId = 'session-1'
const modelId = 'gemma-model'

/** Saves a tools-on model and opens a chat session on it. */
const setUpChatOnToolsModel = async (): Promise<Model> => {
  const db = getDb()
  await createModel(db, {
    id: modelId,
    provider: 'custom',
    name: 'Gemma',
    model: 'gemma3:4b',
    url: 'http://localhost:11434/v1',
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
  })
  const savedModel = await getModel(db, modelId)
  if (!savedModel) {
    throw new Error('Fixture model was not saved')
  }
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: null,
    id: sessionId,
    models: [savedModel],
    selectedModel: savedModel,
    triggerData: null,
  })
  return savedModel
}

describe('useTurnOffModelTools', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  it('saves tools off and swaps the model into the session before retrying', async () => {
    await setUpChatOnToolsModel()
    const toolUsageSeenByRetry: Array<number | null | undefined> = []
    const regenerate = mock(() => {
      toolUsageSeenByRetry.push(useChatStore.getState().sessions.get(sessionId)?.selectedModel.toolUsage)
    })
    const { result } = renderHook(() => useTurnOffModelTools({ regenerate }), { wrapper: createTestProvider() })

    await act(async () => {
      result.current.turnOffTools(sessionId)
      await getClock().runAllAsync()
    })

    expect((await getModel(getDb(), modelId))?.toolUsage).toBe(0)
    expect(toolUsageSeenByRetry).toEqual([0])
    expect(result.current.isTurningOffTools).toBe(false)
  })

  it('keeps a model the user picked while the save was running', async () => {
    const savedModel = await setUpChatOnToolsModel()
    const pickedModel = { ...savedModel, id: 'llama-model', model: 'llama3.2:3b' }
    const db = getDb()
    const runTransaction = db.transaction.bind(db)
    const transactionSpy = spyOn(db, 'transaction').mockImplementation(((
      ...args: Parameters<typeof db.transaction>
    ) => {
      useChatStore.getState().updateSession(sessionId, { selectedModel: pickedModel })
      return runTransaction(...args)
    }) as typeof db.transaction)
    const { result } = renderHook(() => useTurnOffModelTools({ regenerate: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    try {
      await act(async () => {
        result.current.turnOffTools(sessionId)
        await getClock().runAllAsync()
      })

      expect((await getModel(db, modelId))?.toolUsage).toBe(0)
      expect(useChatStore.getState().sessions.get(sessionId)?.selectedModel.id).toBe('llama-model')
    } finally {
      transactionSpy.mockRestore()
    }
  })

  it('changes nothing when the chat is gone', async () => {
    await setUpChatOnToolsModel()
    resetStore()
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const regenerate = mock(() => {})
    const { result } = renderHook(() => useTurnOffModelTools({ regenerate }), { wrapper: createTestProvider() })

    try {
      await act(async () => {
        result.current.turnOffTools(sessionId)
        await getClock().runAllAsync()
      })

      expect((await getModel(getDb(), modelId))?.toolUsage).toBe(1)
      expect(regenerate).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith('Failed to turn off tools for the model.', expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })
})
