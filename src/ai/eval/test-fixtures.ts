/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { aggregateEvalMetrics, createManifest } from './stats'
import { scoreResult } from './scoring'
import type { EvalAttempt, EvalManifest, EvalScenario, EvalTrial, ExecutionStatus, NecessityCategory } from './types'

/** Small deterministic fixtures shared by offline eval consumer tests. */
export const fixtureScenario = (
  id = 'never',
  category: NecessityCategory | undefined = 'never_search',
): EvalScenario => ({
  id: `opus/pi/chat/${id}`,
  modelName: 'opus',
  engineName: 'pi',
  modeName: 'chat',
  prompt: id,
  criteria: { mustProduceOutput: true, maxToolCalls: 0 },
  category,
  reviewBy: '2026-01-01',
})

/** Build a manifest from preselected test scenarios, without environment access. */
export const fixtureManifest = (scenarios = [fixtureScenario()], samples = 3): EvalManifest =>
  createManifest(scenarios, {
    cells: [
      ...new Map(
        scenarios.map((scenario) => [
          `${scenario.modelName}/${scenario.engineName}`,
          {
            key: `${scenario.modelName}/${scenario.engineName}`,
            model: scenario.modelName,
            engine: scenario.engineName,
            modelId: `${scenario.modelName}-actual`,
          },
        ]),
      ).values(),
    ],
    suites: ['necessity'],
    samples,
    scenarioConcurrency: Math.min(3, scenarios.length),
    judgeModelId: 'opus-actual',
    judgePromptVersion: 'v1',
    providerKind: 'local',
    preflight: {},
    treatment: {
      generationRevision: { commit: 'base', overlayCommit: null },
      systemPromptVersion: 'prompt-v1',
      WEB_BUDGET_PROMOTION: '0',
    },
  })

/** Construct a completed or unresolved attempt with independently controlled behaviour. */
export const fixtureAttempt = (
  scenario = fixtureScenario(),
  passed = true,
  status: ExecutionStatus = 'completed',
): EvalAttempt => {
  const stream = {
    text: 'answer',
    toolCalls: [],
    assistantParts: [],
    stepCount: 1,
    retryCount: 0,
    finishReason: 'stop',
    events: [],
  }
  const result = { ...scoreResult(scenario, stream, 1), passed, failures: passed ? [] : ['failed'] }
  return {
    threadId: crypto.randomUUID(),
    status,
    generationDurationMs: 1,
    judgeDurationMs: 0,
    streams: [stream],
    scoredTurnReached: true,
    result,
    verdicts: { mustProduceOutput: passed ? 'pass' : status === 'completed' ? 'fail' : 'unknown' },
    provenFailure: false,
    toolEvents: { toolInfraError: 0, toolMisuse: 0, budgetDenial: 0 },
    instrumentation: {
      emitted: 0,
      executed: 0,
      cacheHits: 0,
      initialCap: 2,
      finalCap: 2,
      promoted: false,
      researchSkill: { attempted: false, loaded: false, beforeFirstWebResult: null },
      preflight: {},
    },
  }
}

/** Preserve one attempt per planned index, with no modal reduction. */
export const fixtureTrial = (
  scenario = fixtureScenario(),
  index = 0,
  passed = true,
  status: ExecutionStatus = 'completed',
): EvalTrial => ({
  id: `${scenario.id}/${index}`,
  scenario,
  index,
  attempts: [fixtureAttempt(scenario, passed, status)],
})

/** Build a three-trial measured cell with a selectable pass count. */
export const fixtureMetrics = (passed = 3) => {
  const scenario = fixtureScenario()
  return aggregateEvalMetrics(
    fixtureManifest([scenario]),
    Array.from({ length: 3 }, (_, index) => fixtureTrial(scenario, index, index < passed)),
  )
}
