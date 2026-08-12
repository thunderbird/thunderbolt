/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareMetricsToBaselines, loadBaselineFiles, type EvalBaseline, writeBaselineFiles } from './baseline'
import { wilsonScoreInterval } from './stats'
import type { EvalMetrics, EvalMetricsGroup, NecessityCategoryMetrics, NecessityRateMetric } from './types'

const expectedCells = [
  { groupKey: 'flash/pi', model: 'flash', engine: 'pi' },
  { groupKey: 'opus/pi', model: 'opus', engine: 'pi' },
] satisfies ReadonlyArray<{
  groupKey: string
  model: string
  engine: EvalMetricsGroup['engine']
}>

const expectedGroupKeys = expectedCells.map(({ groupKey }) => groupKey)

const categoryMetric = (passed: number, total: number): NecessityCategoryMetrics => ({
  passed,
  total,
  rate: passed / total,
  wilson: wilsonScoreInterval(passed, total),
  threshold: 0.8,
  gatePassed: passed / total >= 0.8,
})

const rateMetric = (count: number, total: number): NecessityRateMetric => ({
  count,
  total,
  rate: count / total,
  threshold: 0.05,
  gatePassed: count / total <= 0.05,
})

const group = ({
  categoryPassed,
  unnecessaryCount,
  missedCount,
  meanWebCalls,
  corePassed = true,
  total = 10,
}: {
  categoryPassed: number
  unnecessaryCount: number
  missedCount: number
  meanWebCalls: number
  corePassed?: boolean
  total?: number
}): EvalMetricsGroup => ({
  model: 'opus',
  engine: 'pi',
  scenarios: {
    C1: {
      prompt: 'What are the top stories today?',
      category: 'core',
      passed: corePassed,
      webToolCalls: 0,
      duplicateWebToolCalls: 0,
      sampleCount: 1,
      passedSampleCount: Number(corePassed),
      errorSampleCount: 0,
      isNegativeControl: false,
      reviewBy: null,
      failures: corePassed ? [] : ['failed'],
    },
  },
  categories: { never_search: categoryMetric(categoryPassed, total) },
  headline: {
    unnecessarySearchRate: rateMetric(unnecessaryCount, total),
    missedSearchRate: rateMetric(missedCount, total),
    meanWebCallsNoSearchExpected: meanWebCalls,
  },
})

const metrics = (groupValue: EvalMetricsGroup): EvalMetrics => ({
  schemaVersion: 3,
  generatedAt: '2026-08-04T12:00:00.000Z',
  groups: { 'opus/pi': groupValue },
})

const fullMetrics = (groupValue: EvalMetricsGroup): EvalMetrics => ({
  schemaVersion: 3,
  generatedAt: '2026-08-04T12:00:00.000Z',
  groups: Object.fromEntries(
    expectedCells.map(({ groupKey, model, engine }) => [groupKey, { ...groupValue, model, engine }]),
  ),
})

const baseline = (groupValue: EvalMetricsGroup): EvalBaseline => ({
  schemaVersion: 2,
  generatedAt: '2026-08-03T12:00:00.000Z',
  groupKey: 'opus/pi',
  group: groupValue,
})

describe('baseline files', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-eval-baseline-'))

  afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }))

  test('writes every expected cell and removes stale files', () => {
    const fullOutputDirectory = mkdtempSync(join(outputDirectory, 'full-'))
    const source = fullMetrics(group({ categoryPassed: 8, unnecessaryCount: 2, missedCount: 1, meanWebCalls: 0.2 }))
    const stalePath = join(fullOutputDirectory, 'retired--legacy.json')
    writeFileSync(stalePath, '{}')

    const written = writeBaselineFiles(source, fullOutputDirectory, expectedGroupKeys)

    expect(existsSync(stalePath)).toBe(false)
    expect(written).toEqual(
      expectedGroupKeys.map((groupKey) => join(fullOutputDirectory, `${groupKey.replace('/', '--')}.json`)),
    )
    expect(loadBaselineFiles(fullOutputDirectory)).toEqual(
      Object.fromEntries(
        expectedGroupKeys.map((groupKey) => [
          groupKey,
          {
            schemaVersion: 3,
            generatedAt: source.generatedAt,
            groupKey,
            group: source.groups[groupKey],
          },
        ]),
      ),
    )
  })

  test('rejects partial metrics without changing existing baseline files', () => {
    const partialOutputDirectory = mkdtempSync(join(outputDirectory, 'partial-'))
    const existingPath = join(partialOutputDirectory, 'existing.json')
    const existingContents = '{"preserved":true}\n'
    const source = metrics(group({ categoryPassed: 8, unnecessaryCount: 2, missedCount: 1, meanWebCalls: 0.2 }))
    const missingGroupKeys = expectedGroupKeys.filter((groupKey) => !(groupKey in source.groups)).sort()
    writeFileSync(existingPath, existingContents)

    expect(() => writeBaselineFiles(source, partialOutputDirectory, expectedGroupKeys)).toThrow(
      `Cannot regenerate eval baselines from partial metrics. Missing model/engine cells: ${missingGroupKeys.join(', ')}. Baselines are regenerated only from full-matrix eval runs such as the nightly workflow; run "bun run eval" without EVAL_MODELS or EVAL_ENGINES.`,
    )
    expect(readdirSync(partialOutputDirectory)).toEqual(['existing.json'])
    expect(readFileSync(existingPath, 'utf8')).toBe(existingContents)
  })

  test('returns no baselines when the directory does not exist', () => {
    expect(loadBaselineFiles(join(outputDirectory, 'missing'))).toEqual({})
  })
})

describe('baseline comparison', () => {
  const baselineGroup = group({ categoryPassed: 8, unnecessaryCount: 2, missedCount: 2, meanWebCalls: 0.4 })
  const baselines = { 'opus/pi': baseline(baselineGroup) }

  test('marks rates as significant when current and baseline Wilson intervals are disjoint', () => {
    const fullBaseline = {
      'opus/pi': baseline(
        group({ categoryPassed: 6, unnecessaryCount: 6, missedCount: 6, meanWebCalls: 0.4, total: 12 }),
      ),
    }
    const current = metrics(
      group({
        categoryPassed: 12,
        unnecessaryCount: 0,
        missedCount: 12,
        meanWebCalls: 0.1,
        corePassed: false,
        total: 12,
      }),
    )

    const comparison = compareMetricsToBaselines(current, fullBaseline).groups['opus/pi']

    expect(comparison.categories.never_search).toMatchObject({
      baselineRate: 0.5,
      currentRate: 1,
      delta: 0.5,
      direction: 'improved',
      significant: true,
    })
    expect(comparison.headline.unnecessarySearchRate).toMatchObject({
      baselineRate: 0.5,
      currentRate: 0,
      delta: -0.5,
      direction: 'improved',
      significant: true,
    })
    expect(comparison.headline.missedSearchRate).toMatchObject({
      baselineRate: 0.5,
      currentRate: 1,
      delta: 0.5,
      direction: 'regressed',
      significant: true,
    })
    expect(comparison.headline.meanWebCallsNoSearchExpected).toEqual({
      baseline: 0.4,
      current: 0.1,
      delta: -0.3,
    })
    expect(comparison.scenarios.C1).toEqual({
      baselinePassed: true,
      currentPassed: false,
      direction: 'regressed',
    })
  })

  test('does not label a one-sample smoke change significant when its interval overlaps the baseline', () => {
    const smoke = metrics(group({ categoryPassed: 0, unnecessaryCount: 1, missedCount: 0, meanWebCalls: 1, total: 1 }))
    const fullBaseline = {
      'opus/pi': baseline(
        group({ categoryPassed: 10, unnecessaryCount: 0, missedCount: 10, meanWebCalls: 0, total: 10 }),
      ),
    }

    const comparison = compareMetricsToBaselines(smoke, fullBaseline).groups['opus/pi']

    expect(comparison.categories.never_search).toMatchObject({
      delta: -1,
      direction: 'regressed',
      significant: false,
    })
    expect(comparison.headline.unnecessarySearchRate).toMatchObject({
      delta: 1,
      direction: 'regressed',
      significant: false,
    })
    expect(comparison.headline.missedSearchRate).toMatchObject({
      delta: -1,
      direction: 'improved',
      significant: false,
    })
  })

  test('keeps a changed rate non-significant while it remains inside the baseline interval', () => {
    const current = metrics(group({ categoryPassed: 9, unnecessaryCount: 1, missedCount: 3, meanWebCalls: 0.5 }))

    const comparison = compareMetricsToBaselines(current, baselines).groups['opus/pi']

    expect(comparison.categories.never_search).toMatchObject({
      delta: 0.1,
      direction: 'improved',
      significant: false,
    })
    expect(comparison.headline.missedSearchRate).toMatchObject({
      delta: 0.1,
      direction: 'regressed',
      significant: false,
    })
  })

  test('reports current values without deltas when a cell has no baseline', () => {
    const comparison = compareMetricsToBaselines(
      metrics(group({ categoryPassed: 9, unnecessaryCount: 1, missedCount: 3, meanWebCalls: 0.5 })),
      {},
    ).groups['opus/pi']

    expect(comparison.baselineAvailable).toBe(false)
    expect(comparison.categories.never_search).toMatchObject({
      baselineRate: null,
      delta: null,
      direction: 'no-baseline',
      significant: false,
    })
    expect(comparison.headline.meanWebCallsNoSearchExpected).toEqual({
      baseline: null,
      current: 0.5,
      delta: null,
    })
  })

  test('compares schema v3 metrics with a schema v2 baseline that has no prompts', () => {
    const versionTwoGroup = group({
      categoryPassed: 8,
      unnecessaryCount: 2,
      missedCount: 2,
      meanWebCalls: 0.4,
    })
    const { prompt: _prompt, ...versionTwoScenario } = versionTwoGroup.scenarios.C1
    const versionTwoBaseline: EvalBaseline = {
      schemaVersion: 2,
      generatedAt: '2026-08-03T12:00:00.000Z',
      groupKey: 'opus/pi',
      group: {
        ...versionTwoGroup,
        scenarios: { C1: versionTwoScenario },
      },
    }
    const current = metrics(group({ categoryPassed: 9, unnecessaryCount: 1, missedCount: 3, meanWebCalls: 0.5 }))

    const comparison = compareMetricsToBaselines(current, { 'opus/pi': versionTwoBaseline }).groups['opus/pi']

    expect(comparison.baselineAvailable).toBe(true)
    expect(comparison.scenarios.C1.direction).toBe('unchanged')
    expect(comparison.categories.never_search?.delta).toBe(0.1)
  })
})
