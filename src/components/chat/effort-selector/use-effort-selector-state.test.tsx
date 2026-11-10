/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getChatReasoningEffort, loadReasoningCapabilities } from '@/ai/reasoning-effort'
import * as settingsDal from '@/dal/settings'
import * as modelsDal from '@/dal/models'
import { upsertModelProfile } from '@/dal/model-profiles'
import { useChatStore } from '@/chats/chat-store'
import { sessionConfigKey, useSessionConfigStore } from '@/acp/session-config-store'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { EffortSelector } from './effort-selector'
import { useEffortSelectorState } from './use-effort-selector-state'
import { http } from '@/lib/http'
import { attestationStore } from '@/attestation/store'
import { tinfoilAttestationKey } from '@/attestation/target'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getDb } from '@/db/database'
import { reasoningEffortSettingKey } from '@shared/reasoning-effort'

const model = createMockModel({ id: 'effort-model', provider: 'tinfoil', model: 'glm-5-3' })
let catalogRequest: ReturnType<typeof spyOn<typeof http, 'get'>>
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
  catalogRequest = spyOn(http, 'get').mockImplementation(() => {
    const response = new Response(
      JSON.stringify({
        data: [
          { id: 'glm-5-3', reasoning: true, supported_efforts: ['low', 'high', 'max'] },
          { id: 'llama3-3-70b', reasoning: false, supported_efforts: [] },
        ],
      }),
    )
    return Object.assign(Promise.resolve(response), {
      json: <T,>() => response.clone().json() as Promise<T>,
      text: () => response.clone().text(),
    })
  })
  await resetTestDatabase()
  await modelsDal.createModel(getDb(), model)
  resetStore()
  attestationStore.clear(tinfoilAttestationKey('system', useLocalSettingsStore.getState().cloudUrl))
  attestationStore.clear(tinfoilAttestationKey('user', ''))
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
  catalogRequest.mockRestore()
  resetStore()
})
afterAll(teardownTestDatabase)

describe('effort selector state', () => {
  it('rejects unsupported values even when called outside the slider', async () => {
    const writes: string[] = []
    const remove = installRemoteOptions(async (_id, value) => {
      writes.push(value)
    })
    renderWithReactivity(<DirectChoiceProbe />, { tables: ['settings', 'models'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unsupported' }))
    })
    expect(writes).toEqual([])
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
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
      renderWithReactivity(<DirectChoiceProbe />, { tables: ['settings', 'models'] })
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
      tables: ['settings', 'models'],
    })
    const trigger = screen.getByRole('button', { name: 'Private model' })
    expect(screen.getByTestId('model-selector-trigger')).toBe(trigger)
    expect(trigger.textContent).toContain('Private model')
    expect(trigger.getAttribute('aria-description')).toContain('Model: Private model')
    expect(screen.queryByLabelText('API key not configured')).toBeNull()
    await act(async () => {
      fireEvent.click(trigger)
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Model and reasoning effort')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manage models' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the lock beside the model name and opens connection privacy from above effort', async () => {
    await loadReasoningCapabilities(model)
    useChatStore.getState().updateSession('effort-chat', {
      selectedModel: { ...model, name: 'Private model', isConfidential: 1, isSystem: 1, apiKey: null },
    })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, {
      tables: ['settings', 'models'],
    })

    const trigger = screen.getByRole('button', { name: 'Private model' })
    expect(trigger.querySelector('linearGradient')).not.toBeNull()
    expect(trigger).toHaveTextContent('Private model')
    await act(async () => {
      fireEvent.click(trigger)
    })
    const privacyRow = screen.getByRole('button', { name: 'Private inference' })
    const reasoningLabel = await waitForElement(() => screen.queryByText('Reasoning effort'))
    expect(privacyRow.compareDocumentPosition(reasoningLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => {
      fireEvent.click(privacyRow)
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Private inference')
  })

  it('preserves agent-advertised opaque values, including default', async () => {
    const writes: Array<[string, string]> = []
    const remove = installRemoteOptions(async (id, value) => {
      writes.push([id, value])
    })
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
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
    renderWithReactivity(<EffortSelector />, { tables: ['settings', 'models'] })
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
    renderWithReactivity(<EffortSelector />, { tables: ['settings', 'models'] })
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
    expect(nextSlider).toBeDisabled()
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

  it.each([false, true])('keeps model saves independent when an earlier model save fails: %s', async (failFirst) => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const updateModel = modelsDal.updateModel
    const write = spyOn(modelsDal, 'updateModel').mockImplementation(async (db, id, updates) => {
      await (id === model.id ? first.promise : second.promise)
      await updateModel(db, id, updates)
    })
    const other = { ...model, id: 'other-model' }
    await modelsDal.createModel(getDb(), other)
    try {
      renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
      const high = await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
      await act(async () => {
        fireEvent.click(high)
      })
      expect(high).toBeDisabled()
      await act(async () => {
        useChatStore.getState().updateSession('effort-chat', { selectedModel: other })
      })
      await waitForElement(
        () => screen.queryByRole('button', { name: 'Low' })?.closest('button:not(:disabled)') ?? null,
      )
      expect(screen.getByRole('button', { name: 'Low' })).not.toBeDisabled()
      expect(screen.getByRole('status').textContent).toBe('high')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Low' }))
      })
      const completed = { value: false }
      const readEffort = getChatReasoningEffort('another-chat', other)
      const settled = readEffort.then(() => {
        completed.value = true
      })
      await act(async () => {
        if (failFirst) {
          first.reject(new Error('First write failed'))
        } else {
          first.resolve()
        }
      })
      expect(completed.value).toBe(false)
      expect(screen.getByRole('button', { name: 'Low' })).toBeDisabled()
      expect(screen.getByRole('status').textContent).toBe('low')
      await act(async () => {
        second.resolve()
        await settled
      })
      expect(screen.getByRole('button', { name: 'Low' })).not.toBeDisabled()
      expect(await readEffort).toBe('low')
    } finally {
      first.resolve()
      second.resolve()
      write.mockRestore()
    }
  })

  it('waits for a model preference save even after its selector unmounts', async () => {
    const saved = Promise.withResolvers<void>()
    const updateModel = modelsDal.updateModel
    const write = spyOn(modelsDal, 'updateModel').mockImplementation(async (db, id, updates) => {
      await saved.promise
      await updateModel(db, id, updates)
    })
    try {
      renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
      const maximum = await waitForElement(() => screen.queryByRole('button', { name: 'Maximum' }))
      await act(async () => {
        fireEvent.click(maximum)
      })
      cleanup()
      const completed = { value: false }
      const readEffort = getChatReasoningEffort('new-chat', model)
      void readEffort.then(() => {
        completed.value = true
      })
      await act(async () => {})
      expect(completed.value).toBe(false)
      await act(async () => {
        saved.resolve()
      })
      expect(await readEffort).toBe('max')
    } finally {
      saved.resolve()
      write.mockRestore()
    }
  })

  it('restores the saved model preference and reports a failed write', async () => {
    await modelsDal.updateModel(getDb(), model.id, { reasoningEffort: 'low' })
    const saved = Promise.withResolvers<void>()
    const write = spyOn(modelsDal, 'updateModel').mockImplementation(() => saved.promise)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderWithReactivity(<EffortSelector />, { tables: ['settings', 'models'] })
      const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Reasoning effort' }))
      await act(async () => {
        fireEvent.click(trigger)
      })
      const slider = screen.getByRole('slider')
      await act(async () => {
        fireEvent.change(slider, { target: { value: '2' } })
        fireEvent.pointerUp(slider)
      })
      expect(slider).toHaveAttribute('aria-valuetext', 'Maximum')
      expect(slider).toBeDisabled()
      await act(async () => {
        saved.reject(new Error('Disk full'))
      })
      expect(slider).toHaveAttribute('aria-valuetext', 'Low')
      expect(slider).not.toBeDisabled()
      expect(screen.getByRole('alert')).toHaveTextContent('Could not change reasoning effort')
      expect(await getChatReasoningEffort('another-chat', model)).toBe('low')
    } finally {
      saved.resolve()
      write.mockRestore()
      error.mockRestore()
    }
  })

  it('does not overwrite a model preference while its row is still loading after a switch', async () => {
    const other = { ...model, id: 'loading-model' }
    await modelsDal.createModel(getDb(), { ...other, reasoningEffort: 'max' })
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
    const getModelQuery = modelsDal.getModelQuery
    const saved = [(await modelsDal.getModel(getDb(), other.id))!]
    const loaded = Promise.withResolvers<typeof saved>()
    const read = spyOn(modelsDal, 'getModelQuery').mockImplementation((db, id) => {
      const query = getModelQuery(db, id)
      if (id === other.id) {
        spyOn(query, 'execute').mockImplementation(() => loaded.promise)
      }
      return query
    })
    const write = spyOn(modelsDal, 'updateModel')
    try {
      await act(async () => {
        useChatStore.getState().updateSession('effort-chat', { selectedModel: other })
      })
      const low = screen.getByRole('button', { name: 'Low' })
      expect(low).toBeDisabled()
      await act(async () => {
        fireEvent.click(low)
      })
      expect(write).not.toHaveBeenCalled()
      await act(async () => {
        loaded.resolve(saved)
      })
      await waitForElement(() => screen.queryByText('max', { selector: 'output' }))
      expect(low).not.toBeDisabled()
    } finally {
      loaded.resolve(saved)
      read.mockRestore()
      write.mockRestore()
    }
  })

  it('shows a dismissible notification when a write fails after the picker closes', async () => {
    const save = Promise.withResolvers<void>()
    const remove = installRemoteOptions(async () => {
      await save.promise
    })
    renderWithReactivity(<EffortSelector modelPicker={(close) => <button onClick={close}>Close picker</button>} />, {
      tables: ['settings', 'models'],
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `API key not configured ${model.name}` }))
    })
    await act(async () => {
      fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
    })
    await act(async () => {
      fireEvent.pointerUp(screen.getByRole('slider'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close picker' }))
    })
    await act(async () => {
      save.reject(new Error('Agent rejected change'))
    })
    expect(screen.getByRole('alert').textContent).toBe('Could not change reasoning effort')
    expect(screen.getAllByText('Could not change reasoning effort').some((element) => element.tagName === 'P')).toBe(
      true,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    remove()
  })

  it('carries toggle capabilities through to the trigger ring', async () => {
    const toggleModel = { ...model, provider: 'anthropic' as const, model: 'claude-sonnet-4-5' }
    await loadReasoningCapabilities(toggleModel)
    useChatStore.getState().updateSession('effort-chat', { selectedModel: toggleModel })
    renderWithReactivity(<EffortSelector />, { tables: ['settings', 'models'] })
    const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Reasoning effort' }))
    expect(trigger).toHaveAttribute('title', 'Reasoning effort: Off')
    await act(async () => {
      fireEvent.click(trigger)
    })
    await act(async () => {
      fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
    })
    await act(async () => {
      fireEvent.pointerUp(screen.getByRole('slider'))
    })
    expect(trigger.getAttribute('title')).toBe('Reasoning effort: On')
    expect(trigger.querySelectorAll('circle[stroke-opacity="1"]')).toHaveLength(6)
  })

  it('retains the missing API key warning in the combined trigger', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, isSystem: 0, apiKey: null } })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, {
      tables: ['settings', 'models'],
    })
    expect(screen.getByLabelText('API key not configured')).toBeInTheDocument()
  })

  it('keeps model selection available when effort is unsupported', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, model: 'llama3-3-70b' } })
    renderWithReactivity(<EffortSelector modelPicker={() => <button>Choose model</button>} />, {
      tables: ['settings', 'models'],
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `API key not configured ${model.name}` }))
    })
    expect(screen.getByRole('button', { name: 'Choose model' })).toBeDefined()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByRole('button', { name: `API key not configured ${model.name}` })).toHaveAttribute(
      'aria-description',
      `Model: ${model.name}`,
    )
  })

  it('starts with a supported default, then previews and commits real effort levels', async () => {
    renderWithReactivity(<EffortSelector />, { tables: ['settings', 'models'] })
    const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Reasoning effort' }))
    expect(trigger.getAttribute('title')).toBe('Reasoning effort: High')
    await act(async () => {
      fireEvent.click(trigger)
    })
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Reasoning effort')
    expect(slider.getAttribute('data-selected')).toBe('true')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull()
    await act(async () => {
      fireEvent.blur(slider)
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(slider.getAttribute('data-selected')).toBe('true')
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0' } })
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('Low')
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
    await act(async () => {
      fireEvent.pointerUp(slider)
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('low')
    expect(screen.queryByRole('button', { name: 'Reset reasoning effort' })).toBeNull()
  })

  it('persists the model preference across chats, model switches, and remounts', async () => {
    await modelsDal.createModel(getDb(), { ...model, id: 'other-model' })
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Medium' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Maximum' }))
    })
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('max')
    expect(await getChatReasoningEffort('another-chat', model)).toBe('max')
    expect((await modelsDal.getModel(getDb(), model.id))?.reasoningEffort).toBe('max')
    expect(await settingsDal.getAllSettings(getDb())).toEqual([])
    await act(async () => {
      useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, id: 'other-model' } })
    })
    expect(screen.getByRole('status')).toHaveTextContent('high')
    await act(async () => {
      useChatStore.getState().updateSession('effort-chat', { selectedModel: model })
    })
    await waitForElement(() => screen.queryByText('max', { selector: 'output' }))
    cleanup()
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    await waitForElement(() => screen.queryByText('max', { selector: 'output' }))
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull()
  })

  it('reacts to synced model preferences and gives them precedence over legacy chat choices', async () => {
    await settingsDal.updateSettings(getDb(), { [reasoningEffortSettingKey('effort-chat', model.id)]: 'max' })
    const { triggerChange } = renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    await waitForElement(() => screen.queryByText('max', { selector: 'output' }))
    await act(async () => {
      await modelsDal.updateModel(getDb(), model.id, { reasoningEffort: 'low' })
      triggerChange(['models'])
    })
    await waitForElement(() => screen.queryByText('low', { selector: 'output' }))
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('low')
  })

  it('preselects the profile effort and follows synced changes until the user chooses a model preference', async () => {
    await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoningEffort: 'low' } })
    const { triggerChange } = renderWithReactivity(<Probe />, { tables: ['settings', 'models', 'model_profiles'] })
    await waitForElement(() => screen.queryByText('low', { selector: 'output' }))
    expect(await getChatReasoningEffort('effort-chat', model)).toBeUndefined()
    await act(async () => {
      await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoning: { effort: 'max' } } })
      triggerChange(['model_profiles'])
    })
    await waitForElement(() => screen.queryByText('max', { selector: 'output' }))
    expect(await getChatReasoningEffort('effort-chat', model)).toBeUndefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'High' }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('high')
    await act(async () => {
      await upsertModelProfile(getDb(), { modelId: model.id, providerOptions: { reasoningEffort: 'low' } })
      triggerChange(['model_profiles'])
    })
    expect(screen.getByRole('status')).toHaveTextContent('high')
    expect(await getChatReasoningEffort('effort-chat', model)).toBe('high')
  })

  it('disables changes while streaming or compacting', async () => {
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    const high = await waitForElement(() => screen.queryByRole('button', { name: 'High' }))
    await act(async () => {
      useChatStore.getState().updateSession('effort-chat', { compactionStatus: 'compacting' })
    })
    expect((high as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no controls for unsupported models', async () => {
    useChatStore.getState().updateSession('effort-chat', { selectedModel: { ...model, model: 'llama3-3-70b' } })
    renderWithReactivity(<Probe />, { tables: ['settings', 'models'] })
    await act(async () => {})
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
