/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { http } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { generateModelName, useAddModelForm } from './use-add-model-form'

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
})

/** A provider that answers chat completions but rejects any request carrying tools, as Ollama does. */
const toollessProxyFetch: FetchFn = Object.assign(
  async (_input: RequestInfo | URL, init?: RequestInit) =>
    String(init?.body).includes('"tools"')
      ? Response.json({ error: { message: 'gemma3:4b does not support tools' } }, { status: 400 })
      : Response.json({
          id: 'completion-id',
          object: 'chat.completion',
          created: 1,
          model: 'gemma3:4b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'test successful' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
  { preconnect: async () => true },
)

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

  it('refreshes the chat model list before closing after creation', async () => {
    const onClose = mock(() => {})
    const onMutationStart = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose, onMutationStart }), {
      wrapper: createTestProvider(),
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'thunderbolt',
        name: 'New Chat Model',
        model: 'new-chat-model',
        customModel: '',
        url: '',
        apiKey: '',
        supportsTools: true,
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'New Chat Model')?.toolUsage).toBe(1)
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
          provider: 'thunderbolt',
          name: 'Broken Model',
          model: 'broken-model',
          customModel: '',
          url: '',
          apiKey: '',
          supportsTools: true,
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
        provider: 'thunderbolt',
        name: 'My Custom Model',
        model: 'ignored-model',
        customModel: 'gpt-4-turbo-preview',
        url: '',
        apiKey: '',
        supportsTools: true,
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

  it('saves a model that rejects tools with tool usage off after the connection test', async () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider({ proxyFetch: toollessProxyFetch }),
    })

    act(() => {
      result.current.onProviderChange('custom')
      result.current.form.setValue('url', 'https://models.example.com/v1')
      result.current.form.setValue('model', 'gemma3:4b')
      result.current.form.setValue('name', 'Gemma')
    })
    await act(async () => {
      await result.current.onTestConnection()
    })

    expect(result.current.connectionStatus).toBe('success')
    expect(result.current.toolSupport).toBe('unsupported')
    expect(result.current.form.getValues('supportsTools')).toBe(false)

    await act(async () => {
      result.current.onSubmit(result.current.form.getValues())
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'Gemma')?.toolUsage).toBe(0)
  })

  it('saves tool usage off when the switch is turned off by hand', async () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'thunderbolt',
        name: 'Toolless Model',
        model: 'toolless-model',
        customModel: '',
        url: '',
        apiKey: '',
        supportsTools: false,
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'Toolless Model')?.toolUsage).toBe(0)
  })

  it('turns tools back on when the provider changes', () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    act(() => {
      result.current.form.setValue('supportsTools', false)
      result.current.onProviderChange('custom')
    })

    expect(result.current.form.getValues('supportsTools')).toBe(true)
  })
})
