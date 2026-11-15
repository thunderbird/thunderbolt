/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createTestProvider } from '@/test-utils/test-provider'
import type { Model } from '@/types'
import { getDb } from '@/db/database'
import { saveProviderConnection } from '@/dal/provider-connections'
import * as providerModels from '@/providers/models'
import * as modelCatalog from './model-catalog'
import { createModel, getModel, updateModel } from '@/dal/models'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { useEditModelFormState } from './use-edit-model-form-state'

const completion = () =>
  Response.json({
    id: 'completion-id',
    object: 'chat.completion',
    created: 1,
    model: 'gemma3:4b',
    choices: [{ index: 0, message: { role: 'assistant', content: 'test successful' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  })

/** A provider answering chat completions; with `acceptsTools: false` it rejects tools as Ollama does. */
const providerFetch = ({ acceptsTools }: { acceptsTools: boolean }): FetchFn =>
  Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      !acceptsTools && String(init?.body).includes('"tools"')
        ? Response.json({ error: { message: 'gemma3:4b does not support tools' } }, { status: 400 })
        : completion(),
    { preconnect: async () => true },
  )

const savedModel: Model = {
  id: 'model-1',
  name: 'Gemma',
  provider: 'custom',
  model: 'gemma3:4b',
  url: 'https://models.example.com/v1',
  apiKey: null,
  isSystem: 0,
  enabled: 1,
  toolUsage: 1,
  isConfidential: 0,
  startWithReasoning: 0,
  reasoningEffort: null,
  supportsParallelToolCalls: 1,
  contextWindow: null,
  deletedAt: null,
  defaultHash: null,
  vendor: null,
  description: null,
  userId: null,
}

const renderEditState = (model: Model, proxyFetch: FetchFn) =>
  renderHook(() => useEditModelFormState(model), { wrapper: createTestProvider({ proxyFetch }) })

describe('useEditModelFormState tool support', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    mock.restore()
    await resetTestDatabase()
  })

  it('starts from the saved tool setting', () => {
    const { result } = renderEditState({ ...savedModel, toolUsage: 0 }, providerFetch({ acceptsTools: true }))

    expect(result.current.form.getValues('supportsTools')).toBe(false)
  })

  it('repairs an unchanged model whose test finds it rejects tools', async () => {
    const { result } = renderEditState(savedModel, providerFetch({ acceptsTools: false }))
    expect(result.current.isSaveDisabled).toBe(true)

    await act(async () => {
      await result.current.testConnection()
    })

    expect(result.current.connection.toolSupport).toBe('unsupported')
    expect(result.current.isSaveDisabled).toBe(false)
    expect(result.current.submissionFor(result.current.form.getValues()).toolUsage).toBe(0)
  })

  it('keeps Save disabled when the test agrees with the saved setting', async () => {
    const { result } = renderEditState(savedModel, providerFetch({ acceptsTools: true }))

    await act(async () => {
      await result.current.testConnection()
    })

    expect(result.current.connection.toolSupport).toBe('supported')
    expect(result.current.isSaveDisabled).toBe(true)
  })

  it('saves a hand-flipped switch without requiring a test', () => {
    const { result } = renderEditState(savedModel, providerFetch({ acceptsTools: true }))

    act(() => {
      result.current.changeSupportsTools(false)
    })

    expect(result.current.isSaveDisabled).toBe(false)
    expect(result.current.submissionFor(result.current.form.getValues()).toolUsage).toBe(0)
  })

  describe('saved API key after a URL edit', () => {
    /** A provider that records the URL and Authorization header of each request. */
    const recordingFetch = () => {
      const requests: Array<{ url: string; authorization: string | null }> = []
      const fetch: FetchFn = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
          return completion()
        },
        { preconnect: async () => true },
      )
      return { fetch, requests }
    }
    const keyedModel: Model = { ...savedModel, apiKey: 'sk-saved' }

    it('tests a new destination without the saved key', async () => {
      const { fetch, requests } = recordingFetch()
      const { result } = renderEditState(keyedModel, fetch)

      act(() => result.current.changeUrl('https://evil.example.com/v1'))
      await act(async () => {
        await result.current.testConnection()
      })

      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(({ url }) => url.startsWith('https://evil.example.com/v1/'))).toBe(true)
      expect(requests.every(({ authorization }) => authorization === null)).toBe(true)
      expect(result.current.hasStoredApiKey).toBe(false)
      expect(result.current.isStoredApiKeyLeftBehind).toBe(true)
    })

    it('keeps the saved key for another spelling of the same URL', async () => {
      const { fetch, requests } = recordingFetch()
      const { result } = renderEditState(keyedModel, fetch)

      act(() => result.current.changeUrl('https://MODELS.example.com:443/v1/'))
      await act(async () => {
        await result.current.testConnection()
      })

      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(({ authorization }) => authorization === 'Bearer sk-saved')).toBe(true)
      expect(result.current.isStoredApiKeyLeftBehind).toBe(false)
    })
  })

  it('loads the current connection catalog only after explicitly opening the model selector', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Work',
      authMethod: 'api_key',
      credentials: { apiKey: 'local-key' },
    })
    const fetch = spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([
      { id: 'replacement', name: 'Replacement' },
    ])
    const { result } = renderEditState(
      { ...savedModel, provider: 'openai', providerConnectionId: id },
      providerFetch({ acceptsTools: true }),
    )
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => {
      result.current.loadCatalog()
      await getClock().runAllAsync()
    })
    expect(fetch).toHaveBeenCalledWith(getDb(), id, expect.any(Function))
    expect(result.current.modelItems.some((item) => item.id === 'replacement')).toBe(true)
    act(() => result.current.selectModel('replacement'))
    expect(result.current.submissionFor(result.current.form.getValues())).toEqual({
      id: savedModel.id,
      name: savedModel.name,
      model: 'replacement',
      toolUsage: 1,
    })
  })

  it('repairs a legacy endpoint and missing API key on the same model after a successful test', async () => {
    await createModel(getDb(), savedModel)
    const { result } = renderEditState(savedModel, providerFetch({ acceptsTools: true }))
    act(() => {
      result.current.changeUrl('https://repaired.example/v1')
      result.current.changeApiKey('replacement-key')
    })
    expect(result.current.isSaveDisabled).toBe(true)
    await act(async () => {
      await result.current.testConnection()
    })
    expect(result.current.isSaveDisabled).toBe(false)
    const { id, ...updates } = result.current.submissionFor(result.current.form.getValues())
    await updateModel(getDb(), id, updates)
    expect(await getModel(getDb(), id)).toMatchObject({
      id: savedModel.id,
      url: 'https://repaired.example/v1',
      apiKey: 'replacement-key',
    })
    expect((await getModel(getDb(), id))?.providerConnectionId).toBeNull()
    act(() => result.current.changeApiKey('newer-key'))
    expect(result.current.isSaveDisabled).toBe(true)
  })

  it('keeps, replaces, and explicitly clears legacy keys without populating the password field', () => {
    const { result } = renderEditState({ ...savedModel, apiKey: 'stored-key' }, providerFetch({ acceptsTools: true }))
    expect(result.current.form.getValues('apiKey')).toBe('')
    expect(result.current.effectiveApiKey).toBe('stored-key')
    expect(result.current.submissionFor(result.current.form.getValues()).apiKey).toBeUndefined()
    act(() => result.current.changeApiKey('replacement'))
    expect(result.current.submissionFor(result.current.form.getValues()).apiKey).toBe('replacement')
    act(() => result.current.changeApiKey(''))
    expect(result.current.effectiveApiKey).toBe('stored-key')
    act(() => result.current.toggleClearApiKey())
    expect(result.current.submissionFor(result.current.form.getValues()).apiKey).toBeNull()
    expect(result.current.effectiveApiKey).toBeUndefined()
    expect(result.current.isSaveDisabled).toBe(false)
    act(() => result.current.toggleClearApiKey())
    expect(result.current.submissionFor(result.current.form.getValues()).apiKey).toBeUndefined()
    expect(result.current.isSaveDisabled).toBe(true)
  })

  it('loads a legacy catalog only on request and uses the latest explicitly entered credentials', async () => {
    const fetch = spyOn(modelCatalog, 'fetchModelsForProvider').mockResolvedValue([{ id: 'available' }])
    const { result } = renderEditState({ ...savedModel, apiKey: 'stored-key' }, providerFetch({ acceptsTools: true }))
    expect(fetch).not.toHaveBeenCalled()
    act(() => {
      result.current.changeUrl('https://repaired.example/v1')
      result.current.changeApiKey('replacement-key')
    })
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => {
      result.current.loadCatalog()
      await getClock().runAllAsync()
    })
    expect(fetch).toHaveBeenCalledWith(
      { provider: 'custom', apiKey: 'replacement-key', url: 'https://repaired.example/v1' },
      expect.any(Function),
    )
    expect(result.current.modelItems.some(({ id }) => id === 'available')).toBe(true)
    act(() => result.current.changeUrl(''))
    expect(result.current.modelItems.some(({ id }) => id === 'available')).toBe(false)
    await act(async () => result.current.loadCatalog())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await result.current.form.trigger()).toBe(false)
  })
})
