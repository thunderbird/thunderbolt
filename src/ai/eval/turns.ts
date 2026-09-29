/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  semanticCriterionKeys,
  type EvalCriteria,
  type EvalExpectation,
  type EvalScenario,
  type EvalTurn,
} from './types'

/** Reject expectation prose unless it is bound to an enabled semantic assertion. */
export const validateExpectation = (criteria?: EvalCriteria, expectation?: EvalExpectation): void => {
  for (const key of Object.keys(expectation ?? {}) as (keyof EvalCriteria)[]) {
    if (!(semanticCriterionKeys as readonly string[]).includes(key)) {
      throw new Error(`Expectation requires a semantic assertion: ${key}`)
    }
    if (criteria?.[key] === undefined || criteria[key] === false) {
      throw new Error(`Expectation for undeclared assertion: ${key}`)
    }
  }
}

/** Normalize legacy follow-ups; scenario criteria always belong exclusively to the final turn. */
export const getScenarioTurns = (scenario: EvalScenario): EvalTurn[] => {
  const followUps = (scenario.followUps ?? []).map((turn) => (typeof turn === 'string' ? { prompt: turn } : turn))
  const last = followUps.at(-1)
  if (last?.criteria || last?.expectation) {
    throw new Error(`${scenario.id}: final follow-up criteria/expectation must be on the scenario`)
  }
  if (!last && (scenario.promptCriteria || scenario.promptExpectation)) {
    throw new Error(`${scenario.id}: promptCriteria/promptExpectation require a multi-turn scenario`)
  }
  const turns: EvalTurn[] = [
    { prompt: scenario.prompt, criteria: scenario.promptCriteria, expectation: scenario.promptExpectation },
    ...followUps,
  ]
  turns[turns.length - 1] = {
    prompt: turns.at(-1)!.prompt,
    criteria: scenario.criteria,
    expectation: scenario.expectation,
  }
  for (const [index, turn] of turns.entries()) {
    validateExpectation(turn.criteria, turn.expectation)
    if (turn.criteria?.expectReuseFidelity && index === 0) {
      throw new Error(`${scenario.id}: reuse fidelity requires an earlier turn`)
    }
  }
  return turns
}
