/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { checkMemoryState, getMemoryScenarios } from './memory-scenarios'
import { evalModels } from './scenarios'

describe('memory eval scenarios', () => {
  test('covers all shipped models with the same positive and negative controls', () => {
    const scenarios = getMemoryScenarios()
    expect(new Set(scenarios.map((scenario) => scenario.modelName))).toEqual(
      new Set(evalModels.map((model) => model.name)),
    )
    const idsFor = (name: string) =>
      scenarios.filter((scenario) => scenario.modelName === name).map((scenario) => scenario.id.split('/').at(-1))
    for (const model of evalModels) {
      expect(idsFor(model.name)).toEqual(idsFor(evalModels[0].name))
      expect(idsFor(model.name)).toContain('memory-update')
      expect(idsFor(model.name)).toContain('memory-disabled')
      expect(idsFor(model.name)).toContain('sessions-retrieved-injection')
      expect(idsFor(model.name)).toContain('sessions-large-unicode')
    }
  })

  test('fails invalid filters instead of launching an unintended paid eval run', () => {
    expect(() => getMemoryScenarios(['typo'])).toThrow('Unknown memory eval filters')
    expect(() => getMemoryScenarios(undefined, ['typo'])).toThrow('Unknown memory eval filters')
    expect(getMemoryScenarios(['glm'], ['memory-forget'])).toHaveLength(1)
  })

  test('checks preserved facts and clearing in the complete document', () => {
    expect(
      checkMemoryState({ includes: ['rust', 'celsius'], excludes: ['python'] }, 'Prefers Rust.\nUses Celsius.'),
    ).toEqual([])
    expect(checkMemoryState({ includes: ['celsius'], excludes: ['python'] }, 'Uses Celsius.')).toEqual([])
    expect(checkMemoryState({ exact: '' }, '')).toEqual([])
    expect(checkMemoryState({ exact: 'Original\nformatting' }, 'Original formatting')).toEqual([
      'Saved memory document did not match the expected snapshot',
    ])
  })

  test('detects unintended writes and stale contradictory content', () => {
    expect(checkMemoryState({ exact: '' }, 'Invented preference')).toHaveLength(1)
    expect(checkMemoryState({ includes: ['rust'], excludes: ['python'] }, 'Prefers Python.')).toEqual([
      'Saved memory omitted: rust',
      'Saved memory retained: python',
    ])
  })

  test('private-chat fixture persists privacy independently of model confidentiality', () => {
    const scenarios = getMemoryScenarios(undefined, ['memory-private-chat'])
    expect(scenarios).toHaveLength(evalModels.length)
    for (const scenario of scenarios) {
      expect(scenario.threadId).toBeDefined()
      expect(scenario.fixture.privateChat).toBe(true)
      expect(scenario.criteria.toolCallLimits).toMatchObject({ read_memory: { max: 0 }, save_memory: { max: 0 } })
      expect(scenario.memoryState.exact).toBe(scenario.fixture.memoryContent)
    }
  })
})
