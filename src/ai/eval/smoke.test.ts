/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getNecessityScenarios } from './necessity-scenarios'
import { evalModels, getScenarios } from './scenarios'
import { getScenarioSampleCount, selectSmokeScenarios } from './smoke'
import type { NecessityCategory } from './types'

const necessityCategories: NecessityCategory[] = [
  'never_search',
  'answer_then_offer',
  'single_search',
  'research',
  'unknown_entity',
  'false_premise',
  'adversarial_no_search',
  'multi_turn_reuse',
]

describe('smoke scenarios', () => {
  test('selects one stable core prompt per mode and one prompt per necessity category in every cell', () => {
    const allScenarios = [...getScenarios(), ...getNecessityScenarios()]
    const smokeScenarios = selectSmokeScenarios(allScenarios)

    expect(smokeScenarios).toEqual(selectSmokeScenarios(allScenarios))
    expect(smokeScenarios).toHaveLength(evalModels.length * (3 + necessityCategories.length))

    for (const model of evalModels) {
      const cell = smokeScenarios.filter(
        ({ modelName, engineName }) => modelName === model.name && engineName === model.engineName,
      )
      const core = cell.filter(({ category }) => !category)
      const necessity = cell.filter(({ category }) => category)

      expect(core.map(({ id }) => id.split('/').at(-1))).toEqual(['C1', 'S1', 'R1'])
      expect(core.map(({ modeName }) => modeName)).toEqual(['chat', 'search', 'research'])
      expect(necessity.map(({ category }) => category)).toEqual(necessityCategories)
    }
  })

  test('includes the optional necessity category only when it is present in the input', () => {
    const smokeScenarios = selectSmokeScenarios(getNecessityScenarios(['opus'], ['pi'], true))

    expect(smokeScenarios.filter(({ category }) => category === 'search_wont_help')).toHaveLength(1)
    expect(smokeScenarios.some(({ id }) => id.endsWith('/search-wont-help-01'))).toBe(true)
  })

  test('forces one sample in smoke mode without changing full-run sampling', () => {
    const necessity = getNecessityScenarios(['opus'], ['pi'])[0]
    const core = getScenarios(['opus'], ['chat'], ['pi'])[0]

    expect(getScenarioSampleCount(necessity, 3, true)).toBe(1)
    expect(getScenarioSampleCount(necessity, 3, false)).toBe(3)
    expect(getScenarioSampleCount(core, 3, false)).toBe(1)
  })
})
