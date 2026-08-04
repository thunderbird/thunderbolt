/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import {
  compareMetricsToBaselines,
  loadBaselineFiles,
  type EvalBaseline,
  type RateComparison,
} from '../../src/ai/eval/baseline'
import type { EvalMetrics } from '../../src/ai/eval/types'

export const evalCommentMarker = '<!-- thunderbolt-eval-results -->'

type RenderOptions = {
  artifactUrl: string
  title?: string
}

type GithubComment = {
  id: number
  body: string | null
}

type RunGh = (args: string[]) => Promise<string>

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const formatRateDelta = (delta: number | null): string => {
  if (delta === null) {
    return 'no baseline'
  }
  const percentagePoints = delta * 100
  return `${percentagePoints > 0 ? '+' : ''}${percentagePoints.toFixed(1)} pp`
}

const formatMeanDelta = (delta: number | null): string => {
  if (delta === null) {
    return 'no baseline'
  }
  return `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`
}

const significanceLabel = (comparison: RateComparison): string => {
  if (comparison.direction === 'no-baseline') {
    return 'no baseline'
  }
  if (!comparison.significant) {
    return 'not significant'
  }
  return comparison.direction === 'improved' ? 'significant improvement' : 'significant regression'
}

const gateLabel = (passed: boolean): string => (passed ? 'passed' : 'failed')

const artifactFooter = (artifactUrl: string, generatedAt?: string): string => {
  const report = artifactUrl ? `[Full eval report artifact](${artifactUrl})` : 'Full eval report artifact unavailable'
  return generatedAt ? `${report} · Generated ${generatedAt}` : report
}

/** Render the sticky pull-request comment from current metrics and optional checked-in baselines. */
export const renderEvalComment = (
  metrics: EvalMetrics | null,
  baselines: Record<string, EvalBaseline>,
  options: RenderOptions,
): string => {
  const lines = [evalCommentMarker, `## ${options.title ?? 'AI Eval Results'}`, '']
  if (!metrics) {
    lines.push(
      'Eval metrics were not produced. Check the workflow logs and report artifact.',
      '',
      artifactFooter(options.artifactUrl),
    )
    return lines.join('\n')
  }

  const comparison = compareMetricsToBaselines(metrics, baselines)
  if (Object.keys(metrics.groups).some((groupKey) => !baselines[groupKey])) {
    lines.push('No baseline yet — first scheduled run will create one.', '')
  }

  for (const [groupKey, group] of Object.entries(metrics.groups)) {
    const groupComparison = comparison.groups[groupKey]
    const coreScenarios = Object.entries(group.scenarios).filter(([, scenario]) => scenario.category === 'core')
    lines.push(
      `### ${groupKey}`,
      '',
      `Gates: **${gateLabel(groupComparison.gatesPassed)}**`,
      '',
    )
    if (coreScenarios.length > 0) {
      const corePassed = coreScenarios.filter(([, scenario]) => scenario.passed).length
      const coreComparisons = coreScenarios.map(([scenarioId]) => groupComparison.scenarios[scenarioId])
      const improved = coreComparisons.filter(({ direction }) => direction === 'improved').length
      const regressed = coreComparisons.filter(({ direction }) => direction === 'regressed').length
      const withoutBaseline = coreComparisons.filter(({ direction }) => direction === 'no-baseline').length
      const baselineSummary =
        withoutBaseline === coreComparisons.length
          ? 'no baseline'
          : `${improved} improved, ${regressed} regressed${withoutBaseline > 0 ? `, ${withoutBaseline} without baseline` : ''}`
      lines.push(`Core suite: **${corePassed}/${coreScenarios.length} passed** · ${baselineSummary}`, '')
    }
    lines.push(
      '| Headline metric | Current | Delta vs baseline | Significance | Gate |',
      '|---|---:|---:|---|---|',
      `| Unnecessary search | ${formatPercent(group.headline.unnecessarySearchRate.rate)} | ${formatRateDelta(groupComparison.headline.unnecessarySearchRate.delta)} | ${significanceLabel(groupComparison.headline.unnecessarySearchRate)} | ${gateLabel(group.headline.unnecessarySearchRate.gatePassed)} |`,
      `| Missed search | ${formatPercent(group.headline.missedSearchRate.rate)} | ${formatRateDelta(groupComparison.headline.missedSearchRate.delta)} | ${significanceLabel(groupComparison.headline.missedSearchRate)} | ${gateLabel(group.headline.missedSearchRate.gatePassed)} |`,
      `| Mean web calls, no-search expected | ${group.headline.meanWebCallsNoSearchExpected.toFixed(3)} | ${formatMeanDelta(groupComparison.headline.meanWebCallsNoSearchExpected.delta)} | not applicable | none |`,
      '',
      '| Category | Current | Delta vs baseline | Significance | Gate |',
      '|---|---:|---:|---|---|',
      ...Object.entries(group.categories).map(([category, categoryMetrics]) => {
        const categoryComparison = groupComparison.categories[category as keyof typeof groupComparison.categories]
        if (!categoryComparison) {
          throw new Error(`Missing category comparison for ${groupKey}/${category}`)
        }
        return `| ${category} | ${categoryMetrics.passed}/${categoryMetrics.total} (${formatPercent(categoryMetrics.rate)}) | ${formatRateDelta(categoryComparison.delta)} | ${significanceLabel(categoryComparison)} | ${gateLabel(categoryMetrics.gatePassed)} |`
      }),
      '',
    )

    const failures = Object.entries(group.scenarios).filter(([, scenario]) => !scenario.passed)
    if (failures.length > 0) {
      lines.push(
        '<details>',
        `<summary>Failed scenarios (${failures.length})</summary>`,
        '',
        ...failures.map(([scenarioId, scenario]) => `- \`${scenarioId}\`: ${scenario.failures.join('; ')}`),
        '',
        '</details>',
        '',
      )
    }
  }

  lines.push(artifactFooter(options.artifactUrl, metrics.generatedAt))
  return lines.join('\n')
}

const defaultRunGh: RunGh = async (args) => {
  const processHandle = Bun.spawn(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${stderr.trim()}`)
  }
  return stdout
}

/** Create or update the marked eval comment without duplicating it across pull-request runs. */
export const upsertEvalComment = async ({
  body,
  repository,
  pullRequestNumber,
  runGh = defaultRunGh,
}: {
  body: string
  repository: string
  pullRequestNumber: number
  runGh?: RunGh
}): Promise<void> => {
  const output = await runGh([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repository}/issues/${pullRequestNumber}/comments`,
  ])
  const pages = JSON.parse(output) as GithubComment[][]
  const existing = pages.flat().find(({ body: commentBody }) => commentBody?.includes(evalCommentMarker))
  const endpoint = existing
    ? `repos/${repository}/issues/comments/${existing.id}`
    : `repos/${repository}/issues/${pullRequestNumber}/comments`

  await runGh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '-f', `body=${body}`])
}

const main = async () => {
  const metricsPath = process.env.EVAL_METRICS_PATH ?? 'evals/eval-metrics.json'
  const baselineDirectory = process.env.EVAL_BASELINE_DIR ?? 'src/ai/eval/baselines'
  const artifactUrl = process.env.EVAL_ARTIFACT_URL ?? ''
  const metrics = existsSync(metricsPath)
    ? (JSON.parse(readFileSync(metricsPath, 'utf8')) as EvalMetrics)
    : null
  const body = renderEvalComment(metrics, loadBaselineFiles(baselineDirectory), {
    artifactUrl,
    title: process.env.EVAL_COMMENT_TITLE,
  })

  if (process.env.EVAL_COMMENT_DRY_RUN === '1') {
    console.log(body)
    return
  }

  const repository = process.env.GITHUB_REPOSITORY
  const pullRequestNumber = Number(process.env.PR_NUMBER)
  if (!repository || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('GITHUB_REPOSITORY and a positive PR_NUMBER are required')
  }
  await upsertEvalComment({ body, repository, pullRequestNumber })
}

if (import.meta.main) {
  await main()
}
