/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { useAddModelForm } from './use-add-model-form'

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
    const { result } = renderHook(() => useAddModelForm({ active: false, onClose }), {
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
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
