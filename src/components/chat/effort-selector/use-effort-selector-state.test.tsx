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

const DirectChoiceProbe = () => {
  const { choose } = useEffortSelectorState()
  return (
    <>
      <button onClick={() => choose('unsupported')}>Unsupported</button>
      <button onClick={() => choose('deep')}>Deep</button>
    </>
  )
}

/** Installs a remote agent's advertised options without interpreting its opaque values. */
const installRemoteOptions = (setOption: (configId: string, value: string) => Promise<void>) => {
  const session = useChatStore.getState().sessions.get('effort-chat')!
  const agent = { ...session.selectedAgent, id: 'opaque-agent', type: 'remote-acp' as const }
  useChatStore.getState().updateSession(session.id, { selectedAgent: agent })
  const key = sessionConfigKey(agent.id, session.id)
  useSessionConfigStore.getState().set(key, {
    setOption,
    options: [
      {
        id: 'native-effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Balanced' },
          { value: 'deep', name: 'Deep' },
        ],
      },
    ],
  })
  return () => useSessionConfigStore.getState().remove(key, setOption)
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
  it('rejects unsupported values even when called outside the slider', async () => {
    const writes: string[] = []
    const remove = installRemoteOptions(async (_id, value) => {
      writes.push(value)
    })
    renderWithReactivity(<DirectChoiceProbe />, { tables: ['settings'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unsupported' }))
    })
    expect(writes).toEqual([])
    expect(await getChatReasoningEffort('effort-chat', model)).toBeUndefined()
    remove()
  })

  it.each(['submitted', 'streaming', 'compacting'] as const)(
    'rejects effort writes while %s even if the caller is enabled',
    async (status) => {
      const writes: string[] = []
      const remove = installRemoteOptions(async (_id, value) => {
        writes.push(value)
      })
      useChatStore
        .getState()
        .updateSession(
          'effort-chat',
          status === 'compacting'
            ? { compactionStatus: 'compacting' }
            : { chatInstance: createMockChatInstance([], status) },
        )
      renderWithReactivity(<DirectChoiceProbe />, { tables: ['settings'] })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Deep' }))
      })
      expect(writes).toEqual([])
      remove()
    },
  )

  it('keeps confidential model selection usable and honors the model picker close callback', async () => {
    useChatStore.getState().updateSession('effort-chat', {
      selectedModel: { ...model, name: 'Private model', isConfidential: 1, isSystem: 1, apiKey: null },
    })
    renderWithReactivity(<EffortSelector modelPicker={(close) => <button onClick={close}>Manage models</button>} />, {
      tables: ['settings'],
    })
    const trigger = screen.getByRole('button', { name: 'Model and reasoning effort' })
    expect(screen.getByTestId('model-selector-trigger')).toBe(trigger)
    expect(trigger.textContent).toContain('Private model')
    expect(trigger.getAttribute('aria-description')).toContain('Model: Private model')
    expect(screen.queryByLabelText('API key not configured')).toBeNull()
    await act(async () => {
      fireEvent.click(trigger)
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manage models' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('preserves agent-advertised opaque values, including default', async () => {
    const writes: Array<[string, string]> = []
    const remove = installRemoteOptions(async (id, value) => {
      writes.push([id, value])
    })
    renderWithReactivity(<Probe />, { tables: ['settings'] })
    expect(screen.getByRole('status').textContent).toBe('default')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Balanced' }))
    })
    expect(writes).toEqual([['native-effort', 'default']])
    remove()
  })

  it('rolls back failed agent writes and hides the failure after switching models', async () => {
    const remove = installRemoteOptions(async () => {
      throw new Error('Agent rejected change')
    })
    renderWithReactivity(<EffortSelector />, { tables: ['settings'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort' }))
    })
    const slider = screen.getByRole('slider')
    await act(async () => {
      fireEvent.change(slider, { target: { value: '1' } })
    })
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(screen.getByRole('alert').textContent).toBe('Could not change reasoning effort')
    expect(slider.getAttribute('aria-valuetext')).toBe('Balanced')
    await act(async () => {
      useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, id: 'different' } })
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Balanced')
    remove()
  })

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
      useChatStore.getState().updateSession(session.id, { selectedModel: { ...model, id: 'other-effort-model' } })
    })
    // Switching models keeps the surface open but must not inherit an in-flight optimistic selection.
    const nextSlider = screen.getByRole('slider', { name: 'Reasoning effort' })
    expect(nextSlider.getAttribute('aria-valuetext')).toBe('Low')
    await act(async () => {
      useSessionConfigStore.getState().set(key, {
        options: options.map((option) => (option.type === 'select' ? { ...option, currentValue: 'high' } : option)),
        setOption,
      })
      saved.resolve()
    })
    expect(nextSlider.getAttribute('aria-valuetext')).toBe('High')
    useSessionConfigStore.getState().remove(key, setOption)
  })

  it('retains the missing API key warning in the combined trigger', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, isSystem: 0, apiKey: null } })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, { tables: ['settings'] })
    expect(screen.getByLabelText('API key not configured')).toBeInTheDocument()
  })

  it('keeps model selection available when effort is unsupported', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, model: 'llama3-3-70b' } })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, { tables: ['settings'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning effort' }))
    })
    expect(screen.getByRole('button', { name: 'Choose model' })).toBeDefined()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByRole('button', { name: 'Model and reasoning effort' })).toHaveAttribute(
      'aria-description',
      `Model: ${model.name}`,
    )
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
    expect(slider.getAttribute('aria-valuetext')).toBe('Choose effort')
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
