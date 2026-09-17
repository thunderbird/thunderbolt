/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getNecessityScenarios } from './necessity-scenarios'
import { scoreResult } from './scoring'
import { getScenarioTurns } from './turns'
import { semanticCriterionKeys, type EvalScenario, type NecessityCategory } from './types'

/** The search-necessity taxonomy proper — `language` shares the machinery but not the taxonomy. */
type SearchCategory = Exclude<NecessityCategory, 'language'>

const expectedCounts: Record<SearchCategory, number> = {
  never_search: 19,
  answer_then_offer: 8,
  single_search: 23,
  research: 26,
  unknown_entity: 8,
  false_premise: 8,
  adversarial_no_search: 19,
  multi_turn_reuse: 10,
  search_wont_help: 4,
}

type JudgeAssertion = (typeof semanticCriterionKeys)[number]

const expectedJudgeAssertions: Record<SearchCategory, JudgeAssertion[]> = {
  never_search: ['expectCorrectAnswer'],
  answer_then_offer: ['expectCorrectAnswer', 'expectSearchOffer'],
  single_search: ['expectEvidenceCoverage'],
  research: ['expectEvidenceCoverage'],
  unknown_entity: [],
  false_premise: ['expectEvidenceCoverage', 'expectPremiseRebuttal'],
  adversarial_no_search: ['expectCorrectAnswer'],
  multi_turn_reuse: ['expectReuseFidelity'],
  search_wont_help: ['expectVerificationDisclaimer'],
}

const weatherScenarioIds = new Set([
  'single-search-04',
  'single-search-05',
  'single-search-06',
  'multi-turn-reuse-02',
  'multi-turn-reuse-12',
])

/** Apply the same semantic invariant to shipped definitions and deliberate regression mutants. */
const assertScenarioSemantics = (scenario: EvalScenario) => {
  const declared = semanticCriterionKeys.filter((assertion) => scenario.criteria[assertion])
  const pairedLanguage = /poc-(desktop-transcripts|apple-silicon-llms|official-stable-version)(-pt)?-01$/.test(
    scenario.id,
  )
  const expected =
    weatherScenarioIds.has(scenario.id.split('/').at(-1)!) ||
    (scenario.category === 'multi_turn_reuse' && scenario.isNegativeControl)
      ? []
      : expectedJudgeAssertions[scenario.category as SearchCategory]
  expect(declared).toEqual([...expected, ...(pairedLanguage ? (['expectReplyLanguage'] as const) : [])])
  expect(Object.keys(scenario.expectation ?? {}).sort()).toEqual([...declared].sort())
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

  test('contains one multi-turn negative control that requires a new search', () => {
    const controls = getNecessityScenarios(['opus'], undefined, false).filter(
      ({ category, isNegativeControl }) => category === 'multi_turn_reuse' && isNegativeControl,
    )

    expect(controls).toHaveLength(1)
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
      assertScenarioSemantics(scenario)
    }
  })

  test('keeps every necessity scenario in un-tokenized chat mode', () => {
    const scenarios = getNecessityScenarios(undefined, undefined, true)

    expect(
      scenarios.every(
        ({ modeName, prompt }) => modeName === 'chat' && typeof prompt === 'string' && !prompt.startsWith('/'),
      ),
    ).toBe(true)
    expect(
      scenarios.every((scenario) => getScenarioTurns(scenario).every(({ prompt }) => !prompt.startsWith('/'))),
    ).toBe(true)
  })
})

test('approved classification retains 96 old IDs, all 27 PoC prompts and two verification pairs', () => {
  const scenarios = getNecessityScenarios(['opus'], undefined, true)
  expect(scenarios).toHaveLength(125)
  expect(scenarios.filter(({ id }) => id.includes('/poc-'))).toHaveLength(27)
  expect(scenarios.filter(({ id }) => id.includes('/verify-'))).toHaveLength(2)
  expect(scenarios.filter(({ id }) => !id.includes('/poc-') && !id.includes('/verify-'))).toHaveLength(96)
  for (const scenario of scenarios) {
    for (const turn of getScenarioTurns(scenario)) {
      if (!turn.criteria) {
        continue
      }
      expect(turn.criteria.expectResearchSkill).toBe(scenario.category === 'research')
      const semantic = semanticCriterionKeys.filter((key) => turn.criteria?.[key])
      expect(Object.keys(turn.expectation ?? {}).sort()).toEqual([...semantic].sort())
    }
  }
})

test('hard-case expectations match scoped current and historical questions', () => {
  const scenarios = getNecessityScenarios(['opus'], undefined, true)
  const find = (id: string) => scenarios.find((scenario) => scenario.id.endsWith('/' + id))!
  for (const index of ['10', '11', '12']) {
    expect(find(`answer-then-offer-${index}`).category).toBe('single_search')
    expect(find(`answer-then-offer-${index}`).expectation?.expectEvidenceCoverage).toContain('Mozilla Corporation')
    expect(find(`single-search-${index}`).expectation?.expectEvidenceCoverage).toContain('non-prerelease')
  }
  for (const [index, destination] of [
    ['04', 'Portugal'],
    ['05', 'Japan'],
    ['06', 'United Kingdom'],
  ]) {
    const scenario = find(`answer-then-offer-${index}`)
    expect(scenario.category).toBe('single_search')
    expect(scenario.prompt).toContain(destination)
    expect(scenario.prompt).toContain('30-day tourism')
    expect(scenario.prompt).toContain('pre-travel authorization')
  }
  for (const index of ['07', '08', '09']) {
    expect(find(`answer-then-offer-${index}`).expectation?.expectCorrectAnswer).toContain('historical UNESCO')
    expect(find(`single-search-${index}`).expectation?.expectEvidenceCoverage).toContain('no-fixture')
  }
  expect(find('poc-webgpu-state-01').category).toBe('single_search')
  expect(find('poc-webgpu-state-01').expectation?.expectEvidenceCoverage).toContain('bounded overview')
  expect(find('answer-then-offer-01').expectation?.expectCorrectAnswer).toContain('city-versus-metro')
})

test('verification pairs declare stable first-turn advice and narrow sourced final lookups', () => {
  for (const scenario of getNecessityScenarios(['opus']).filter(({ id }) => id.includes('/verify-'))) {
    const turns = getScenarioTurns(scenario)
    expect(typeof scenario.followUps?.[0]).toBe('object')
    expect(turns[0].criteria).toMatchObject({ maxToolCalls: 0, expectSearchOffer: true, expectCorrectAnswer: true })
    expect(turns[1].criteria).toMatchObject({ minToolCalls: 1, maxToolCalls: 2, expectEvidenceCoverage: true })
    expect(turns[1].prompt).toContain('Yes, please verify')
  }
})

test('reuse fidelity and Q3 routing-only cases have deliberately separate criteria', () => {
  for (const scenario of getNecessityScenarios(['opus'], undefined, true)) {
    if (scenario.category === 'unknown_entity' || scenario.category === 'search_wont_help') {
      expect(scenario.criteria.expectEvidenceCoverage).toBeUndefined()
    }
    if (scenario.category === 'false_premise') {
      expect(scenario.expectation?.expectEvidenceCoverage).toContain('non-event is not required')
    }
    if (scenario.category !== 'multi_turn_reuse') {
      continue
    }
    if (scenario.isNegativeControl) {
      expect(scenario.criteria.expectEvidenceCoverage).toBeUndefined()
      expect(scenario.promptCriteria?.expectEvidenceCoverage).toBeUndefined()
    } else {
      expect(scenario.promptCriteria?.expectEvidenceCoverage).toBe(true)
      expect(scenario.criteria.expectReuseFidelity).toBe(true)
      expect(scenario.criteria.maxToolCalls).toBe(0)
    }
  }
})

test('retained Portuguese counterparts keep language-sensitive routing and their English pairs', () => {
  const scenarios = getNecessityScenarios(['opus'])
  for (const name of ['desktop-transcripts', 'apple-silicon-llms', 'official-stable-version']) {
    const en = scenarios.find(({ id }) => id.endsWith(`/poc-${name}-01`))!
    const pt = scenarios.find(({ id }) => id.endsWith(`/poc-${name}-pt-01`))!
    expect(en.criteria.expectReplyLanguage).toBe('en')
    expect(pt.criteria.expectReplyLanguage).toBe('pt-BR')
    expect(pt.category).toBe(en.category)
    expect(pt.criteria.expectResearchSkill).toBe(en.criteria.expectResearchSkill)
  }
})

test('weather scenarios keep their IDs and use the core widget assertion with zero web calls on every turn', () => {
  const scenarios = getNecessityScenarios(['opus']).filter(
    ({ criteria }) => criteria.mustUseWidget === 'weather-forecast',
  )
  expect(new Set(scenarios.map(({ id }) => id.split('/').at(-1)))).toEqual(weatherScenarioIds)
  for (const scenario of scenarios) {
    expect(scenario.category).toBe('never_search')
    expect(scenario.isNegativeControl).toBeUndefined()
    const turns = getScenarioTurns(scenario)
    expect(turns).toHaveLength(scenario.id.includes('multi-turn') ? 2 : 1)
    for (const turn of turns) {
      expect(turn.criteria).toEqual({
        mustProduceOutput: true,
        maxToolCalls: 0,
        expectResearchSkill: false,
        mustUseWidget: 'weather-forecast',
      })
      expect(turn.expectation).toBeUndefined()
      const parsed = {
        text: '<widget:weather-forecast location="Lisbon" />',
        toolCalls: [],
        assistantParts: [],
        stepCount: 1,
        retryCount: 0,
        finishReason: 'stop',
        researchSkillLoaded: false,
      }
      const scored = { ...scenario, criteria: turn.criteria! }
      expect(scoreResult(scored, parsed, 0).passed).toBe(true)
      expect(scoreResult(scored, { ...parsed, text: 'It is sunny.' }, 0).passed).toBe(false)
      expect(scoreResult(scored, { ...parsed, toolCalls: [{ toolName: 'search', toolCallId: 'web' }] }, 0).passed).toBe(
        false,
      )
      expect(scoreResult(scored, { ...parsed, researchSkillLoaded: true }, 0).passed).toBe(false)
    }
  }
})

test('React setup requires a supported tag and publication date without an extra prerelease disclosure', () => {
  const scenario = getNecessityScenarios(['opus']).find(({ id }) => id.endsWith('/multi-turn-reuse-05'))!
  expect(scenario.promptExpectation?.expectEvidenceCoverage).toBe(
    'Give React’s latest GitHub release tag and publication date supported by the source.',
  )
  expect(scenario.promptCriteria).toMatchObject({ minToolCalls: 1, maxToolCalls: 2, expectEvidenceCoverage: true })
})

test('false-premise evidence is scoped to the central correction while rebuttal remains required', () => {
  const scenarios = getNecessityScenarios(['opus']).filter(({ category }) => category === 'false_premise')
  expect(scenarios).toHaveLength(8)
  for (const scenario of scenarios) {
    expect(scenario.criteria).toMatchObject({
      minToolCalls: 1,
      maxToolCalls: 3,
      expectPremiseRebuttal: true,
      expectEvidenceCoverage: true,
    })
    expect(scenario.expectation?.expectEvidenceCoverage).toContain('only for the central corrected fact')
    expect(scenario.expectation?.expectEvidenceCoverage).toContain(
      'Background history and side details are not graded for evidence support',
    )
    expect(scenario.expectation?.expectPremiseRebuttal).toBeTruthy()
  }
})

test.each([false, true])(
  'a non-weather no-web scenario cannot drop correctness (weather criterion=%s)',
  (weatherCriterion) => {
    const scenario = getNecessityScenarios(['opus']).find(({ id }) => id.endsWith('/never-search-01'))!
    const mutant: EvalScenario = {
      ...scenario,
      criteria: {
        ...scenario.criteria,
        expectCorrectAnswer: undefined,
        ...(weatherCriterion ? { mustUseWidget: 'weather-forecast' } : {}),
      },
      expectation: undefined,
    }
    expect(() => assertScenarioSemantics(scenario)).not.toThrow()
    expect(() => assertScenarioSemantics(mutant)).toThrow()
  },
)
