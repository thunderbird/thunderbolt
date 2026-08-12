/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wilsonScoreInterval } from './stats'
import type {
  EvalMetrics,
  EvalMetricsGroup,
  EvalScenarioComparison,
  EvalScenarioMetrics,
  NecessityCategory,
  WilsonInterval,
} from './types'

type EvalBaselineGroup = Omit<EvalMetricsGroup, 'scenarios'> & {
  scenarios: Record<string, Omit<EvalScenarioMetrics, 'prompt'> & { prompt?: string }>
}

export type EvalBaseline = {
  schemaVersion: 2 | 3
  generatedAt: string
  groupKey: string
  group: EvalBaselineGroup
}

export type RateComparison = {
  baselineRate: number | null
  currentRate: number
  delta: number | null
  baselineWilson: WilsonInterval | null
  currentWilson: WilsonInterval | null
  significant: boolean
  direction: 'improved' | 'regressed' | 'unchanged' | 'no-baseline'
}

export type EvalGroupComparison = {
  baselineAvailable: boolean
  gatesPassed: boolean
  scenarios: Record<string, EvalScenarioComparison>
  categories: Partial<Record<NecessityCategory, RateComparison>>
  headline: {
    unnecessarySearchRate: RateComparison
    missedSearchRate: RateComparison
    meanWebCallsNoSearchExpected: {
      baseline: number | null
      current: number
      delta: number | null
    }
  }
}

export type EvalMetricsComparison = {
  generatedAt: string
  groups: Record<string, EvalGroupComparison>
}

const roundedDelta = (current: number, baseline: number): number => Number((current - baseline).toFixed(6))

const compareRate = (
  currentRate: number,
  currentWilson: WilsonInterval | null,
  baselineRate: number | null,
  baselineWilson: WilsonInterval | null,
  favorableDirection: 'higher' | 'lower',
): RateComparison => {
  if (baselineRate === null || baselineWilson === null) {
    return {
      baselineRate: null,
      currentRate,
      delta: null,
      baselineWilson: null,
      currentWilson,
      significant: false,
      direction: 'no-baseline',
    }
  }

  const delta = roundedDelta(currentRate, baselineRate)
  const direction =
    delta === 0
      ? 'unchanged'
      : (delta > 0 && favorableDirection === 'higher') || (delta < 0 && favorableDirection === 'lower')
        ? 'improved'
        : 'regressed'

  return {
    baselineRate,
    currentRate,
    delta,
    baselineWilson,
    currentWilson,
    significant:
      currentWilson !== null &&
      (currentWilson.upper < baselineWilson.lower || currentWilson.lower > baselineWilson.upper),
    direction,
  }
}

/** Write one deterministic baseline file per model and engine cell. */
export const writeBaselineFiles = (
  metrics: EvalMetrics,
  outputDirectory: string,
  expectedGroupKeys: ReadonlyArray<string>,
): string[] => {
  const missingGroupKeys = expectedGroupKeys.filter((groupKey) => !(groupKey in metrics.groups)).sort()
  if (missingGroupKeys.length > 0) {
    throw new Error(
      `Cannot regenerate eval baselines from partial metrics. Missing model/engine cells: ${missingGroupKeys.join(', ')}. Baselines are regenerated only from full-matrix eval runs such as the nightly workflow; run "bun run eval" without EVAL_MODELS or EVAL_ENGINES.`,
    )
  }

  mkdirSync(outputDirectory, { recursive: true })
  for (const fileName of readdirSync(outputDirectory).filter((name) => name.endsWith('.json'))) {
    rmSync(join(outputDirectory, fileName))
  }
  return Object.entries(metrics.groups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupKey, group]) => {
      const outputPath = join(outputDirectory, `${groupKey.replace('/', '--')}.json`)
      const baseline: EvalBaseline = {
        schemaVersion: 3,
        generatedAt: metrics.generatedAt,
        groupKey,
        group,
      }
      writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
      return outputPath
    })
}

/** Load all checked-in baseline cells, returning an empty map before the first refresh. */
export const loadBaselineFiles = (directory: string): Record<string, EvalBaseline> => {
  if (!existsSync(directory)) {
    return {}
  }
  return Object.fromEntries(
    readdirSync(directory)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort()
      .map((fileName) => {
        const baseline = JSON.parse(readFileSync(join(directory, fileName), 'utf8')) as EvalBaseline
        return [baseline.groupKey, baseline]
      }),
  )
}

/** Compare current eval rates with checked-in baselines using both runs' Wilson intervals. */
export const compareMetricsToBaselines = (
  metrics: EvalMetrics,
  baselines: Record<string, EvalBaseline>,
): EvalMetricsComparison => ({
  generatedAt: metrics.generatedAt,
  groups: Object.fromEntries(
    Object.entries(metrics.groups).map(([groupKey, current]) => {
      const baseline = baselines[groupKey]?.group
      const scenarios: Record<string, EvalScenarioComparison> = Object.fromEntries(
        Object.entries(current.scenarios).map(([scenarioId, scenario]) => {
          const baselinePassed = baseline?.scenarios[scenarioId]?.passed ?? null
          const direction: EvalScenarioComparison['direction'] =
            baselinePassed === null
              ? 'no-baseline'
              : scenario.passed === baselinePassed
                ? 'unchanged'
                : scenario.passed
                  ? 'improved'
                  : 'regressed'
          return [
            scenarioId,
            {
              baselinePassed,
              currentPassed: scenario.passed,
              direction,
            },
          ]
        }),
      )
      const categories = Object.fromEntries(
        Object.entries(current.categories).map(([category, categoryMetrics]) => {
          const baselineCategory = baseline?.categories[category as NecessityCategory]
          return [
            category,
            compareRate(
              categoryMetrics.rate,
              categoryMetrics.total > 0 ? categoryMetrics.wilson : null,
              baselineCategory?.rate ?? null,
              baselineCategory && baselineCategory.total > 0
                ? wilsonScoreInterval(baselineCategory.passed, baselineCategory.total)
                : null,
              'higher',
            ),
          ]
        }),
      )
      const baselineUnnecessary = baseline?.headline.unnecessarySearchRate
      const baselineMissed = baseline?.headline.missedSearchRate
      const baselineMean = baseline?.headline.meanWebCallsNoSearchExpected ?? null
      const gatesPassed =
        Object.values(current.categories).every(({ gatePassed }) => gatePassed) &&
        current.headline.unnecessarySearchRate.gatePassed &&
        current.headline.missedSearchRate.gatePassed

      return [
        groupKey,
        {
          baselineAvailable: Boolean(baseline),
          gatesPassed,
          scenarios,
          categories,
          headline: {
            unnecessarySearchRate: compareRate(
              current.headline.unnecessarySearchRate.rate,
              current.headline.unnecessarySearchRate.total > 0
                ? wilsonScoreInterval(
                    current.headline.unnecessarySearchRate.count,
                    current.headline.unnecessarySearchRate.total,
                  )
                : null,
              baselineUnnecessary?.rate ?? null,
              baselineUnnecessary && baselineUnnecessary.total > 0
                ? wilsonScoreInterval(baselineUnnecessary.count, baselineUnnecessary.total)
                : null,
              'lower',
            ),
            missedSearchRate: compareRate(
              current.headline.missedSearchRate.rate,
              current.headline.missedSearchRate.total > 0
                ? wilsonScoreInterval(current.headline.missedSearchRate.count, current.headline.missedSearchRate.total)
                : null,
              baselineMissed?.rate ?? null,
              baselineMissed && baselineMissed.total > 0
                ? wilsonScoreInterval(baselineMissed.count, baselineMissed.total)
                : null,
              'lower',
            ),
            meanWebCallsNoSearchExpected: {
              baseline: baselineMean,
              current: current.headline.meanWebCallsNoSearchExpected,
              delta:
                baselineMean === null
                  ? null
                  : roundedDelta(current.headline.meanWebCallsNoSearchExpected, baselineMean),
            },
          },
        } satisfies EvalGroupComparison,
      ]
    }),
  ),
})
