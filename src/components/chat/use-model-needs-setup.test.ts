/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useModelNeedsSetup } from './use-model-needs-setup'
import { useChatStore } from '@/chats/chat-store'
import { builtInAgent } from '@/defaults/agents'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

let previous: ReturnType<typeof useLocalSettingsStore.getState>
beforeEach(() => {
  previous = useLocalSettingsStore.getState()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
  const model = createMockModel()
  hydrateStore({
    id: 'chat',
    chatThread: null,
    chatInstance: createMockChatInstance(),
    models: [model],
    selectedModel: model,
    triggerData: null,
  })
})
afterEach(() => {
  cleanup()
  resetStore()
  useLocalSettingsStore.setState(previous)
})

it('requires setup after the selected connection disappears and clears when it returns', () => {
  const { result } = renderHook(useModelNeedsSetup)
  expect(result.current).toBe(false)
  act(() => useChatStore.getState().setModels([]))
  expect(result.current).toBe(true)
  act(() => useChatStore.getState().setModels([createMockModel()]))
  expect(result.current).toBe(false)
})

it('requires setup for a synced model without device-local credentials', () => {
  act(() => useChatStore.getState().setModels([createMockModel({ apiKey: null })]))
  const { result } = renderHook(useModelNeedsSetup)
  expect(result.current).toBe(true)
})

it('does not require a local model for an agent that manages its own inference', () => {
  useChatStore.getState().updateSession('chat', {
    selectedAgent: { ...builtInAgent, id: 'remote', type: 'remote-acp', transport: 'websocket' },
  })
  useChatStore.getState().setModels([])
  const { result } = renderHook(useModelNeedsSetup)
  expect(result.current).toBe(false)
})
