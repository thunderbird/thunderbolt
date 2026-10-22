/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { http } from '@/lib/http'
import { i18n } from '@/i18n'
import { getModel } from '@/dal/models'
import { modelsTable } from '@/db/tables'
import { mockProxyFetch } from '@/test-utils/proxy-fetch'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { createAddModelFormSchema, generateModelName, useAddModelForm } from './use-add-model-form'

describe('generateModelName', () => {
  it('title-cases hyphenated ids and keeps version numbers intact', () => {
    expect(generateModelName('gpt-4-turbo')).toBe('Gpt 4 Turbo')
    expect(generateModelName('claude-3-5-sonnet')).toBe('Claude 3 5 Sonnet')
  })

  it('drops the vendor prefix and tag suffix', () => {
    expect(generateModelName('anthropic/claude-3-haiku')).toBe('Claude 3 Haiku')
    expect(generateModelName('llama3:latest')).toBe('Llama 3')
  })

  it('keeps letter-digit model families like o1 together', () => {
    expect(generateModelName('o1-preview')).toBe('O1 Preview')
  })

  it('preserves decimal versions', () => {
    expect(generateModelName('glm-5.2')).toBe('Glm 5.2')
  })

  it('removes Otari provider prefixes without treating them as Ollama tags', () => {
    expect(generateModelName('openai:gpt-4o', 'otari')).toBe('Gpt 4 O')
    expect(generateModelName('anthropic:claude-sonnet-4-6', 'otari')).toBe('Claude Sonnet 4 6')
    expect(generateModelName('openrouter:meta-llama/llama-3.3-70b', 'otari')).toBe('Llama 3.3 70 B')
    expect(generateModelName('my-model', 'otari')).toBe('My Model')
  })
})

describe('Otari form validation', () => {
  it('requires a token and model, and uses the fixed hosted URL', () => {
    const schema = createAddModelFormSchema(i18n)
    const values = { provider: 'otari', name: 'GPT', model: 'openai:gpt-4o', apiKey: 'tk-user' }
    expect(schema.safeParse(values).success).toBe(true)
    expect(schema.safeParse({ ...values, apiKey: '' }).success).toBe(false)
    expect(schema.safeParse({ ...values, apiKey: undefined }).success).toBe(false)
    expect(schema.safeParse({ ...values, model: '' }).success).toBe(false)
    expect(schema.safeParse({ ...values, provider: 'thunderbolt' }).success).toBe(false)
  })
})

describe('useAddModelForm', () => {
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

  it('discovers and saves an Otari model with its token confined to device-local storage', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({ data: [{ id: 'anthropic:claude-sonnet-4-6', supports_tools: true }] }),
    )
    const { result } = renderHook(() => useAddModelForm({ isOpen: true, onClose: () => {} }), {
      wrapper: createTestProvider(),
    })

    try {
      await act(async () => {
        result.current.onProviderChange('otari')
        await getClock().runAllAsync()
      })
      expect(getSpy).not.toHaveBeenCalled()
      expect(result.current.form.getValues('url')).toBe('')

      act(() => result.current.form.setValue('apiKey', 'tk-user'))
      await act(async () => {
        await getClock().tickAsync(499)
      })
      expect(getSpy).not.toHaveBeenCalled()
      await act(async () => {
        await getClock().tickAsync(1)
      })
      expect(getSpy).toHaveBeenCalledWith('https://api.otari.ai/api/v1/models', {
        headers: { Authorization: 'Bearer tk-user' },
        fetch: mockProxyFetch,
      })

      act(() => result.current.onSelectModel('anthropic:claude-sonnet-4-6'))
      expect(result.current.form.getValues('name')).toBe('Claude Sonnet 4 6')
      expect(result.current.supportsTools).toBe(true)
      await act(async () => {
        result.current.onSubmit(result.current.form.getValues())
        await getClock().runAllAsync()
      })

      const created = useChatStore.getState().models.find((candidate) => candidate.provider === 'otari')!
      expect(await getModel(getDb(), created.id)).toMatchObject({
        provider: 'otari',
        model: 'anthropic:claude-sonnet-4-6',
        apiKey: 'tk-user',
        url: null,
      })
      const syncedRows = await getDb().select().from(modelsTable)
      expect(JSON.stringify(syncedRows)).not.toContain('tk-user')
    } finally {
      getSpy.mockRestore()
    }
  })

  it('refreshes the chat model list before closing after creation', async () => {
    const onClose = mock(() => {})
    const onMutationStart = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose, onMutationStart }), {
      wrapper: createTestProvider(),
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'anthropic',
        name: 'New Chat Model',
        model: 'new-chat-model',
        customModel: '',
        url: '',
        apiKey: 'sk-test',
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.some((model) => model.name === 'New Chat Model')).toBe(true)
    expect(onMutationStart).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces the submit error and stays open when the create mutation fails', async () => {
    // The mutation's onError logs the failure; muted so the test output stays clean.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const transactionSpy = spyOn(getDb(), 'transaction').mockImplementation(() => {
      throw new Error('insert failed')
    })
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })

    try {
      await act(async () => {
        result.current.onSubmit({
          provider: 'anthropic',
          name: 'Broken Model',
          model: 'broken-model',
          customModel: '',
          url: '',
          apiKey: 'sk-test',
        })
        await getClock().runAllAsync()
      })

      expect(result.current.submitError).toBe("Couldn't add the model. Please try again.")
      expect(consoleError).toHaveBeenCalledWith('Failed to add the model.', expect.any(Error))
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      transactionSpy.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('substitutes the typed custom model id on submit when Custom is selected', async () => {
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })

    act(() => {
      result.current.onSelectModel('custom')
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'anthropic',
        name: 'My Custom Model',
        model: 'ignored-model',
        customModel: 'gpt-4-turbo-preview',
        url: '',
        apiKey: 'sk-test',
      })
      await getClock().runAllAsync()
    })

    const created = useChatStore.getState().models.find((candidate) => candidate.name === 'My Custom Model')
    expect(created?.model).toBe('gpt-4-turbo-preview')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not refetch an already requested catalog when visibility alone changes', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'gpt-test' }] }))
    const onClose = mock(() => {})
    const { result, rerender } = renderHook(({ isOpen }: { isOpen: boolean }) => useAddModelForm({ isOpen, onClose }), {
      initialProps: { isOpen: true },
      wrapper: createTestProvider(),
    })

    try {
      act(() => {
        result.current.onProviderChange('openai')
        result.current.form.setValue('apiKey', 'sk-test')
        result.current.onCatalogInvalidated()
      })
      await act(async () => {
        getClock().tick(500)
        await getClock().runAllAsync()
      })
      expect(getSpy).toHaveBeenCalledTimes(1)

      rerender({ isOpen: false })
      rerender({ isOpen: true })
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getSpy).toHaveBeenCalledTimes(1)
    } finally {
      getSpy.mockRestore()
    }
  })
})
