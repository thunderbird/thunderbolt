/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { wilsonScoreInterval } from '../../src/ai/eval/stats'
import type { EvalBaseline } from '../../src/ai/eval/baseline'
import type { EvalMetrics, EvalMetricsGroup } from '../../src/ai/eval/types'
import { evalCommentMarker, renderEvalComment, upsertEvalComment } from './post-eval-results'

const group = (): EvalMetricsGroup => ({
  model: 'opus',
  engine: 'pi',
  scenarios: {
    C1: {
      category: 'core',
      passed: false,
      webToolCalls: 0,
      duplicateWebToolCalls: 0,
      sampleCount: 1,
      passedSampleCount: 0,
      errorSampleCount: 0,
      isNegativeControl: false,
      reviewBy: null,
      failures: ['Insufficient citations: 0 found, 1 required'],
    },
    'never-search-01': {
      category: 'never_search',
      passed: false,
      webToolCalls: 1,
      duplicateWebToolCalls: 0,
      sampleCount: 1,
      passedSampleCount: 0,
      errorSampleCount: 0,
      isNegativeControl: false,
      reviewBy: '2026-11-04',
      failures: ['Too many web tool calls: 1 (max: 0)'],
    },
  },
  categories: {
    never_search: {
      passed: 0,
      total: 1,
      rate: 0,
      wilson: wilsonScoreInterval(0, 1),
      threshold: 0.95,
      gatePassed: false,
    },
  },
  headline: {
    unnecessarySearchRate: {
      count: 1,
      total: 1,
      rate: 1,
      threshold: 0.05,
      gatePassed: false,
    },
    missedSearchRate: {
      count: 0,
      total: 0,
      rate: 0,
      threshold: 0.05,
      gatePassed: false,
    },
    meanWebCallsNoSearchExpected: 1,
  },
})

const metrics = (): EvalMetrics => ({
  schemaVersion: 2,
  generatedAt: '2026-08-04T12:00:00.000Z',
  groups: { 'opus/pi': group() },
})

const baseline = (): EvalBaseline => {
  const baselineGroup = group()
  baselineGroup.categories.never_search = {
    passed: 10,
    total: 10,
    rate: 1,
    wilson: wilsonScoreInterval(10, 10),
    threshold: 0.95,
    gatePassed: true,
  }
  baselineGroup.headline.unnecessarySearchRate = {
    count: 0,
    total: 10,
    rate: 0,
    threshold: 0.05,
    gatePassed: true,
  }
  baselineGroup.headline.missedSearchRate = {
    count: 1,
    total: 10,
    rate: 0.1,
    threshold: 0.05,
    gatePassed: false,
  }
  baselineGroup.headline.meanWebCallsNoSearchExpected = 0
  baselineGroup.scenarios.C1 = {
    ...baselineGroup.scenarios.C1,
    passed: true,
    passedSampleCount: 1,
    failures: [],
  }
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-03T12:00:00.000Z',
    groupKey: 'opus/pi',
    group: baselineGroup,
  }
}

describe('renderEvalComment', () => {
  test('renders gates, compact metrics, failures, and artifact link without a baseline', () => {
    const comment = renderEvalComment(metrics(), {}, {
      artifactUrl: 'https://github.example/artifacts/123',
      title: 'AI Eval Smoke',
    })

    expect(comment).toStartWith(evalCommentMarker)
    expect(comment).toContain('No baseline yet — first scheduled run will create one.')
    expect(comment).toContain('### opus/pi')
    expect(comment).toContain('Gates: **failed**')
    expect(comment).toContain('Core suite: **0/1 passed** · no baseline')
    expect(comment).toContain('| Unnecessary search | 100.0% | no baseline | no baseline | failed |')
    expect(comment).toContain('| never_search | 0/1 (0.0%) | no baseline | no baseline | failed |')
    expect(comment).toContain('<summary>Failed scenarios (2)</summary>')
    expect(comment).toContain('`C1`: Insufficient citations: 0 found, 1 required')
    expect(comment).toContain('`never-search-01`: Too many web tool calls: 1 (max: 0)')
    expect(comment).toContain('[Full eval report artifact](https://github.example/artifacts/123)')
    expect(comment).not.toMatch(/✅|❌|🟢|🟡|🔴/)
  })

  test('does not claim significance for one-sample smoke rates that overlap the baseline interval', () => {
    const comment = renderEvalComment(metrics(), { 'opus/pi': baseline() }, { artifactUrl: 'artifact-url' })

    expect(comment).toContain('| Unnecessary search | 100.0% | +100.0 pp | not significant | failed |')
    expect(comment).toContain('| Missed search | 0.0% | -10.0 pp | not significant | failed |')
    expect(comment).toContain('| never_search | 0/1 (0.0%) | -100.0 pp | not significant | failed |')
    expect(comment).toContain('| Mean web calls, no-search expected | 1.000 | +1.000 | not applicable | none |')
    expect(comment).toContain('Core suite: **0/1 passed** · 0 improved, 1 regressed')
  })

  test('renders an actionable message when the eval fails before metrics are written', () => {
    const comment = renderEvalComment(null, {}, { artifactUrl: 'artifact-url' })

    expect(comment).toContain('Eval metrics were not produced. Check the workflow logs and report artifact.')
    expect(comment).toContain('[Full eval report artifact](artifact-url)')
  })
})

describe('upsertEvalComment', () => {
  test('updates the existing marked comment', async () => {
    const runGh = mock(async (args: string[]) => {
      if (args.includes('--method')) {
        return '{}'
      }
      return JSON.stringify([
        [{ id: 99, body: `old\n${evalCommentMarker}`, user: { login: 'github-actions[bot]' } }],
      ])
    })

    await upsertEvalComment({
      body: `${evalCommentMarker}\nnew`,
      repository: 'thunderbird/thunderbolt',
      pullRequestNumber: 42,
      runGh,
    })

    expect(runGh).toHaveBeenCalledTimes(2)
    expect(runGh.mock.calls[1][0]).toContain('repos/thunderbird/thunderbolt/issues/comments/99')
    expect(runGh.mock.calls[1][0]).toContain('PATCH')
  })

  test('creates a comment when no marked comment exists', async () => {
    const runGh = mock(async (args: string[]) => (args.includes('--method') ? '{}' : JSON.stringify([[]])))

    await upsertEvalComment({
      body: `${evalCommentMarker}\nnew`,
      repository: 'thunderbird/thunderbolt',
      pullRequestNumber: 42,
      runGh,
    })

    expect(runGh).toHaveBeenCalledTimes(2)
    expect(runGh.mock.calls[1][0]).toContain('repos/thunderbird/thunderbolt/issues/42/comments')
    expect(runGh.mock.calls[1][0]).toContain('POST')
  })

  test('creates a comment when another author planted the marker', async () => {
    const runGh = mock(async (args: string[]) =>
      args.includes('--method')
        ? '{}'
        : JSON.stringify([[{ id: 88, body: evalCommentMarker, user: { login: 'contributor' } }]]),
    )

    await upsertEvalComment({
      body: `${evalCommentMarker}\nnew`,
      repository: 'thunderbird/thunderbolt',
      pullRequestNumber: 42,
      runGh,
    })

    expect(runGh.mock.calls[1][0]).toContain('repos/thunderbird/thunderbolt/issues/42/comments')
    expect(runGh.mock.calls[1][0]).toContain('POST')
  })
})
