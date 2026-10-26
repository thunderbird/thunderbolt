/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createTestProvider } from '@/test-utils/test-provider'
import type { Model } from '@/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
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
})
