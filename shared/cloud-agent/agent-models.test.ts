/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { agentModelPatch, agentModels, moveAgentModel } from './agent-models'
import type { CloudAgentModel } from './contracts'

const models: CloudAgentModel[] = [
  {
    localModelId: 'a',
    name: 'A',
    model: { provider: 'managed', modelId: 'a', contextWindow: 32768, maxOutputTokens: 1024 },
  },
  { localModelId: 'b', name: 'B', model: null },
  { localModelId: 'c', name: 'C', model: null },
]

it('preserves legacy defaults and gives an explicit list priority', () => {
  expect(agentModels({ model: models[0].model, localModelId: 'a' })[0].localModelId).toBe('a')
  expect(agentModels({ model: models[0].model, models: [models[1]] })).toEqual([models[1]])
  expect(agentModels({ model: null })).toEqual([])
})

it('reorders immutably and promotes a local-only default without cloud fallback', () => {
  const reordered = moveAgentModel(models, 1, 0)
  expect(reordered.map((model) => model.localModelId)).toEqual(['b', 'a', 'c'])
  expect(models.map((model) => model.localModelId)).toEqual(['a', 'b', 'c'])
  expect(agentModelPatch(reordered)).toEqual({ models: reordered, localModelId: 'b', model: null })
  expect(moveAgentModel(models, 0, -1)).toBe(models)
  expect(moveAgentModel(models, 2, 3)).toBe(models)
})

it('clears the default when the last enabled model is removed', () => {
  expect(agentModelPatch([])).toEqual({ models: [], localModelId: undefined, model: null })
})

it('moves across multiple rows while preserving the other models', () => {
  expect(moveAgentModel(models, 2, 0).map((model) => model.localModelId)).toEqual(['c', 'a', 'b'])
})
