/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { http } from '@/lib/http'
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
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.some((model) => model.name === 'New Chat Model')).toBe(true)
    expect(onMutationStart).toHaveBeenCalledTimes(1)
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
