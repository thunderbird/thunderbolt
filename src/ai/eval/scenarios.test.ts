/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  defaultModelDeepseekV4Flash,
  defaultModelGlm52,
  defaultModelOpus5,
  defaultModels,
} from '@shared/defaults/models'
import { deriveEvalModelMatrix, evalModelSlugs, evalModels, getScenarios } from './scenarios'

describe('eval model matrix', () => {
  test('tracks every shipped default model with a stable slug and production engine', () => {
    expect(evalModels).toEqual([
      { id: defaultModelOpus5.id, name: 'opus', engineName: 'pi' },
      { id: defaultModelDeepseekV4Flash.id, name: 'flash', engineName: 'pi' },
      { id: defaultModelGlm52.id, name: 'glm', engineName: 'pi' },
    ])
  })

  test('fails loudly when a shipped model has no stable slug', () => {
    const newDefault = { ...defaultModels[0], id: 'new-model-id', name: 'New Model' }

    expect(() => deriveEvalModelMatrix([...defaultModels, newDefault], evalModelSlugs)).toThrow(
      'Missing eval slug for default model "New Model" (new-model-id)',
    )
  })
})

describe('getScenarios', () => {
  test('includes the engine in ids and filters by engine', () => {
    const scenarios = getScenarios(['glm'], ['search'], ['pi'])

    expect(scenarios.length).toBeGreaterThan(0)
    expect(scenarios.every((scenario) => scenario.engineName === 'pi')).toBe(true)
    expect(scenarios.every((scenario) => scenario.id.startsWith('glm/pi/search/'))).toBe(true)
    expect(getScenarios(['glm'], ['search'], ['legacy'])).toEqual([])
  })

  test('does not require citations for stable chat prompts', () => {
    const stablePromptIds = ['C8', 'C12', 'VC3', 'VC4', 'VC7', 'VC9']
    const scenarios = getScenarios(['opus'], ['chat'], ['pi'])

    for (const promptId of stablePromptIds) {
      const scenario = scenarios.find(({ id }) => id.endsWith(`/${promptId}`))
      expect(scenario?.criteria).toEqual({ mustProduceOutput: true })
    }
  })
})
