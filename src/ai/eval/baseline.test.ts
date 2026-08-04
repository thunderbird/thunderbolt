/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareMetricsToBaselines, loadBaselineFiles, type EvalBaseline, writeBaselineFiles } from './baseline'
import { wilsonScoreInterval } from './stats'
import type { NecessityCategoryMetrics, NecessityMetrics, NecessityMetricsGroup, NecessityRateMetric } from './types'

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
}: {
  categoryPassed: number
  unnecessaryCount: number
  missedCount: number
  meanWebCalls: number
}): NecessityMetricsGroup => ({
  model: 'opus',
  engine: 'pi',
  scenarios: {},
  categories: { never_search: categoryMetric(categoryPassed, 10) },
  headline: {
    unnecessarySearchRate: rateMetric(unnecessaryCount, 10),
    missedSearchRate: rateMetric(missedCount, 10),
    meanWebCallsNoSearchExpected: meanWebCalls,
  },
})

const metrics = (groupValue: NecessityMetricsGroup): NecessityMetrics => ({
  schemaVersion: 1,
  generatedAt: '2026-08-04T12:00:00.000Z',
  groups: { 'opus/pi': groupValue },
})

const baseline = (groupValue: NecessityMetricsGroup): EvalBaseline => ({
  schemaVersion: 1,
  generatedAt: '2026-08-03T12:00:00.000Z',
  groupKey: 'opus/pi',
  group: groupValue,
})

describe('baseline files', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-eval-baseline-'))

  afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }))

  test('writes one reviewable file per model and engine cell and loads it back', () => {
    const source = metrics(group({ categoryPassed: 8, unnecessaryCount: 2, missedCount: 1, meanWebCalls: 0.2 }))
    const stalePath = join(outputDirectory, 'retired--legacy.json')
    writeFileSync(stalePath, '{}')

    const written = writeBaselineFiles(source, outputDirectory)
    const contents = JSON.parse(readFileSync(written[0], 'utf8')) as EvalBaseline

    expect(existsSync(stalePath)).toBe(false)
    expect(written).toEqual([join(outputDirectory, 'opus--pi.json')])
    expect(contents).toEqual({
      schemaVersion: 1,
      generatedAt: source.generatedAt,
      groupKey: 'opus/pi',
      group: source.groups['opus/pi'],
    })
    expect(loadBaselineFiles(outputDirectory)).toEqual({ 'opus/pi': contents })
  })

  test('returns no baselines when the directory does not exist', () => {
    expect(loadBaselineFiles(join(outputDirectory, 'missing'))).toEqual({})
  })
})

describe('baseline comparison', () => {
  const baselineGroup = group({ categoryPassed: 8, unnecessaryCount: 2, missedCount: 2, meanWebCalls: 0.4 })
  const baselines = { 'opus/pi': baseline(baselineGroup) }

  test('marks only rates outside the baseline Wilson interval as significant', () => {
    const current = metrics(group({ categoryPassed: 10, unnecessaryCount: 0, missedCount: 8, meanWebCalls: 0.1 }))

    const comparison = compareMetricsToBaselines(current, baselines).groups['opus/pi']

    expect(comparison.categories.never_search).toMatchObject({
      baselineRate: 0.8,
      currentRate: 1,
      delta: 0.2,
      direction: 'improved',
      significant: true,
    })
    expect(comparison.headline.unnecessarySearchRate).toMatchObject({
      baselineRate: 0.2,
      currentRate: 0,
      delta: -0.2,
      direction: 'improved',
      significant: true,
    })
    expect(comparison.headline.missedSearchRate).toMatchObject({
      baselineRate: 0.2,
      currentRate: 0.8,
      delta: 0.6,
      direction: 'regressed',
      significant: true,
    })
    expect(comparison.headline.meanWebCallsNoSearchExpected).toEqual({
      baseline: 0.4,
      current: 0.1,
      delta: -0.3,
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
})
