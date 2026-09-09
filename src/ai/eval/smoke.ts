/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EvalScenario } from './types'

const smokeScenarioIds = new Set([
  'C1',
  'S1',
  'R1',
  'never-search-01',
  'answer-then-offer-01',
  'single-search-01',
  'research-01',
  'unknown-entity-01',
  'false-premise-01',
  'adversarial-no-search-01',
  'multi-turn-reuse-01',
  'search-wont-help-01',
  'language-establish-01',
  'language-sticky-paste-01',
])

/** Select the fixed, reviewable scenario subset used by pull-request smoke runs. */
export const selectSmokeScenarios = (scenarios: EvalScenario[]): EvalScenario[] =>
  scenarios.filter(({ id }) => smokeScenarioIds.has(id.split('/').at(-1) ?? ''))

/** Resolve sample count while keeping smoke runs to one model call per scenario. */
export const getScenarioSampleCount = (scenario: EvalScenario, necessitySamples: number, smoke: boolean): number =>
  smoke ? 1 : scenario.category ? necessitySamples : 1
