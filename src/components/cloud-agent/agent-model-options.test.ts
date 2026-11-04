/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import {
  agentModelOptions,
  enabledAgentModels,
  reorderAgentModelOptions,
  type AgentModelChoice,
} from './agent-model-options'
import { agentModelPatch } from '@shared/cloud-agent/agent-models'

const choices: AgentModelChoice[] = ['a', 'b', 'c'].map((id) => ({
  source: { id, name: id.toUpperCase() },
  resolution: { ok: false, code: 'managed_model_unavailable' },
}))
const selected = [{ localModelId: 'a', name: 'A', model: null }]

it('skips disabled models when choosing the default, including after reopening', () => {
  const options = reorderAgentModelOptions(agentModelOptions(selected, choices), 'b', 'a')
  expect(options.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
  expect(agentModelPatch(enabledAgentModels(options)).localModelId).toBe('a')
  const reopened = agentModelOptions(
    enabledAgentModels(options),
    choices,
    options.map((entry) => entry.id),
  )
  expect(reopened.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
  expect(reopened.map((entry) => entry.enabled)).toEqual([false, true, false])
  expect(agentModelPatch(enabledAgentModels(reopened)).localModelId).toBe('a')
})

it('makes the next enabled model default when dragging the previous default to the end', () => {
  const original = agentModelOptions([...selected, { localModelId: 'c', name: 'C', model: null }], choices, [
    'a',
    'b',
    'c',
  ])
  const options = reorderAgentModelOptions(original, 'a', 'c')
  expect(options.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  expect(options.map((entry) => entry.enabled)).toEqual([false, true, true])
  expect(agentModelPatch(enabledAgentModels(options)).localModelId).toBe('c')
  expect(original.map((entry) => entry.enabled)).toEqual([true, false, true])
})

it('does not change the default or enable unrelated models for an unchanged or stale drop', () => {
  const options = agentModelOptions(selected, choices)
  expect(reorderAgentModelOptions(options, 'a', 'a')).toBe(options)
  expect(reorderAgentModelOptions(options, 'missing', 'a')).toBe(options)
  expect(reorderAgentModelOptions(options, 'a', 'missing')).toBe(options)
  const reordered = reorderAgentModelOptions(options, 'c', 'b')
  expect(reordered.map((entry) => entry.enabled)).toEqual([true, false, false])
  expect(agentModelPatch(enabledAgentModels(reordered)).localModelId).toBe('a')
})

it('enables a model in its existing position and promotes the first enabled model', () => {
  const options = agentModelOptions(selected, choices, ['b', 'a', 'c'])
  const enabled = options.map((entry) => (entry.id === 'b' ? { ...entry, enabled: true } : entry))
  expect(agentModelPatch(enabledAgentModels(enabled)).localModelId).toBe('b')
  expect(agentModelOptions(enabledAgentModels(enabled), choices, ['b', 'a', 'c']).map((entry) => entry.id)).toEqual([
    'b',
    'a',
    'c',
  ])
  const disabled = enabled.map((entry) => (entry.id === 'b' ? { ...entry, enabled: false } : entry))
  expect(agentModelPatch(enabledAgentModels(disabled)).localModelId).toBe('a')
})

it('keeps saved order when the library order changes and appends new models', () => {
  expect(agentModelOptions(selected, [...choices].reverse(), ['b', 'a']).map((entry) => entry.id)).toEqual([
    'b',
    'a',
    'c',
  ])
})
