/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wilsonScoreInterval } from './stats'
import type { NecessityCategory, NecessityMetrics, NecessityMetricsGroup, WilsonInterval } from './types'

export type EvalBaseline = {
  schemaVersion: 1
  generatedAt: string
  groupKey: string
  group: NecessityMetricsGroup
}

export type RateComparison = {
  baselineRate: number | null
  currentRate: number
  delta: number | null
  baselineWilson: WilsonInterval | null
  significant: boolean
  direction: 'improved' | 'regressed' | 'unchanged' | 'no-baseline'
}

export type EvalGroupComparison = {
  baselineAvailable: boolean
  gatesPassed: boolean
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
    significant: currentRate < baselineWilson.lower || currentRate > baselineWilson.upper,
    direction,
  }
}

/** Write one deterministic baseline file per model and engine cell. */
export const writeBaselineFiles = (metrics: NecessityMetrics, outputDirectory: string): string[] => {
  mkdirSync(outputDirectory, { recursive: true })
  for (const fileName of readdirSync(outputDirectory).filter((name) => name.endsWith('.json'))) {
    rmSync(join(outputDirectory, fileName))
  }
  return Object.entries(metrics.groups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupKey, group]) => {
      const outputPath = join(outputDirectory, `${groupKey.replace('/', '--')}.json`)
      const baseline: EvalBaseline = {
        schemaVersion: 1,
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

/** Compare current eval rates with checked-in baselines using each baseline's Wilson interval. */
export const compareMetricsToBaselines = (
  metrics: NecessityMetrics,
  baselines: Record<string, EvalBaseline>,
): EvalMetricsComparison => ({
  generatedAt: metrics.generatedAt,
  groups: Object.fromEntries(
    Object.entries(metrics.groups).map(([groupKey, current]) => {
      const baseline = baselines[groupKey]?.group
      const categories = Object.fromEntries(
        Object.entries(current.categories).map(([category, categoryMetrics]) => {
          const baselineCategory = baseline?.categories[category as NecessityCategory]
          return [
            category,
            compareRate(
              categoryMetrics.rate,
              baselineCategory?.rate ?? null,
              baselineCategory ? wilsonScoreInterval(baselineCategory.passed, baselineCategory.total) : null,
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
          categories,
          headline: {
            unnecessarySearchRate: compareRate(
              current.headline.unnecessarySearchRate.rate,
              baselineUnnecessary?.rate ?? null,
              baselineUnnecessary ? wilsonScoreInterval(baselineUnnecessary.count, baselineUnnecessary.total) : null,
              'lower',
            ),
            missedSearchRate: compareRate(
              current.headline.missedSearchRate.rate,
              baselineMissed?.rate ?? null,
              baselineMissed ? wilsonScoreInterval(baselineMissed.count, baselineMissed.total) : null,
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
