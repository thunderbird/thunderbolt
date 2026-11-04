/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getChatReasoningEffort } from '@/ai/reasoning-effort'
import { useChatStore } from '@/chats/chat-store'
import { EffortSelector } from './effort-selector'
import { useEffortSelectorState } from './use-effort-selector-state'

const model = createMockModel({ id: 'effort-model', provider: 'tinfoil', model: 'glm-5-3' })
const Probe = () => {
  const { choices, value, busy, choose } = useEffortSelectorState()
  return (
    <div>
      <output>{value}</output>
      {choices.map((choice) => (
        <button key={choice.value} disabled={busy} onClick={() => choose(choice.value)}>
          {choice.name}
        </button>
      ))}
    </div>
  )
}

beforeAll(setupTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  resetStore()
  hydrateStore({
    id: 'effort-chat',
    chatInstance: createMockChatInstance(),
    chatThread: null,
    selectedModel: model,
    triggerData: null,
  })
})
afterEach(() => {
  cleanup()
  resetStore()
})
afterAll(teardownTestDatabase)

describe('effort selector state', () => {
  it('renders the actual Radix selector with supported choices', async () => {
    renderWithReactivity(<EffortSelector />, { tables: ['settings'] })
    const trigger = await waitForElement(() => screen.queryByRole('combobox', { name: 'Reasoning effort' }))
    expect(trigger.textContent).toContain('Default')
    await act(async () => {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    })
    expect(await waitForElement(() => screen.queryByRole('option', { name: 'High' }))).toBeDefined()
  })

  it('offers only supported levels and persists the conversation preference without editing the model', async () => {
    renderWithReactivity(<Probe />, { tables: ['settings'] })
    const high = await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Medium' })).toBeNull()
    await act(async () => {
      fireEvent.click(high)
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
    expect(await getChatReasoningEffort('another-chat', model)).toBeUndefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBeUndefined()
  })

  it('disables changes while streaming or compacting', async () => {
    renderWithReactivity(<Probe />, { tables: ['settings'] })
    const high = await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
    await act(async () => {
      useChatStore.getState().updateSession('effort-chat', { compactionStatus: 'compacting' })
    })
    expect((high as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no controls for unsupported models', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, model: 'llama3-3-70b' } })
    renderWithReactivity(<Probe />, { tables: ['settings'] })
    await act(async () => {})
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
