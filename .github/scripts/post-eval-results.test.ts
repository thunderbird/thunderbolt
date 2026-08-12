/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wilsonScoreInterval } from '../../src/ai/eval/stats'
import type { EvalBaseline } from '../../src/ai/eval/baseline'
import type { EvalMetrics, EvalMetricsGroup } from '../../src/ai/eval/types'
import {
  diagnoseEvalGroup,
  evalCommentMarker,
  renderEvalComment,
  upsertEvalComment,
} from './post-eval-results'

const renderOptions = {
  artifactUrl: 'https://github.example/artifacts/123',
  runUrl: 'https://github.example/actions/runs/456',
  commitSha: '06c20766f00d',
  informational: true,
}

const group = (): EvalMetricsGroup => ({
  model: 'opus',
  engine: 'pi',
  scenarios: {
    C1: {
      prompt: 'What are the top stories today?',
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
      prompt: 'What year did the Berlin Wall fall?',
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
  schemaVersion: 3,
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

describe('command lifecycle', () => {
  test('exits after completing when a preload keeps the event loop alive', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-eval-comment-'))
    const preloadPath = join(temporaryDirectory, 'keep-alive.ts')
    writeFileSync(preloadPath, 'setInterval(() => {}, 60_000)\n')
    const processHandle = Bun.spawn(
      [process.execPath, '--preload', preloadPath, '.github/scripts/post-eval-results.ts'],
      {
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...process.env,
          EVAL_COMMENT_DRY_RUN: '1',
          EVAL_METRICS_PATH: '/nonexistent',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    )
    const completion = await Promise.race([
      (async () => ({ exitCode: await processHandle.exited }))(),
      (async () => {
        await Bun.sleep(1_000)
        return { exitCode: null }
      })(),
    ])

    if (completion.exitCode === null) {
      processHandle.kill()
      await processHandle.exited
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })

    expect(completion.exitCode).toBe(0)
  })
})

describe('renderEvalComment', () => {
  test('renders the approved human-readable layout without a baseline', () => {
    const comment = renderEvalComment(metrics(), {}, renderOptions)

    expect(comment).toStartWith(evalCommentMarker)
    expect(comment).toContain(
      '## AI Evals — ⚠️ models miss the search policy in known ways; nothing here blocks your PR',
    )
    expect(comment).toContain('**TL;DR:** No baseline exists yet')
    expect(comment).toContain('### Should I care?')
    expect(comment).toContain('| Did my PR make AI behavior worse? | **Unknown yet** — no baseline to compare against |')
    expect(comment).toContain('### What the models did (2 scenarios each)')
    expect(comment).toContain('| Opus 5 (`pi`) | ❌ 0/1 | ❌ 0/1 |')
    expect(comment).toContain('<details open>')
    expect(comment).toContain('<summary>❌ Exactly what failed, in plain words (2 scenarios)</summary>')
    expect(comment).toContain('Asked *"What are the top stories today?"*')
    expect(comment).toContain('Asked *"What year did the Berlin Wall fall?"*')
    expect(comment).toContain('Expected: answer from stable knowledge without searching.')
    expect(comment).toContain('<summary>📊 Full numbers (gates, categories, headline rates)</summary>')
    expect(comment).toContain('| Unnecessary search | 100.0% | no baseline | failed |')
    expect(comment).toContain('| never_search | 0/1 (0.0%) | no baseline | failed |')
    expect(comment).toContain('<summary>❓ How to read this report</summary>')
    expect(comment).toContain('[Full report](https://github.example/actions/runs/456)')
    expect(comment).toContain('[Artifacts](https://github.example/artifacts/123)')
    expect(comment).toContain('commit `06c2076` · smoke suite (1 scenario per category, k=1)')
  })

  test('reports baseline deltas without claiming significance for overlapping intervals', () => {
    const comment = renderEvalComment(metrics(), { 'opus/pi': baseline() }, renderOptions)

    expect(comment).toContain('## AI Evals — ✅ no significant AI behavior regressions detected')
    expect(comment).toContain('| Opus 5 (`pi`) | ❌ 0/1 | ❌ 0/1 | 0 🟢 1 🔴 |')
    expect(comment).toContain('| Unnecessary search | 100.0% | (+100.0pp) | failed |')
    expect(comment).toContain('| Missed search | 0.0% | (-10.0pp) | failed |')
    expect(comment).toContain('| never_search | 0/1 (0.0%) | (-100.0pp) | failed |')
    expect(comment).not.toContain('not significant')
  })

  test('leads with significant regressions and shows scenario-level change counts', () => {
    const currentGroup = group()
    currentGroup.scenarios = {
      C1: { ...currentGroup.scenarios.C1, passed: true, passedSampleCount: 1, failures: [] },
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `never-search-${String(index + 1).padStart(2, '0')}`,
          {
            ...currentGroup.scenarios['never-search-01'],
            prompt: `Stable question ${index + 1}`,
            passed: false,
            passedSampleCount: 0,
            failures: ['Too many web tool calls: 1 (max: 0)'],
          },
        ]),
      ),
    }
    currentGroup.categories.never_search = {
      passed: 0,
      total: 12,
      rate: 0,
      wilson: wilsonScoreInterval(0, 12),
      threshold: 0.95,
      gatePassed: false,
    }
    currentGroup.headline.unnecessarySearchRate = {
      count: 12,
      total: 12,
      rate: 1,
      threshold: 0.05,
      gatePassed: false,
    }
    const baselineGroup = structuredClone(currentGroup)
    baselineGroup.scenarios = Object.fromEntries(
      Object.entries(currentGroup.scenarios).map(([scenarioId, scenario]) => [
        scenarioId,
        { ...scenario, passed: true, passedSampleCount: 1, failures: [], webToolCalls: 0 },
      ]),
    )
    baselineGroup.categories.never_search = {
      passed: 12,
      total: 12,
      rate: 1,
      wilson: wilsonScoreInterval(12, 12),
      threshold: 0.95,
      gatePassed: true,
    }
    baselineGroup.headline.unnecessarySearchRate = {
      count: 0,
      total: 12,
      rate: 0,
      threshold: 0.05,
      gatePassed: true,
    }
    const current: EvalMetrics = {
      schemaVersion: 3,
      generatedAt: '2026-08-04T12:00:00.000Z',
      groups: { 'opus/pi': currentGroup },
    }
    const comparisonBaseline: EvalBaseline = {
      schemaVersion: 2,
      generatedAt: '2026-08-03T12:00:00.000Z',
      groupKey: 'opus/pi',
      group: baselineGroup,
    }

    const comment = renderEvalComment(current, { 'opus/pi': comparisonBaseline }, renderOptions)

    expect(comment).toContain('## AI Evals — ❌ 2 significant search-policy regressions need attention')
    expect(comment).toContain('| Opus 5 (`pi`) | ✅ 1/1 | ❌ 0/1 | 0 🟢 12 🔴 |')
    expect(comment).toContain('(+100.0pp) — **significant regression**')
  })

  test('renders an actionable message when the eval fails before metrics are written', () => {
    const comment = renderEvalComment(null, {}, renderOptions)

    expect(comment).toContain('## AI Evals — ❌ eval metrics were not produced')
    expect(comment).toContain('Eval metrics were not produced. Check the workflow logs and report artifact.')
    expect(comment).toContain('[Full report](https://github.example/actions/runs/456)')
  })

  test('caps the plain-words failure list at twenty scenarios', () => {
    const cappedGroup = group()
    cappedGroup.scenarios = Object.fromEntries(
      Array.from({ length: 22 }, (_, index) => [
        `single-search-${String(index + 1).padStart(2, '0')}`,
        {
          ...cappedGroup.scenarios['never-search-01'],
          prompt: `Current fact ${index + 1}?`,
          category: 'single_search' as const,
          webToolCalls: 0,
          failures: ['Too few web tool calls: 0 (min: 1)'],
        },
      ]),
    )
    cappedGroup.categories = {
      single_search: {
        passed: 0,
        total: 22,
        rate: 0,
        wilson: wilsonScoreInterval(0, 22),
        threshold: 0.9,
        gatePassed: false,
      },
    }
    const cappedMetrics: EvalMetrics = {
      schemaVersion: 3,
      generatedAt: '2026-08-04T12:00:00.000Z',
      groups: { 'opus/pi': cappedGroup },
    }

    const comment = renderEvalComment(cappedMetrics, {}, renderOptions)

    expect(comment.match(/^- Asked /gm)).toHaveLength(20)
    expect(comment).toContain('…and 2 more — see full numbers.')
  })
})

describe('diagnoseEvalGroup', () => {
  const withFailures = (failures: string[]): EvalMetricsGroup => {
    const value = group()
    value.scenarios = Object.fromEntries(
      failures.map((failure, index) => [
        `failure-${index}`,
        {
          ...value.scenarios['never-search-01'],
          prompt: `Prompt ${index}`,
          failures: [failure],
        },
      ]),
    )
    return value
  }

  test('summarizes too-few, too-many, judge, mixed, and passing failure mixes', () => {
    expect(
      diagnoseEvalGroup(
        withFailures(['Too few web tool calls: 0 (min: 1)', 'Too few web tool calls: 0 (min: 1)']),
      ),
    ).toBe('Answers from memory when it should search')
    expect(
      diagnoseEvalGroup(
        withFailures(['Too many web tool calls: 3 (max: 2)', 'Too many web tool calls: 4 (max: 2)']),
      ),
    ).toBe('Searches more than the budget allows')
    expect(diagnoseEvalGroup(withFailures(['Judge rejected premise rebuttal: The premise was repeated']))).toBe(
      'Does not reliably rebut false premises',
    )
    expect(
      diagnoseEvalGroup(withFailures(['Too few web tool calls: 0 (min: 1)', 'Empty response — no text output produced'])),
    ).toBe('Mixed failures; see the details below')

    const passing = group()
    passing.scenarios = {
      C1: { ...passing.scenarios.C1, passed: true, failures: [] },
    }
    expect(diagnoseEvalGroup(passing)).toBe('No failed scenarios in this run')
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
