/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import { compareMetricsToBaselines, loadBaselineFiles, type EvalBaseline } from '../../src/ai/eval/baseline'
import { serializeArtifact } from '../../src/ai/eval/stats'
import type { EvalCriteria, EvalMetrics } from '../../src/ai/eval/types'

export const evalCommentMarker = '<!-- thunderbolt-eval-results -->'
type RenderOptions = { artifactUrl: string; runUrl?: string; commitSha?: string; informational?: boolean }
type GithubComment = { id: number; body: string | null; user: { login: string } | null }
type RunGh = (args: string[]) => Promise<string>
const workflowCommentAuthor = 'github-actions[bot]'

const modelNames: Record<string, string> = { opus: 'Opus 5', flash: 'GLM 5.3 Flash', glm: 'GLM 5.3' }
const failureLimit = 20
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)

/** Redact before shortening; keep arbitrary diagnostics inside one bounded Markdown cell. */
const compact = (value: unknown, limit = 240): string => {
  const text = (JSON.parse(serializeArtifact(String(value))) as string)
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('|', '\uFF5C')
    .replace(/[<>]/g, '')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Describe declared expectations in reader-facing terms without deriving search policy from categories. */
const expectedBehaviour = (criteria: EvalCriteria): string =>
  compact(
    [
      ...(criteria.mustProduceOutput ? ['produce an answer'] : []),
      ...(criteria.minToolCalls ? [`make at least ${criteria.minToolCalls} web calls`] : []),
      ...(criteria.maxToolCalls === 0
        ? ['answer without web calls']
        : criteria.maxToolCalls !== undefined
          ? [`make at most ${criteria.maxToolCalls} web calls`]
          : []),
      ...(criteria.minCitations ? [`cite at least ${criteria.minCitations} sources`] : []),
      ...(criteria.expectCorrectAnswer ? ['give a correct answer'] : []),
      ...(criteria.expectSearchOffer ? ['answer, then offer to verify'] : []),
      ...(criteria.expectPremiseRebuttal ? ['rebut the false premise'] : []),
      ...(criteria.expectVerificationDisclaimer ? ['admit when verification is impossible'] : []),
      ...(criteria.expectReplyLanguage ? [`reply in ${criteria.expectReplyLanguage}`] : []),
      ...(criteria.mustUseLinkPreviews ? ['include link previews'] : []),
      ...(criteria.mustUseWidget ? [`use the ${criteria.mustUseWidget} widget`] : []),
      ...(criteria.mustNotUseWidgets ? ['use no widgets'] : []),
      ...(criteria.noHomepageLinks ? ['link to specific pages'] : []),
      ...(criteria.noReviewSites ? ['avoid review sites'] : []),
      ...(criteria.noDuplicateToolCalls ? ['avoid duplicate web calls'] : []),
      ...(criteria.maxSteps ? [`finish within ${criteria.maxSteps} steps`] : []),
    ].join('; '),
    360,
  )

/** Render bounded summaries and at most twenty diagnostics; full evidence stays in linked artifacts. */
export const renderEvalComment = (
  metrics: EvalMetrics | null,
  baselines: Record<string, EvalBaseline>,
  options: RenderOptions,
): string => {
  const links = `[Artifacts](${options.artifactUrl}) · [Full report and manifest artifacts](${options.artifactUrl})${options.runUrl ? ` · [Workflow run](${options.runUrl})` : ''}${options.commitSha ? ` · commit ${compact(options.commitSha, 7)}` : ''}`
  if (!metrics || metrics.schemaVersion !== 4) {
    return `${evalCommentMarker}\n## AI Evals — eval metrics were not produced in schema 4\n\nCheck the workflow logs and report artifact.\n\n${links}`
  }
  const comparison = compareMetricsToBaselines(metrics, baselines)
  const { acceptance } = comparison
  const lines = [
    evalCommentMarker,
    `## AI Evals — ${acceptance.exitCode === 0 ? '✅ pass' : '❌ non-passing'}`,
    '',
    `Acceptance exit: ${acceptance.exitCode}. ${acceptance.partial ? 'partial; not definition-of-done evidence. ' : ''}${(options.informational ?? true) ? 'This check is informational and does not block merging.' : 'This check is enforced and can block merging.'}`,
    '',
    '| Cell | Acceptance | Post-retry errors | Core | Scored turn not reached |',
    '|---|---|---|---|---|',
    ...metrics.manifest.cells.map(({ key, model, engine }) => {
      const group = metrics.groups[key]
      if (!group) return `| ${compact(key)} | Required cell absent | — | — | — |`
      return `| ${compact(modelNames[model] ?? model)} (${compact(engine)}) | ${acceptance.cells[key].exitCode === 0 ? 'pass' : `exit ${acceptance.cells[key].exitCode}`} | ${group.reliability.errors}/${group.reliability.planned} (${percent(group.reliability.rate)}; ≤10%) | ${group.corePassed ? 'pass' : 'fail'} | ${group.scoredTurnNotReached} |`
    }),
    '',
    '<details>',
    '<summary>Category and headline gates</summary>',
    '',
  ]
  for (const { key } of metrics.manifest.cells) {
    const group = metrics.groups[key]
    if (!group) continue
    lines.push(
      `### ${compact(key)}`,
      '',
      '| Gate | State | Result | Threshold |',
      '|---|---|---|---|',
      ...Object.entries(group.categories)
        .filter(([, category]) => category.state !== 'not_applicable')
        .map(
          ([name, category]) =>
            `| ${compact(name)} | ${category.state} | ${percent(category.rate)} (${category.valid}/${category.planned} valid) | ≥${percent(category.threshold)} |`,
        ),
      ...(
        [
          ['Unnecessary search', group.headline.unnecessarySearchRate],
          ['Missed search', group.headline.missedSearchRate],
        ] as const
      ).map(
        ([name, metric]) =>
          `| ${name} | ${metric.state} | ${percent(metric.rate)} (${metric.count}/${metric.total}) | ≤${percent(metric.threshold)} |`,
      ),
      '',
      `First-attempt errors: ${percent(group.reliability.firstAttemptErrorRate)} (generation ${group.reliability.firstAttemptGenerationErrors}, judge ${group.reliability.firstAttemptJudgeErrors}); tool infra / misuse: ${percent(group.reliability.toolInfraErrorRate)} / ${percent(group.reliability.toolMisuseRate)}.`,
      '',
    )
  }
  lines.push('</details>', '', '### Failure details', '')
  const failed = Object.entries(metrics.groups).flatMap(([key, group]) =>
    Object.entries(group.scenarios)
      .filter(([, scenario]) => scenario.f > 0 || scenario.e > 0)
      .map(([id, scenario]) => ({ key, id, scenario })),
  )
  for (const { key, id, scenario } of failed.slice(0, failureLimit)) {
    const criteria = metrics.manifest.scenarios.find(({ scenario }) => scenario.id === id)?.scenario.criteria
    lines.push(
      `- **${compact(key)} / ${compact(id.split('/').at(-1), 80)}** — Prompt: ${compact(scenario.prompt, 360)}. Expected: ${criteria ? expectedBehaviour(criteria) : 'declared scenario checks (see full report)'}. Observed: ${scenario.behaviour} (${scenario.completeness}), ${scenario.c}/${scenario.n} passes; ${compact(scenario.failures.join('; ') || 'No valid trial', 480)}.`,
    )
  }
  if (failed.length > failureLimit) lines.push(`\n${failed.length - failureLimit} more diagnostics in the full report.`)
  if (!failed.length) lines.push('No failed scenarios in this run.')
  lines.push('', '<details>', '<summary>Baseline and treatment comparison</summary>', '')
  for (const [key, group] of Object.entries(comparison.groups)) {
    const deltas = Object.values(group.scenarios).flatMap(({ delta }) => (delta === null ? [] : [delta]))
    const delta = deltas.length
      ? (deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(6)
      : 'not comparable'
    lines.push(
      `### ${compact(key)} — ${compact(group.reason)}`,
      '',
      `Paired mean Δ: ${delta} over ${deltas.length} scenarios; ${deltas.filter((value) => value > 0).length} improved, ${deltas.filter((value) => value < 0).length} regressed.`,
      '',
      '| Treatment | Baseline | Current |',
      '|---|---|---|',
      ...(['generationRevision', 'systemPromptVersion', 'WEB_BUDGET_PROMOTION'] as const).map(
        (field) =>
          `| ${field} | ${compact(JSON.stringify(group.treatment.baseline?.[field] ?? null), 160)} | ${compact(JSON.stringify(group.treatment.current[field]), 160)} |`,
      ),
      '',
    )
  }
  lines.push('</details>', '', links)
  return JSON.parse(serializeArtifact(lines.join('\n'))) as string
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
  const existing = pages
    .flat()
    .find(
      ({ body: commentBody, user }) =>
        user?.login === workflowCommentAuthor && commentBody?.includes(evalCommentMarker),
    )
  const endpoint = existing
    ? `repos/${repository}/issues/comments/${existing.id}`
    : `repos/${repository}/issues/${pullRequestNumber}/comments`

  await runGh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '-f', `body=${body}`])
}

const main = async () => {
  const metricsPath = process.env.EVAL_METRICS_PATH ?? 'evals/eval-metrics.json'
  const baselineDirectory = process.env.EVAL_BASELINE_DIR ?? 'src/ai/eval/baselines'
  const artifactUrl = process.env.EVAL_ARTIFACT_URL ?? ''
  const metrics = existsSync(metricsPath) ? (JSON.parse(readFileSync(metricsPath, 'utf8')) as EvalMetrics) : null
  const repository = process.env.GITHUB_REPOSITORY
  const runId = process.env.GITHUB_RUN_ID
  const body = renderEvalComment(metrics, loadBaselineFiles(baselineDirectory), {
    artifactUrl,
    runUrl: repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : undefined,
    commitSha: process.env.GITHUB_SHA,
    informational: process.env.EVAL_COMMENT_INFORMATIONAL !== '0',
  })

  if (process.env.EVAL_COMMENT_DRY_RUN === '1') {
    console.log(body)
    return
  }

  const pullRequestNumber = Number(process.env.PR_NUMBER)
  if (!repository || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('GITHUB_REPOSITORY and a positive PR_NUMBER are required')
  }
  await upsertEvalComment({ body, repository, pullRequestNumber })
}

if (import.meta.main) {
  try {
    await main()
    // Exit explicitly so imported keep-alives cannot outlive completed CI work.
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
