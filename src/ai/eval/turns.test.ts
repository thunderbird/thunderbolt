/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { fixtureScenario } from './test-fixtures'
import { getScenarioTurns } from './turns'

test('string follow-ups preserve final-only scenario criteria', () => {
  const scenario = { ...fixtureScenario(), followUps: ['follow up'] }
  const turns = getScenarioTurns(scenario)
  expect(turns[0].criteria).toBeUndefined()
  expect(turns[1]).toEqual({ prompt: 'follow up', criteria: scenario.criteria, expectation: undefined })
})

test('first and intermediate turns have independent declarations with no inheritance', () => {
  const turns = getScenarioTurns({
    ...fixtureScenario(),
    promptCriteria: { mustProduceOutput: true, expectSearchOffer: true },
    promptExpectation: { expectSearchOffer: 'Give a caveat and offer' },
    followUps: [
      {
        prompt: 'verify',
        criteria: { mustProduceOutput: true, expectEvidenceCoverage: true },
        expectation: { expectEvidenceCoverage: 'Use the price page' },
      },
      { prompt: 'repeat' },
    ],
  })
  expect(turns[0].criteria?.expectSearchOffer).toBe(true)
  expect(turns[1].criteria?.expectSearchOffer).toBeUndefined()
  expect(turns[1].criteria?.expectEvidenceCoverage).toBe(true)
  expect(turns[2].criteria?.expectEvidenceCoverage).toBeUndefined()
})

test('duplicate final declarations and unbound expectations fail before execution', () => {
  expect(() =>
    getScenarioTurns({ ...fixtureScenario(), followUps: [{ prompt: 'final', criteria: { mustProduceOutput: true } }] }),
  ).toThrow('final follow-up')
  expect(() => getScenarioTurns({ ...fixtureScenario(), expectation: { expectCorrectAnswer: 'unbound' } })).toThrow(
    'undeclared assertion',
  )
  expect(() => getScenarioTurns({ ...fixtureScenario(), promptCriteria: { mustProduceOutput: true } })).toThrow(
    'multi-turn',
  )
  const deterministicExpectation = { maxToolCalls: 'No searching', expectSearchOffer: 'Answer and offer' }
  expect(() =>
    getScenarioTurns({
      ...fixtureScenario(),
      criteria: { ...fixtureScenario().criteria, expectSearchOffer: true },
      expectation: deterministicExpectation,
    }),
  ).toThrow('Expectation requires a semantic assertion: maxToolCalls')
  expect(() =>
    getScenarioTurns({ ...fixtureScenario(), criteria: { mustProduceOutput: true, expectReuseFidelity: true } }),
  ).toThrow('earlier turn')
})

test('M1: deterministic expectation keys are rejected for first and intermediate turns', () => {
  const expectation = { minToolCalls: 'Search first', expectCorrectAnswer: 'Answer correctly' }
  const criteria = { mustProduceOutput: true, minToolCalls: 1, expectCorrectAnswer: true }
  expect(() =>
    getScenarioTurns({
      ...fixtureScenario(),
      promptCriteria: criteria,
      promptExpectation: expectation,
      followUps: ['final'],
    }),
  ).toThrow('Expectation requires a semantic assertion: minToolCalls')
  expect(() =>
    getScenarioTurns({ ...fixtureScenario(), followUps: [{ prompt: 'middle', criteria, expectation }, 'final'] }),
  ).toThrow('Expectation requires a semantic assertion: minToolCalls')
})
