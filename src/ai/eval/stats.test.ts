/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { aggregateEvalMetrics, modalResult, wilsonScoreInterval } from './stats'
import type { EvalResult, EvalScenario, NecessityCategory } from './types'

const scenario = (id: string, category?: NecessityCategory, isNegativeControl = false): EvalScenario => ({
  id: `opus/pi/chat/${id}`,
  modelName: 'opus',
  engineName: 'pi',
  modeName: 'chat',
  prompt: id,
  criteria: { mustProduceOutput: true },
  category,
  reviewBy: category ? '2026-11-04' : undefined,
  isNegativeControl,
})

const result = (scenarioValue: EvalScenario, passed: boolean, toolCallCount: number, error?: string): EvalResult => ({
  scenario: scenarioValue,
  passed,
  failures: passed ? [] : [error ?? 'failed'],
  responseText: passed ? 'answer' : '',
  responseLength: passed ? 6 : 0,
  citations: [],
  widgets: [],
  linkPreviewUrls: [],
  homepageUrls: [],
  reviewSiteUrls: [],
  toolCallCount,
  duplicateToolCallCount: 0,
  retryCount: 0,
  durationMs: 1,
  error,
})

describe('wilsonScoreInterval', () => {
  test('matches a known interval', () => {
    const interval = wilsonScoreInterval(5, 10)
    expect(interval.lower).toBeCloseTo(0.2366, 4)
    expect(interval.upper).toBeCloseTo(0.7634, 4)
  })

  test('handles no observations', () => {
    expect(wilsonScoreInterval(0, 0)).toEqual({ lower: 0, upper: 0 })
  })

  test('bounds all-fail and all-pass samples', () => {
    expect(wilsonScoreInterval(0, 10).lower).toBe(0)
    expect(wilsonScoreInterval(0, 10).upper).toBeCloseTo(0.2775, 4)
    expect(wilsonScoreInterval(10, 10).lower).toBeCloseTo(0.7225, 4)
    expect(wilsonScoreInterval(10, 10).upper).toBe(1)
  })
})

describe('modalResult', () => {
  const sampleScenario = scenario('never-search-01', 'never_search')

  test('passes with two passing samples out of three', () => {
    const modal = modalResult([
      result(sampleScenario, true, 0),
      result(sampleScenario, false, 1),
      result(sampleScenario, true, 0),
    ])

    expect(modal.passed).toBe(true)
    expect(modal.toolCallCount).toBe(0)
    expect(modal.sampleCount).toBe(3)
    expect(modal.passedSampleCount).toBe(2)
  })

  test('treats error samples as failures without overriding a two-of-three pass', () => {
    const modal = modalResult([
      result(sampleScenario, true, 0),
      result(sampleScenario, false, 0, 'judge failed'),
      result(sampleScenario, true, 0),
    ])

    expect(modal.passed).toBe(true)
    expect(modal.errorSampleCount).toBe(1)
  })

  test('fails when errors make up the majority', () => {
    const modal = modalResult([
      result(sampleScenario, false, 0, 'judge failed'),
      result(sampleScenario, false, 0, 'judge failed again'),
      result(sampleScenario, true, 0),
    ])

    expect(modal.passed).toBe(false)
    expect(modal.errorSampleCount).toBe(2)
    expect(modal.failures).toContain('judge failed')
  })
})

describe('aggregateEvalMetrics', () => {
  test('computes category gates and headline search rates', () => {
    const results = [
      result(scenario('C1'), false, 7),
      result(scenario('never-search-01', 'never_search'), true, 0),
      result(scenario('answer-then-offer-01', 'answer_then_offer'), false, 1),
      result(scenario('single-search-01', 'single_search'), true, 1),
      result(scenario('research-01', 'research'), false, 0),
      result(scenario('reuse-01', 'multi_turn_reuse'), true, 0),
      result(scenario('reuse-02', 'multi_turn_reuse', true), true, 1),
    ]

    const metrics = aggregateEvalMetrics(results, '2026-08-04T12:00:00.000Z')
    const group = metrics.groups['opus/pi']

    expect(metrics.schemaVersion).toBe(3)
    expect(group.scenarios.C1).toMatchObject({ prompt: 'C1', category: 'core', passed: false, reviewBy: null })
    expect(group.categories.never_search).toMatchObject({ passed: 1, total: 1, rate: 1, gatePassed: true })
    expect(group.headline.unnecessarySearchRate).toEqual({
      count: 1,
      total: 3,
      rate: 1 / 3,
      threshold: 0.05,
      gatePassed: false,
    })
    expect(group.headline.missedSearchRate).toEqual({
      count: 1,
      total: 3,
      rate: 1 / 3,
      threshold: 0.05,
      gatePassed: false,
    })
    expect(group.headline.meanWebCallsNoSearchExpected).toBeCloseTo(1 / 3)
  })
})
