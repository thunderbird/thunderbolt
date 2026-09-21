/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evalCommentMarker, renderEvalComment, upsertEvalComment } from './post-eval-results'
import { aggregateEvalMetrics } from '../../src/ai/eval/stats'
import { getScenarios } from '../../src/ai/eval/scenarios'
import { getNecessityScenarios } from '../../src/ai/eval/necessity-scenarios'
import { getLanguageScenarios } from '../../src/ai/eval/language-scenarios'
import { selectSmokeScenarios } from '../../src/ai/eval/smoke'
import { fixtureManifest, fixtureMetrics, fixtureScenario } from '../../src/ai/eval/test-fixtures'
import type { EvalBaseline } from '../../src/ai/eval/baseline'

const renderOptions = {
  artifactUrl: 'https://example.test/artifact',
  runUrl: 'https://example.test/run',
  commitSha: '123456789',
}
const baseline = (passes = 3): EvalBaseline => {
  const metrics = fixtureMetrics(passes)
  return {
    schemaVersion: 4,
    generatedAt: metrics.generatedAt,
    groupKey: 'opus/pi',
    manifest: metrics.manifest,
    group: metrics.groups['opus/pi'],
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
  test('leads with per-cell acceptance and explicit missing-baseline status', () => {
    const comment = renderEvalComment(fixtureMetrics(), {}, renderOptions)
    expect(comment).toContain(evalCommentMarker)
    expect(comment).toContain('| Cell | Acceptance |')
    expect(comment).toContain('Acceptance exit: 0')
    expect(comment).toContain('not comparable: baseline absent')
    expect(comment).toContain('[Artifacts]')
    expect(comment).toContain('informational')
  })
  test('shows paired changes without Wilson significance claims', () => {
    const comment = renderEvalComment(fixtureMetrics(2), { 'opus/pi': baseline() }, renderOptions)
    expect(comment).toContain('-0.333333')
    expect(comment).toContain('Acceptance exit: 1')
    expect(comment).not.toContain('significant')
    expect(comment).not.toContain('Wilson')
  })
  test('quality improvement does not hide a failing current gate', () => {
    const comment = renderEvalComment(
      fixtureMetrics(2),
      { 'opus/pi': baseline(1) },
      { ...renderOptions, informational: false },
    )
    expect(comment).toContain('0.333333')
    expect(comment).toContain('Acceptance exit: 1')
    expect(comment).toContain('enforced')
  })
  test('prints all treatment fields side by side even when identity differs', () => {
    const metrics = fixtureMetrics()
    metrics.manifest.providerKind = 'exa'
    metrics.manifest.treatment.WEB_BUDGET_PROMOTION = '1'
    const comment = renderEvalComment(metrics, { 'opus/pi': baseline() }, renderOptions)
    for (const field of ['generationRevision', 'systemPromptVersion', 'WEB_BUDGET_PROMOTION'])
      expect(comment).toContain(`| ${field} |`)
    expect(comment).toContain('not comparable: providerKind')
    expect(comment).toContain('| WEB_BUDGET_PROMOTION | "0" | "1" |')
  })
  test('reports absent metrics with an actionable message', () => {
    expect(renderEvalComment(null, {}, renderOptions)).toContain('Check the workflow logs')
  })
  test('partial runs cannot present themselves as definition-of-done evidence', () => {
    const metrics = fixtureMetrics()
    metrics.manifest.partial = true
    expect(renderEvalComment(metrics, {}, renderOptions)).toContain('partial; not definition-of-done evidence')
  })
  test('old-schema baselines are explicitly not comparable', () => {
    expect(
      renderEvalComment(fixtureMetrics(), { 'opus/pi': { ...baseline(), schemaVersion: 3 } }, renderOptions),
    ).toContain('not comparable: schemaVersion')
  })
  test('redacts the synthetic auth token from PR comments too', () => {
    const previous = process.env.EVAL_AUTH_TOKEN
    const marker = 'synthetic-EVAL_AUTH_TOKEN-pr-marker'
    process.env.EVAL_AUTH_TOKEN = marker
    try {
      const metrics = fixtureMetrics(2)
      metrics.groups['opus/pi'].scenarios[fixtureScenario().id].failures = [marker]
      expect(renderEvalComment(metrics, {}, renderOptions)).not.toContain(marker)
    } finally {
      if (previous === undefined) delete process.env.EVAL_AUTH_TOKEN
      else process.env.EVAL_AUTH_TOKEN = previous
    }
  })
})

test.each([false, true])('I2: real default matrix comment is bounded (smoke=%s)', (smoke) => {
  const all = [...getScenarios(), ...getNecessityScenarios(), ...getLanguageScenarios()]
  const scenarios = smoke ? selectSmokeScenarios(all) : all
  const manifest = fixtureManifest(scenarios, smoke ? 1 : 3)
  manifest.suites = ['core', 'necessity', 'language']
  manifest.smoke = smoke
  manifest.partial = smoke
  manifest.preflight = { error: 'unbounded-preflight-must-stay-in-artifacts'.repeat(2000) }
  manifest.treatment.systemPromptVersion = 'large-treatment'.repeat(5000)
  const metrics = aggregateEvalMetrics(manifest, [])
  for (const group of Object.values(metrics.groups)) {
    for (const scenario of Object.values(group.scenarios)) scenario.failures = ['long diagnostic '.repeat(2000)]
  }
  const baselines = Object.fromEntries(
    Object.entries(metrics.groups).map(([groupKey, group]) => [
      groupKey,
      {
        schemaVersion: 4,
        generatedAt: metrics.generatedAt,
        groupKey,
        manifest,
        group,
      },
    ]),
  )
  const comment = renderEvalComment(metrics, baselines, renderOptions)
  expect(manifest.cells).toHaveLength(3)
  expect(scenarios.length).toBeGreaterThan(smoke ? 20 : 500)
  expect(comment.length).toBeLessThan(65_536)
  expect(comment.match(/Prompt:/g)).toHaveLength(20)
  expect(comment).toContain('Expected:')
  expect(comment).toContain('Observed:')
  expect(comment).toContain('more diagnostics in the full report')
  expect(comment).toContain('Opus 5')
  expect(comment).toContain('GLM 5.3 Flash')
  expect(comment).toContain('manifest artifacts')
  expect(comment).not.toContain('rubricHash')
  expect(comment).not.toContain('unbounded-preflight-must-stay-in-artifacts')
  expect(comment).not.toContain('| Scenario |')
})

describe('upsertEvalComment', () => {
  test('updates the existing marked comment', async () => {
    const runGh = mock(async (args: string[]) => {
      if (args.includes('--method')) {
        return '{}'
      }
      return JSON.stringify([[{ id: 99, body: `old\n${evalCommentMarker}`, user: { login: 'github-actions[bot]' } }]])
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

test('missing required cells render a non-passing report instead of crashing', () => {
  const metrics = fixtureMetrics()
  metrics.groups = {}
  const comment = renderEvalComment(metrics, {}, renderOptions)
  expect(comment).toContain('Acceptance exit: 1')
  expect(comment).toContain('Required cell absent')
})

test.each([true, false])('expected diagnostics include semantic assertions and research loading=%s', (research) => {
  const metrics = fixtureMetrics(2)
  Object.assign(metrics.manifest.scenarios[0].scenario.criteria, {
    expectEvidenceCoverage: true,
    expectReuseFidelity: true,
    expectSearchOffer: true,
    expectResearchSkill: research,
  })
  const comment = renderEvalComment(metrics, {}, renderOptions)
  expect(comment).toContain('support and cover the answer with source evidence')
  expect(comment).toContain('faithfully reuse the earlier answer')
  expect(comment).toContain('answer with a freshness caveat, then offer to verify')
  expect(comment).toContain(research ? '; load the research skill' : '; do not load the research skill')
})
