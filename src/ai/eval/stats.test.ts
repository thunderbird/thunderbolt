/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  acceptEval,
  aggregateEvalMetrics,
  categoryGateThresholds,
  createManifest,
  getSystemPromptVersion,
  passThree,
  positiveFinite,
  scenarioInterval,
  trialVerdict,
} from './stats'
import { fixtureManifest, fixtureMetrics, fixtureScenario, fixtureTrial } from './test-fixtures'

describe('scenario aggregation (replaces strict majority and modal tool counts)', () => {
  test.each([
    [2, 0, 1, 'pass', 'partial'],
    [1, 1, 1, 'flaky', 'partial'],
    [0, 0, 3, 'none', 'error'],
    [3, 0, 0, 'pass', 'complete'],
    [0, 3, 0, 'fail', 'complete'],
    [1, 2, 0, 'flaky', 'complete'],
  ] as const)('labels c=%d f=%d e=%d independently', (c, f, e, behaviour, completeness) => {
    const scenario = fixtureScenario()
    const trials = Array.from({ length: c + f }, (_, index) => fixtureTrial(scenario, index, index < c))
    const metrics = aggregateEvalMetrics(fixtureManifest(), trials)
    expect(metrics.groups['opus/pi'].scenarios[scenario.id]).toMatchObject({ c, f, e, n: 3, behaviour, completeness })
  })

  test('two passes and one failure score 2/3 and retain every trial', () => {
    const metrics = fixtureMetrics(2)
    expect(metrics.trials).toHaveLength(3)
    expect(metrics.groups['opus/pi'].categories.never_search.rate).toBeCloseTo(2 / 3)
    expect(metrics.groups['opus/pi'].categories.never_search.state).toBe('fail')
  })

  test('errors are excluded from quality but counted in completeness', () => {
    const scenario = fixtureScenario()
    const trials = [
      fixtureTrial(scenario, 0),
      fixtureTrial(scenario, 1),
      fixtureTrial(scenario, 2, false, 'judge_error'),
    ]
    const group = aggregateEvalMetrics(fixtureManifest(), trials).groups['opus/pi']
    expect(group.categories.never_search).toMatchObject({ rate: 1, state: 'unmeasured', valid: 2, planned: 3 })
    expect(group.reliability.rate).toBeCloseTo(1 / 3)
  })

  test('equal weights scenario means despite unequal valid denominators', () => {
    const a = fixtureScenario('a')
    const b = fixtureScenario('b')
    const trials = [fixtureTrial(a, 0), fixtureTrial(a, 1), fixtureTrial(a, 2, false), fixtureTrial(b, 0, false)]
    const category = aggregateEvalMetrics(fixtureManifest([a, b]), trials).groups['opus/pi'].categories.never_search
    expect(category.rate).toBeCloseTo(1 / 3)
    expect(category.endToEnd).toBeCloseTo(1 / 3)
    expect(category.interval?.scenarios).toBe(2)
  })

  test('an entirely missing required scenario makes its category unmeasured even at 80% coverage', () => {
    const scenarios = Array.from({ length: 5 }, (_, index) => fixtureScenario(String(index)))
    const trials = scenarios.slice(0, 4).map((scenario) => fixtureTrial(scenario))
    const category = aggregateEvalMetrics(fixtureManifest(scenarios, 1), trials).groups['opus/pi'].categories
      .never_search
    expect(category.state).toBe('unmeasured')
    expect(category.valid / category.planned).toBe(0.8)
  })

  test('80% coverage is measured if every required scenario has a valid trial', () => {
    const manifest = fixtureManifest(undefined, 5)
    const category = aggregateEvalMetrics(
      manifest,
      Array.from({ length: 4 }, (_, index) => fixtureTrial(undefined, index)),
    ).groups['opus/pi'].categories.never_search
    expect(category.state).toBe('pass')
    expect(category.endToEnd).toBe(0.8)
  })

  test('unselected categories and language-only search headlines are not applicable', () => {
    const scenario = fixtureScenario('language', 'language')
    const group = aggregateEvalMetrics(fixtureManifest([scenario], 1), [fixtureTrial(scenario)]).groups['opus/pi']
    expect(group.categories.never_search.state).toBe('not_applicable')
    expect(group.categories.language.state).toBe('pass')
    expect(group.headline.unnecessarySearchRate.state).toBe('not_applicable')
    expect(acceptEval(aggregateEvalMetrics(fixtureManifest([scenario], 1), [fixtureTrial(scenario)])).exitCode).toBe(0)
  })
})

describe('consistency and uncertainty', () => {
  test.each([
    [3, 3, 1],
    [2, 3, 0],
    [3, 4, 0.25],
    [4, 4, 1],
    [2, 4, 0],
  ] as const)('pass^3 for %d/%d is %d', (c, n, expected) => expect(passThree(c, n)).toBe(expected))
  test('reports eligible / required scenario coverage and omits consistency for smoke or samples <3', () => {
    const a = fixtureScenario('a'),
      b = fixtureScenario('b')
    const manifest = fixtureManifest([a, b])
    const trials = [fixtureTrial(a, 0), fixtureTrial(a, 1), fixtureTrial(a, 2), fixtureTrial(b, 0)]
    expect(aggregateEvalMetrics(manifest, trials).groups['opus/pi'].categories.never_search.pass3).toEqual({
      rate: 1,
      eligible: 1,
      required: 2,
    })
    expect(
      aggregateEvalMetrics({ ...manifest, smoke: true }, trials).groups['opus/pi'].categories.never_search.pass3,
    ).toBeUndefined()
    expect(
      aggregateEvalMetrics(fixtureManifest([a], 1), []).groups['opus/pi'].categories.never_search.pass3,
    ).toBeUndefined()
    expect(passThree(2, 2)).toBeNull()
  })
  test('SEM uses sample variance of scenario means and flags small or zero-variance sets', () => {
    expect(scenarioInterval([0, 1])).toMatchObject({ margin: 0.98, lower: -0.48, upper: 1.48, flagged: true })
    expect(scenarioInterval([1, 1, 1, 1, 1])?.flagged).toBe(true)
    expect(scenarioInterval([0, 0, 1, 1, 1])?.flagged).toBe(false)
    expect(scenarioInterval([])).toBeNull()
    expect(scenarioInterval([1])?.label).toContain('over 1 scenarios; paraphrase families are correlated')
  })
})

describe('headline bounds and reliability', () => {
  test('headlines use final-turn bounds, valid necessity trials, and no modal counts', () => {
    const no = fixtureScenario('no', 'research')
    const yes = { ...fixtureScenario('yes', 'never_search'), criteria: { mustProduceOutput: true, minToolCalls: 1 } }
    const optional = { ...fixtureScenario('optional'), criteria: { mustProduceOutput: true } }
    const excluded = fixtureScenario('excluded', 'search_wont_help')
    const language = fixtureScenario('lang', 'language')
    const noTrials = [fixtureTrial(no, 0), fixtureTrial(no, 1), fixtureTrial(no, 2, false, 'infra_error')]
    noTrials[0].attempts[0].result.toolCallCount = 3
    const trials = [...noTrials, ...[yes, optional, excluded, language].map((scenario) => fixtureTrial(scenario))]
    const headline = aggregateEvalMetrics(fixtureManifest([no, yes, optional, excluded, language]), trials).groups[
      'opus/pi'
    ].headline
    expect(headline.unnecessarySearchRate).toMatchObject({ count: 1, total: 2, rate: 0.5, state: 'fail' })
    expect(headline.missedSearchRate).toMatchObject({ count: 1, total: 1, rate: 1 })
    expect(headline.meanWebCallsNoSearchExpected).toBe(1.5)
  })

  test('a proven failure stays valid and counts only in first-attempt error diagnostics', () => {
    const trial = fixtureTrial(undefined, 0, false, 'infra_error')
    trial.attempts[0].provenFailure = true
    trial.attempts[0].verdicts.maxToolCalls = 'fail'
    const metrics = aggregateEvalMetrics(fixtureManifest(undefined, 1), [trial])
    expect(trialVerdict(trial)).toBe('fail')
    expect(metrics.groups['opus/pi'].reliability).toMatchObject({ errors: 0, rate: 0, firstAttemptErrorRate: 1 })
    expect(acceptEval(metrics).exitCode).toBe(1)
  })

  test('recovered tool problems are diagnostics, with per-trial rates', () => {
    const trial = fixtureTrial()
    trial.attempts[0].toolEvents = { toolInfraError: 2, toolMisuse: 1, budgetDenial: 1 }
    const metrics = aggregateEvalMetrics(fixtureManifest(undefined, 1), [trial])
    expect(acceptEval(metrics).exitCode).toBe(0)
    expect(metrics.groups['opus/pi'].reliability).toMatchObject({ rate: 0, toolInfraErrorRate: 1, toolMisuseRate: 1 })
  })

  test('timeout is a valid behavioural failure, not a reliability error', () => {
    const metrics = aggregateEvalMetrics(fixtureManifest(undefined, 1), [fixtureTrial(undefined, 0, false, 'timeout')])
    expect(metrics.groups['opus/pi'].scenarios[fixtureScenario().id]).toMatchObject({ c: 0, f: 1, e: 0 })
    expect(acceptEval(metrics).exitCode).toBe(1)
  })
})

describe('shared acceptance', () => {
  test('precedence is crash/reliability 2, quality/core/coverage 1, pass 0', () => {
    expect(acceptEval(fixtureMetrics()).exitCode).toBe(0)
    expect(acceptEval(fixtureMetrics(2)).exitCode).toBe(1)
    expect(acceptEval({ ...fixtureMetrics(2), harnessCrashed: true }).exitCode).toBe(2)
    expect(acceptEval(aggregateEvalMetrics(fixtureManifest(), [])).exitCode).toBe(2)
  })
  test('each cell gates reliability; a large healthy cell cannot hide a failing small cell', () => {
    const a = fixtureScenario()
    const b = { ...fixtureScenario('small'), id: 'flash/pi/chat/small', modelName: 'flash' }
    const manifest = fixtureManifest([a, b], 20)
    manifest.scenarios[1].planned = 1
    const metrics = aggregateEvalMetrics(
      manifest,
      Array.from({ length: 20 }, (_, index) => fixtureTrial(a, index)),
    )
    expect(metrics.pooledErrorRate).toBeLessThan(0.1)
    expect(acceptEval(metrics).cells['flash/pi'].exitCode).toBe(2)
  })
  test('10% post-retry errors pass reliability, more than 10% do not', () => {
    const manifest = fixtureManifest(undefined, 10)
    const trials = Array.from({ length: 9 }, (_, index) => fixtureTrial(undefined, index))
    expect(acceptEval(aggregateEvalMetrics(manifest, trials)).exitCode).toBe(0)
    expect(acceptEval(aggregateEvalMetrics(manifest, trials.slice(1))).exitCode).toBe(2)
  })
  test('missing cells and categories are non-passing; no vacuous empty-matrix pass', () => {
    expect(acceptEval({ ...fixtureMetrics(), groups: {} }).exitCode).toBe(1)
    const metrics = fixtureMetrics()
    metrics.groups['opus/pi'].categories.never_search.state = 'not_applicable'
    expect(acceptEval(metrics).exitCode).toBe(1)
    expect(acceptEval({ ...metrics, manifest: { ...metrics.manifest, cells: [] } }).exitCode).toBe(1)
  })
  test('core uses any-failure semantics', () => {
    const scenario = { ...fixtureScenario('core'), category: undefined }
    const metrics = aggregateEvalMetrics(fixtureManifest([scenario]), [fixtureTrial(scenario, 0, false)])
    expect(metrics.groups['opus/pi'].corePassed).toBe(false)
    expect(acceptEval(metrics).exitCode).toBe(1)
  })
  test('filtered runs are partial and thresholds stay unchanged', () => {
    const base = fixtureManifest()
    const manifest = createManifest([fixtureScenario()], base, { EVAL_MODELS: 'opus' })
    expect(acceptEval(aggregateEvalMetrics(manifest, [])).partial).toBe(true)
    expect(categoryGateThresholds).toEqual({
      never_search: 0.95,
      answer_then_offer: 0.8,
      single_search: 0.9,
      research: 0.85,
      unknown_entity: 0.85,
      false_premise: 0.75,
      adversarial_no_search: 0.9,
      multi_turn_reuse: 0.9,
      search_wont_help: 0.6,
      language: 0.95,
    })
  })
  test('scenario filters are recorded and mark runs partial', () => {
    const manifest = createManifest([fixtureScenario()], fixtureManifest(), { EVAL_SCENARIOS: 'never-search-01' })
    expect(manifest.settings.EVAL_SCENARIOS).toBe('never-search-01')
    expect(manifest.partial).toBe(true)
  })
  test('invalid and duplicate trial identities fail loudly', () => {
    const trial = fixtureTrial()
    expect(() => aggregateEvalMetrics(fixtureManifest(), [trial, trial])).toThrow('duplicate')
    expect(() => aggregateEvalMetrics(fixtureManifest(), [fixtureTrial(undefined, 10)])).toThrow('Unexpected')
  })
})

test('deadlines are positive finite numbers and generation defaults to 600000', () => {
  expect(fixtureManifest().timeout).toBe(600000)
  expect(fixtureManifest().judgeTimeout).toBe(60000)
  for (const value of ['0', '-1', 'NaN', 'Infinity', '', '123abc']) {
    expect(() => positiveFinite(value, 1, 'deadline')).toThrow()
  }
})

test('a recovered first judge error remains visible with a separate generation/judge breakdown', () => {
  const trial = fixtureTrial()
  trial.attempts[0].result.judgeAttempts = [
    { status: 'judge_error', error: 'upstream unavailable', durationMs: 2 },
    { status: 'completed', durationMs: 3 },
  ]
  const metrics = aggregateEvalMetrics(fixtureManifest(undefined, 1), [trial])
  expect(metrics.groups['opus/pi'].reliability).toMatchObject({
    errors: 0,
    firstAttemptErrors: 1,
    firstAttemptErrorRate: 1,
    firstAttemptGenerationErrors: 0,
    firstAttemptJudgeErrors: 1,
  })
  expect(acceptEval(metrics).exitCode).toBe(0)
})

test('prompt identity includes imported web instructions and the research skill', () => {
  const inputs: string[] = []
  const original = getSystemPromptVersion((path) => {
    inputs.push(path)
    return path
  })
  expect(inputs).toContain('../prompts/web-tools.ts')
  expect(inputs).toContain('../../defaults/skills.ts')
  for (const changed of inputs) {
    expect(getSystemPromptVersion((path) => path + (path === changed ? ' edited' : ''))).not.toBe(original)
  }
  expect(getSystemPromptVersion()).toMatch(/^[a-f0-9]{64}$/)
  expect(getSystemPromptVersion()).toBe(getSystemPromptVersion())
})
