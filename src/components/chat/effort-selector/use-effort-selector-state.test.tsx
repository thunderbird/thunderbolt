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
import { sessionConfigKey, useSessionConfigStore } from '@/acp/session-config-store'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
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
  it('keeps the released value visible while the agent saves it', async () => {
    const session = useChatStore.getState().sessions.get('effort-chat')!
    const agent = { ...session.selectedAgent, id: 'remote-effort', type: 'remote-acp' as const }
    useChatStore.getState().updateSession(session.id, { selectedAgent: agent })
    const saved = Promise.withResolvers<void>()
    const key = sessionConfigKey(agent.id, session.id)
    const options: SessionConfigOption[] = [
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ]
    const setOption = async () => {
      await saved.promise
    }
    useSessionConfigStore.getState().set(key, { options, setOption })
    renderWithReactivity(<EffortSelector />, { tables: ['settings'] })
    const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Reasoning effort' }))
    await act(async () => {
      fireEvent.click(trigger)
    })
    const slider = screen.getByRole('slider')
    await act(async () => {
      fireEvent.change(slider, { target: { value: '1' } })
    })
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(trigger.getAttribute('title')).toBe('Reasoning effort: High')
    expect((trigger as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      useSessionConfigStore.getState().set(key, {
        options: options.map((option) => (option.type === 'select' ? { ...option, currentValue: 'high' } : option)),
        setOption,
      })
      saved.resolve()
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    useSessionConfigStore.getState().remove(key, setOption)
  })

  it('keeps model selection available when effort is unsupported', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, model: 'llama3-3-70b' } })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, { tables: ['settings'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning effort' }))
    })
    expect(screen.getByRole('button', { name: 'Choose model' })).toBeDefined()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('requires an explicit first choice, then previews and commits real effort levels', async () => {
    renderWithReactivity(<EffortSelector />, { tables: ['settings'] })
    const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Reasoning effort' }))
    expect(trigger.getAttribute('title')).toBe('Reasoning effort: Choose effort')
    await act(async () => {
      fireEvent.click(trigger)
    })
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })
    expect(slider.getAttribute('data-selected')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull()
    await act(async () => {
      fireEvent.blur(slider)
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBeUndefined()
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(slider.getAttribute('data-selected')).toBe('true')
    await act(async () => {
      fireEvent.change(slider, { target: { value: '1' } })
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('low')
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
    expect(screen.queryByRole('button', { name: 'Reset reasoning effort' })).toBeNull()
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
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull()
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
