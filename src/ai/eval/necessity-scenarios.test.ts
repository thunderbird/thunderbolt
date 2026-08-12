/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getNecessityScenarios } from './necessity-scenarios'
import type { EvalCriteria, NecessityCategory } from './types'

const expectedCounts: Record<NecessityCategory, number> = {
  never_search: 12,
  answer_then_offer: 12,
  single_search: 12,
  research: 12,
  unknown_entity: 8,
  false_premise: 8,
  adversarial_no_search: 16,
  multi_turn_reuse: 12,
  search_wont_help: 4,
}

type JudgeAssertion = keyof Pick<
  EvalCriteria,
  'expectCorrectAnswer' | 'expectSearchOffer' | 'expectPremiseRebuttal' | 'expectVerificationDisclaimer'
>

const judgeAssertions: JudgeAssertion[] = [
  'expectCorrectAnswer',
  'expectSearchOffer',
  'expectPremiseRebuttal',
  'expectVerificationDisclaimer',
]

const expectedJudgeAssertions: Record<NecessityCategory, JudgeAssertion[]> = {
  never_search: ['expectCorrectAnswer'],
  answer_then_offer: ['expectSearchOffer'],
  single_search: [],
  research: [],
  unknown_entity: [],
  false_premise: ['expectPremiseRebuttal'],
  adversarial_no_search: ['expectCorrectAnswer'],
  multi_turn_reuse: [],
  search_wont_help: ['expectVerificationDisclaimer'],
}

describe('necessity scenarios', () => {
  test('matches the taxonomy counts for one model', () => {
    const scenarios = getNecessityScenarios(['opus'], undefined, false)
    const counts = Object.fromEntries(
      Object.keys(expectedCounts).map((category) => [
        category,
        scenarios.filter((scenario) => scenario.category === category).length,
      ]),
    )

    expect(counts).toEqual({ ...expectedCounts, search_wont_help: 0 })
    expect(getNecessityScenarios(['opus'], undefined, true)).toHaveLength(
      Object.values(expectedCounts).reduce((sum, count) => sum + count, 0),
    )
  })

  test('uses unique human-readable ids and review dates', () => {
    const scenarios = getNecessityScenarios(['opus'], undefined, true)
    const localIds = scenarios.map(({ id }) => id.split('/').at(-1))

    expect(new Set(localIds).size).toBe(localIds.length)
    expect(localIds.every((id) => /^[a-z]+(?:-[a-z]+)*-\d{2}$/.test(id ?? ''))).toBe(true)
    expect(scenarios.every(({ reviewBy }) => /^\d{4}-\d{2}-\d{2}$/.test(reviewBy ?? ''))).toBe(true)
  })

  test('contains two multi-turn negative controls that require a new search', () => {
    const controls = getNecessityScenarios(['opus'], undefined, false).filter(
      ({ category, isNegativeControl }) => category === 'multi_turn_reuse' && isNegativeControl,
    )

    expect(controls).toHaveLength(2)
    expect(controls.every(({ followUps, criteria }) => followUps?.length === 1 && criteria.minToolCalls === 1)).toBe(
      true,
    )
  })

  test('applies category-specific web-call maxima without capping research', () => {
    const scenarios = getNecessityScenarios(['opus'], undefined, true)
    const maximums = (category: NecessityCategory) =>
      scenarios.filter((scenario) => scenario.category === category).map(({ criteria }) => criteria.maxToolCalls)

    expect(new Set(maximums('never_search'))).toEqual(new Set([0]))
    expect(new Set(maximums('answer_then_offer'))).toEqual(new Set([0]))
    expect(new Set(maximums('single_search'))).toEqual(new Set([2]))
    expect(new Set(maximums('research'))).toEqual(new Set([undefined]))
    expect(new Set(maximums('unknown_entity'))).toEqual(new Set([2]))
    expect(new Set(maximums('false_premise'))).toEqual(new Set([3]))
    expect(new Set(maximums('adversarial_no_search'))).toEqual(new Set([0]))
    expect(new Set(maximums('search_wont_help'))).toEqual(new Set([2]))

    const reuseScenarios = scenarios.filter(({ category }) => category === 'multi_turn_reuse')
    expect(
      new Set(
        reuseScenarios.filter(({ isNegativeControl }) => !isNegativeControl).map((item) => item.criteria.maxToolCalls),
      ),
    ).toEqual(new Set([0]))
    expect(
      new Set(
        reuseScenarios.filter(({ isNegativeControl }) => isNegativeControl).map((item) => item.criteria.maxToolCalls),
      ),
    ).toEqual(new Set([2]))
  })

  test('declares only the semantic assertions approved for each category', () => {
    const scenarios = getNecessityScenarios(['opus'], undefined, true)

    for (const scenario of scenarios) {
      const declared = judgeAssertions.filter((assertion) => scenario.criteria[assertion])

      expect(declared).toEqual(expectedJudgeAssertions[scenario.category!])
    }
  })

  test('keeps every necessity scenario in un-tokenized chat mode', () => {
    const scenarios = getNecessityScenarios(undefined, undefined, true)

    expect(scenarios.every(({ modeName, prompt }) => modeName === 'chat' && !prompt.startsWith('/'))).toBe(true)
    expect(scenarios.every(({ followUps }) => followUps?.every((prompt) => !prompt.startsWith('/')) ?? true)).toBe(true)
  })
})
