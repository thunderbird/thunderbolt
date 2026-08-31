/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  EvalMetrics,
  EvalMetricsGroup,
  EvalResult,
  EvalScenarioMetrics,
  NecessityCategory,
  NecessityRateMetric,
  WilsonInterval,
} from './types'

export const categoryGateThresholds: Record<NecessityCategory, number> = {
  never_search: 0.95,
  answer_then_offer: 0.8,
  single_search: 0.9,
  research: 0.85,
  unknown_entity: 0.85,
  false_premise: 0.75,
  adversarial_no_search: 0.9,
  multi_turn_reuse: 0.9,
  search_wont_help: 0.6,
  // Following an explicit instruction about output language is close to
  // deterministic for a capable model, so this gates as tightly as never_search.
  language: 0.95,
}

const z95 = 1.959963984540054

/**
 * Calculate a two-sided 95% Wilson score interval for a binomial proportion.
 * Empty samples return a zero-width interval because they carry no observed rate.
 */
export const wilsonScoreInterval = (passed: number, total: number): WilsonInterval => {
  if (total === 0) {
    return { lower: 0, upper: 0 }
  }
  const proportion = passed / total
  const zSquared = z95 ** 2
  const denominator = 1 + zSquared / total
  const center = (proportion + zSquared / (2 * total)) / denominator
  const margin = (z95 * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total)) / denominator
  return {
    lower: passed === 0 ? 0 : Math.max(0, center - margin),
    upper: passed === total ? 1 : Math.min(1, center + margin),
  }
}

const modalNumber = (values: number[]): number => {
  const frequencies = new Map<number, number>()
  for (const value of values) {
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1)
  }
  return [...frequencies.entries()].sort(([leftValue, leftCount], [rightValue, rightCount]) => {
    const countDifference = rightCount - leftCount
    return countDifference !== 0 ? countDifference : rightValue - leftValue
  })[0][0]
}

/** Reduce independent samples to one strict-majority outcome and modal web-call metrics. */
export const modalResult = (samples: EvalResult[]): EvalResult => {
  if (samples.length === 0) {
    throw new Error('Cannot calculate a modal result without samples')
  }
  const scenarioId = samples[0].scenario.id
  if (samples.some(({ scenario }) => scenario.id !== scenarioId)) {
    throw new Error('Cannot combine samples from different scenarios')
  }
  const passedSampleCount = samples.filter(({ passed }) => passed).length
  const passed = passedSampleCount > samples.length / 2
  const errorSamples = samples.filter(({ error }) => error)
  const representative = samples.find((sample) => sample.passed === passed) ?? samples[0]
  const failures = passed ? [] : [...new Set(samples.flatMap((sample) => sample.failures))]

  return {
    ...representative,
    passed,
    failures,
    toolCallCount: modalNumber(samples.map(({ toolCallCount }) => toolCallCount)),
    duplicateToolCallCount: modalNumber(samples.map(({ duplicateToolCallCount }) => duplicateToolCallCount)),
    retryCount: modalNumber(samples.map(({ retryCount }) => retryCount)),
    durationMs: samples.reduce((sum, sample) => sum + sample.durationMs, 0),
    error: passed
      ? undefined
      : errorSamples
          .map(({ error }) => error)
          .filter(Boolean)
          .join('; ') || undefined,
    sampleCount: samples.length,
    passedSampleCount,
    errorSampleCount: errorSamples.length,
  }
}

const rateMetric = (count: number, total: number, threshold: number): NecessityRateMetric => {
  const rate = total === 0 ? 0 : count / total
  return { count, total, rate, threshold, gatePassed: total > 0 && rate <= threshold }
}

const isNoSearchExpected = (result: EvalResult): boolean =>
  result.scenario.category === 'never_search' ||
  result.scenario.category === 'answer_then_offer' ||
  result.scenario.category === 'adversarial_no_search' ||
  (result.scenario.category === 'multi_turn_reuse' && !result.scenario.isNegativeControl)

const isSearchExpected = (result: EvalResult): boolean =>
  result.scenario.category === 'single_search' ||
  result.scenario.category === 'research' ||
  result.scenario.category === 'unknown_entity' ||
  result.scenario.category === 'false_premise' ||
  (result.scenario.category === 'multi_turn_reuse' && result.scenario.isNegativeControl === true)

const aggregateGroup = (results: EvalResult[]): EvalMetricsGroup => {
  const first = results[0]
  const necessityResults = results.filter(({ scenario }) => scenario.category)
  const categories: EvalMetricsGroup['categories'] = {}
  const categoryNames = [...new Set(necessityResults.map(({ scenario }) => scenario.category))]
  for (const category of categoryNames) {
    if (!category) {
      continue
    }
    const categoryResults = results.filter(({ scenario }) => scenario.category === category)
    const passed = categoryResults.filter((result) => result.passed).length
    const total = categoryResults.length
    const threshold = categoryGateThresholds[category]
    const rate = passed / total
    categories[category] = {
      passed,
      total,
      rate,
      wilson: wilsonScoreInterval(passed, total),
      threshold,
      gatePassed: rate >= threshold,
    }
  }

  const noSearchExpected = necessityResults.filter(isNoSearchExpected)
  const searchExpected = necessityResults.filter(isSearchExpected)
  const unnecessarySearches = noSearchExpected.filter(({ toolCallCount }) => toolCallCount > 0).length
  const missedSearches = searchExpected.filter(({ toolCallCount }) => toolCallCount === 0).length
  const scenarios = Object.fromEntries(
    results.map((result) => {
      const category = result.scenario.category ?? 'core'
      const reviewDate = result.scenario.reviewBy
      if (category !== 'core' && !reviewDate) {
        throw new Error(`Missing necessity metadata for ${result.scenario.id}`)
      }
      const id = result.scenario.id.split('/').at(-1)
      if (!id) {
        throw new Error(`Invalid eval scenario id: ${result.scenario.id}`)
      }
      const scenarioMetrics: EvalScenarioMetrics = {
        prompt: result.scenario.followUps?.at(-1) ?? result.scenario.prompt,
        category,
        passed: result.passed,
        webToolCalls: result.toolCallCount,
        duplicateWebToolCalls: result.duplicateToolCallCount,
        sampleCount: result.sampleCount ?? 1,
        passedSampleCount: result.passedSampleCount ?? Number(result.passed),
        errorSampleCount: result.errorSampleCount ?? Number(Boolean(result.error)),
        isNegativeControl: result.scenario.isNegativeControl ?? false,
        reviewBy: category === 'core' ? null : (reviewDate ?? null),
        failures: result.failures,
      }
      return [id, scenarioMetrics]
    }),
  )

  return {
    model: first.scenario.modelName,
    engine: first.scenario.engineName,
    scenarios,
    categories,
    headline: {
      unnecessarySearchRate: rateMetric(unnecessarySearches, noSearchExpected.length, 0.05),
      missedSearchRate: rateMetric(missedSearches, searchExpected.length, 0.05),
      meanWebCallsNoSearchExpected:
        noSearchExpected.length === 0
          ? 0
          : noSearchExpected.reduce((sum, result) => sum + result.toolCallCount, 0) / noSearchExpected.length,
    },
  }
}

/** Aggregate every scored outcome while limiting necessity gates to taxonomy scenarios. */
export const aggregateEvalMetrics = (results: EvalResult[], generatedAt = new Date().toISOString()): EvalMetrics => {
  const grouped = new Map<string, EvalResult[]>()
  for (const result of results) {
    const key = `${result.scenario.modelName}/${result.scenario.engineName}`
    const group = grouped.get(key)
    if (group) {
      group.push(result)
    } else {
      grouped.set(key, [result])
    }
  }
  return {
    schemaVersion: 3,
    generatedAt,
    groups: Object.fromEntries(
      [...grouped.entries()].map(([key, groupResults]) => [key, aggregateGroup(groupResults)]),
    ),
  }
}
