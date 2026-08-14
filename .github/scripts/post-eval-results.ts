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
import type {
  EvalMetrics,
  EvalMetricsGroup,
  EvalScenarioMetrics,
  NecessityCategory,
} from '../../src/ai/eval/types'

export const evalCommentMarker = '<!-- thunderbolt-eval-results -->'

type RenderOptions = {
  artifactUrl: string
  runUrl?: string
  commitSha?: string
  informational?: boolean
}

type GithubComment = {
  id: number
  body: string | null
  user: {
    login: string
  } | null
}

type RunGh = (args: string[]) => Promise<string>

const workflowCommentAuthor = 'github-actions[bot]'
const failureDisplayLimit = 20
const modelDisplayNames: Readonly<Record<string, string>> = {
  opus: 'Opus 5',
  flash: 'DeepSeek Flash',
  glm: 'GLM 5.2',
}
const expectationByCategory: Readonly<Record<NecessityCategory, string>> = {
  never_search: 'answer from stable knowledge without searching',
  answer_then_offer: 'answer from memory, then offer to verify',
  single_search: 'make 1 search, at most 2',
  research: 'search for current evidence',
  unknown_entity: "search at least once for a term the model can't know",
  false_premise: 'verify before rebutting',
  adversarial_no_search: 'ignore search bait and answer from stable knowledge without searching',
  multi_turn_reuse: 'reuse the earlier result without searching again',
  search_wont_help: "admit the answer can't be verified instead of guessing",
}
const judgeDiagnoses: Readonly<Record<string, string>> = {
  'answer correctness': 'Gets stable-answer checks wrong',
  'search offer': 'Does not offer to verify when expected',
  'premise rebuttal': 'Does not reliably rebut false premises',
  'verification disclaimer': 'Claims certainty when verification is impossible',
}

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

const formatRateDelta = (comparison: RateComparison): string => {
  if (comparison.delta === null) {
    return 'no baseline'
  }
  const percentagePoints = comparison.delta * 100
  const delta = `(${percentagePoints > 0 ? '+' : ''}${percentagePoints.toFixed(1)}pp)`
  if (!comparison.significant) {
    return delta
  }
  return `${delta} — **significant ${comparison.direction === 'improved' ? 'improvement' : 'regression'}**`
}

const formatMeanDelta = (delta: number | null): string => {
  if (delta === null) {
    return 'no baseline'
  }
  return `(${delta > 0 ? '+' : ''}${delta.toFixed(3)})`
}

const gateLabel = (passed: boolean): string => (passed ? 'passed' : 'failed')

const passCount = (passed: number, total: number): string => {
  if (total === 0) {
    return '— 0/0'
  }
  const icon = passed === total ? '✅' : passed / total > 0.5 ? '⚠️' : '❌'
  return `${icon} ${passed}/${total}`
}

const modelDisplayName = (model: string): string => modelDisplayNames[model] ?? model

const failureMix = (group: EvalMetricsGroup): string[] =>
  Object.values(group.scenarios)
    .filter(({ category, passed }) => category !== 'core' && !passed)
    .map(({ failures }) => {
      const toolFailure = failures.find(
        (failure) =>
          failure.startsWith('Too few web tool calls:') || failure.startsWith('Too many web tool calls:'),
      )
      const judgeFailure = failures.find((failure) => failure.startsWith('Judge rejected '))
      return toolFailure ?? judgeFailure ?? failures[0]
    })
    .filter((failure): failure is string => Boolean(failure))

const dominantJudgeDiagnosis = (
  failures: string[],
  tooFewCount: number,
  tooManyCount: number,
): string | null => {
  const judgeLabels = failures.flatMap((failure) => {
    const match = failure.match(/^Judge rejected ([^:]+):/)
    return match ? [match[1]] : []
  })
  if (judgeLabels.length === 0) {
    return null
  }
  const labelCounts = new Map<string, number>()
  for (const label of judgeLabels) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
  }
  const [dominantLabel, dominantCount] = [...labelCounts.entries()].sort((left, right) => right[1] - left[1])[0]
  const otherCount = failures.length - tooFewCount - tooManyCount - judgeLabels.length
  if (dominantCount < Math.max(tooFewCount, tooManyCount, otherCount)) {
    return null
  }
  return judgeDiagnoses[dominantLabel] ?? `Judge rejects ${dominantLabel}`
}

/** Summarize the dominant failure mode for one model/engine cell. */
export const diagnoseEvalGroup = (group: EvalMetricsGroup): string => {
  const failures = failureMix(group)
  if (failures.length === 0) {
    return Object.values(group.scenarios).some(({ passed }) => !passed)
      ? 'Classic suite failures; see the details below'
      : 'No failed scenarios in this run'
  }
  const tooFewCount = failures.filter((failure) => failure.startsWith('Too few web tool calls:')).length
  const tooManyCount = failures.filter((failure) => failure.startsWith('Too many web tool calls:')).length
  if (tooFewCount > failures.length / 2) {
    return 'Answers from memory when it should search'
  }
  if (tooManyCount > failures.length / 2) {
    return 'Searches more than the budget allows'
  }
  return dominantJudgeDiagnosis(failures, tooFewCount, tooManyCount) ?? 'Mixed failures; see the details below'
}

const significantRegressionCount = (
  comparison: ReturnType<typeof compareMetricsToBaselines>,
): number =>
  Object.values(comparison.groups).reduce((total, group) => {
    const rateComparisons = [
      group.headline.unnecessarySearchRate,
      group.headline.missedSearchRate,
      ...Object.values(group.categories),
    ]
    return (
      total +
      rateComparisons.filter(({ direction, significant }) => direction === 'regressed' && significant).length
    )
  }, 0)

const baselineChangeCounts = (
  groupComparison: ReturnType<typeof compareMetricsToBaselines>['groups'][string],
): string => {
  if (!groupComparison.baselineAvailable) {
    return 'no baseline'
  }
  const scenarios = Object.values(groupComparison.scenarios)
  const improved = scenarios.filter(({ direction }) => direction === 'improved').length
  const regressed = scenarios.filter(({ direction }) => direction === 'regressed').length
  return `${improved} 🟢 ${regressed} 🔴`
}

const informationalSentence = (informational: boolean): string =>
  informational
    ? 'This check is informational and does not block merging.'
    : 'This check is enforced and can block merging.'

const verdictCopy = (
  comparison: ReturnType<typeof compareMetricsToBaselines>,
  informational: boolean,
): { title: string; tldr: string } => {
  const groups = Object.values(comparison.groups)
  const baselineCount = groups.filter(({ baselineAvailable }) => baselineAvailable).length
  const regressions = significantRegressionCount(comparison)
  const status = informationalSentence(informational)
  if (baselineCount === 0) {
    return {
      title: '⚠️ models miss the search policy in known ways; nothing here blocks your PR',
      tldr: `No baseline exists yet, so this run can't tell whether *your PR* changed AI behavior (the first nightly run after merge creates the baseline). The results below show how the models currently follow the search policy. ${status}`,
    }
  }
  if (regressions > 0) {
    return {
      title: `❌ ${regressions} significant search-policy ${regressions === 1 ? 'regression needs' : 'regressions need'} attention`,
      tldr: `Compared with checked-in nightly baselines, this run found ${regressions} statistically significant search-policy ${regressions === 1 ? 'regression' : 'regressions'}. Review the marked rows before merging. ${status}`,
    }
  }
  if (baselineCount < groups.length) {
    const missing = groups.length - baselineCount
    return {
      title: `⚠️ no significant regressions detected; ${missing} ${missing === 1 ? 'model lacks' : 'models lack'} a baseline`,
      tldr: `No statistically significant regression appeared where a checked-in baseline exists, but ${missing} ${missing === 1 ? 'model cannot' : 'models cannot'} be compared yet. ${status}`,
    }
  }
  return {
    title: '✅ no significant AI behavior regressions detected',
    tldr: `Compared with checked-in nightly baselines, this run found no statistically significant AI behavior regressions. Scenario-level changes are shown below, but overlapping Wilson intervals mean they are not strong evidence that your PR changed model behavior. ${status}`,
  }
}

const careTable = (
  comparison: ReturnType<typeof compareMetricsToBaselines>,
  informational: boolean,
): string[] => {
  const groups = Object.values(comparison.groups)
  const baselineCount = groups.filter(({ baselineAvailable }) => baselineAvailable).length
  const regressions = significantRegressionCount(comparison)
  const worseAnswer =
    baselineCount === 0
      ? '**Unknown yet** — no baseline to compare against'
      : regressions > 0
        ? `**Yes** — ${regressions} statistically significant ${regressions === 1 ? 'regression' : 'regressions'} vs baseline`
        : baselineCount < groups.length
          ? '**Unknown for some models** — their baselines do not exist yet'
          : '**No significant regression detected** — changes remain within statistical noise'
  const blockingAnswer = informational
    ? '**No** — this check is informational'
    : regressions > 0
      ? '**Yes** — significant regressions fail the check'
      : '**No** — no significant regression was detected'
  const actionAnswer =
    regressions > 0
      ? 'Review the significant regressions before merging'
      : baselineCount === 0
        ? 'Only if your PR intended to change search/tool behavior'
        : 'No action needed unless your PR intended to change search/tool behavior'
  return [
    '### Should I care?',
    '',
    '| Question | Answer |',
    '|---|---|',
    `| Did my PR make AI behavior worse? | ${worseAnswer} |`,
    `| Is this check blocking my merge? | ${blockingAnswer} |`,
    `| Do I need to act? | ${actionAnswer} |`,
    '',
  ]
}

const scenarioCountHeading = (metrics: EvalMetrics): string => {
  const totals = Object.values(metrics.groups).map((group) => Object.keys(group.scenarios).length)
  const uniqueTotals = [...new Set(totals)]
  return uniqueTotals.length === 1
    ? `### What the models did (${uniqueTotals[0]} scenarios each)`
    : `### What the models did (${totals.reduce((sum, total) => sum + total, 0)} scenarios total)`
}

const modelTable = (
  metrics: EvalMetrics,
  comparison: ReturnType<typeof compareMetricsToBaselines>,
): string[] => {
  const showBaseline = Object.values(comparison.groups).some(({ baselineAvailable }) => baselineAvailable)
  const header = showBaseline
    ? ['| Model | Classic suite | Search policy | vs baseline | One-line diagnosis |', '|---|---:|---:|---:|---|']
    : ['| Model | Classic suite | Search policy | One-line diagnosis |', '|---|---:|---:|---|']
  const rows = Object.entries(metrics.groups).map(([groupKey, group]) => {
    const coreScenarios = Object.values(group.scenarios).filter(({ category }) => category === 'core')
    const classicPassed = coreScenarios.filter(({ passed }) => passed).length
    const categories = Object.values(group.categories)
    const categoriesPassed = categories.filter(({ gatePassed }) => gatePassed).length
    const cells = [
      `${modelDisplayName(group.model)} (\`${group.engine}\`)`,
      passCount(classicPassed, coreScenarios.length),
      passCount(categoriesPassed, categories.length),
    ]
    if (showBaseline) {
      cells.push(baselineChangeCounts(comparison.groups[groupKey]))
    }
    cells.push(diagnoseEvalGroup(group))
    return `| ${cells.join(' | ')} |`
  })
  return [scenarioCountHeading(metrics), '', ...header, ...rows, '']
}

const escapePrompt = (prompt: string): string =>
  prompt
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('\n', ' ')
    .trim()

const parseCount = (failure: string): number | null => {
  const match = failure.match(/web tool calls: (\d+)/)
  return match ? Number.parseInt(match[1], 10) : null
}

const observedFailure = (scenario: EvalScenarioMetrics): string => {
  const tooFew = scenario.failures.find((failure) => failure.startsWith('Too few web tool calls:'))
  if (tooFew) {
    const count = parseCount(tooFew)
    return count === 0 ? 'answered from memory, 0 searches' : `searched ${count ?? scenario.webToolCalls}×`
  }
  const tooMany = scenario.failures.find((failure) => failure.startsWith('Too many web tool calls:'))
  if (tooMany) {
    return `searched ${parseCount(tooMany) ?? scenario.webToolCalls}×`
  }
  if (scenario.failures.some((failure) => failure.startsWith('Empty response'))) {
    return 'returned an empty response'
  }
  const citations = scenario.failures
    .map((failure) => failure.match(/^Insufficient citations: (\d+) found, (\d+) required$/))
    .find(Boolean)
  if (citations) {
    return `cited ${citations[1]} sources`
  }
  if (scenario.failures.some((failure) => failure.startsWith('No <widget:link-preview>'))) {
    return 'returned no link previews'
  }
  const judgeFailure = scenario.failures
    .map((failure) => failure.match(/^Judge rejected ([^:]+):/))
    .find(Boolean)
  if (judgeFailure) {
    const descriptions: Readonly<Record<string, string>> = {
      'answer correctness': 'gave an answer the judge found incorrect',
      'search offer': 'did not offer to verify',
      'premise rebuttal': 'did not clearly rebut the false premise',
      'verification disclaimer': 'did not admit that the answer could not be verified',
    }
    return descriptions[judgeFailure[1]] ?? `failed the ${judgeFailure[1]} check`
  }
  const error = scenario.failures.find((failure) => failure.startsWith('Error:'))
  if (error) {
    return `hit an eval error: ${error.slice('Error:'.length).trim()}`
  }
  return `failed: ${scenario.failures.join('; ')}`
}

const coreExpectation = (scenario: EvalScenarioMetrics): string => {
  const citationFailure = scenario.failures
    .map((failure) => failure.match(/^Insufficient citations: \d+ found, (\d+) required$/))
    .find(Boolean)
  if (citationFailure) {
    return `cite at least ${citationFailure[1]} ${citationFailure[1] === '1' ? 'source' : 'sources'}`
  }
  if (scenario.failures.some((failure) => failure.startsWith('Empty response'))) {
    return 'produce a response'
  }
  if (scenario.failures.some((failure) => failure.startsWith('No <widget:link-preview>'))) {
    return 'include link previews'
  }
  return 'pass the classic suite checks'
}

const scenarioExpectation = (scenario: EvalScenarioMetrics): string => {
  if (scenario.category === 'core') {
    return coreExpectation(scenario)
  }
  if (scenario.category === 'multi_turn_reuse' && scenario.isNegativeControl) {
    return 'search again because the follow-up asks a new question'
  }
  return expectationByCategory[scenario.category]
}

const failureSection = (metrics: EvalMetrics): string[] => {
  const failures = Object.entries(metrics.groups).flatMap(([groupKey, group]) =>
    Object.entries(group.scenarios)
      .filter(([, scenario]) => !scenario.passed)
      .map(([, scenario]) => ({
        groupKey,
        model: modelDisplayName(group.model),
        scenario,
      })),
  )
  if (failures.length === 0) {
    return []
  }
  const visible = failures.slice(0, failureDisplayLimit)
  const lines = [
    '<details open>',
    `<summary>❌ Exactly what failed, in plain words (${failures.length} ${failures.length === 1 ? 'scenario' : 'scenarios'})</summary>`,
    '',
  ]
  for (const groupFailures of Object.values(Object.groupBy(visible, ({ groupKey }) => groupKey))) {
    const first = groupFailures?.[0]
    if (!first || !groupFailures) {
      continue
    }
    lines.push(
      `**${first.model}**`,
      '',
      ...groupFailures.map(
        ({ scenario }) =>
          `- Asked *"${escapePrompt(scenario.prompt)}"* → ${observedFailure(scenario)}. Expected: ${scenarioExpectation(scenario)}.`,
      ),
      '',
    )
  }
  const hiddenCount = failures.length - visible.length
  if (hiddenCount > 0) {
    lines.push(`…and ${hiddenCount} more — see full numbers.`, '')
  }
  lines.push('</details>', '')
  return lines
}

const fullNumbersSection = (
  metrics: EvalMetrics,
  comparison: ReturnType<typeof compareMetricsToBaselines>,
): string[] => {
  const lines = [
    '<details>',
    '<summary>📊 Full numbers (gates, categories, headline rates)</summary>',
    '',
  ]
  for (const [groupKey, group] of Object.entries(metrics.groups)) {
    const groupComparison = comparison.groups[groupKey]
    lines.push(
      `### ${groupKey}`,
      '',
      '| Headline metric | Current | Delta vs baseline | Gate |',
      '|---|---:|---:|---|',
      `| Unnecessary search | ${formatPercent(group.headline.unnecessarySearchRate.rate)} | ${formatRateDelta(groupComparison.headline.unnecessarySearchRate)} | ${gateLabel(group.headline.unnecessarySearchRate.gatePassed)} |`,
      `| Missed search | ${formatPercent(group.headline.missedSearchRate.rate)} | ${formatRateDelta(groupComparison.headline.missedSearchRate)} | ${gateLabel(group.headline.missedSearchRate.gatePassed)} |`,
      `| Mean web calls, no-search expected | ${group.headline.meanWebCallsNoSearchExpected.toFixed(3)} | ${formatMeanDelta(groupComparison.headline.meanWebCallsNoSearchExpected.delta)} | none |`,
      '',
      '| Category | Current | Delta vs baseline | Gate |',
      '|---|---:|---:|---|',
      ...Object.entries(group.categories).map(([category, categoryMetrics]) => {
        const categoryComparison = groupComparison.categories[category as NecessityCategory]
        if (!categoryComparison) {
          throw new Error(`Missing category comparison for ${groupKey}/${category}`)
        }
        return `| ${category} | ${categoryMetrics.passed}/${categoryMetrics.total} (${formatPercent(categoryMetrics.rate)}) | ${formatRateDelta(categoryComparison)} | ${gateLabel(categoryMetrics.gatePassed)} |`
      }),
      '',
    )
  }
  lines.push('</details>', '')
  return lines
}

const glossarySection = (): string[] => [
  '<details>',
  '<summary>❓ How to read this report</summary>',
  '',
  '- **Search policy**: behavior categories testing whether the model should search the web or answer from memory — never search timeless facts; always search prices and news; verify false claims before rebutting; reuse earlier results instead of re-searching; and so on.',
  '- **Gates vs baseline**: gates grade each model against fixed policy thresholds; the baseline measures whether this PR changed behavior relative to a nightly run from `main`. A failed gate can describe known model behavior without implicating your PR.',
  '- **Smoke vs nightly**: PR smoke uses n=1 and k=1, so one miss shows as 0% and is only a quick signal. Nightly uses n=12×k=3 for the real measurement; significance requires non-overlapping 95% Wilson intervals.',
  '- **Engines**: `pi` is the in-app coding harness used in production for Opus and Flash; `legacy` is the direct pipeline used in production for GLM via Tinfoil.',
  '',
  '</details>',
  '',
]

const suiteScale = (metrics: EvalMetrics): string => {
  const groups = Object.values(metrics.groups)
  const categoryTotals = groups.flatMap((group) => Object.values(group.categories).map(({ total }) => total))
  const necessityScenarios = groups.flatMap((group) =>
    Object.values(group.scenarios).filter(({ category }) => category !== 'core'),
  )
  const sampleCounts = [...new Set(necessityScenarios.map(({ sampleCount }) => sampleCount))]
  if (categoryTotals.length > 0 && categoryTotals.every((total) => total === 1) && sampleCounts.every((k) => k === 1)) {
    return 'smoke suite (1 scenario per category, k=1)'
  }
  const minimum = Math.min(...categoryTotals)
  const maximum = Math.max(...categoryTotals)
  const scenarioScale =
    minimum === maximum ? `${minimum} scenarios per category` : `${minimum}–${maximum} scenarios per category`
  return `full suite (${scenarioScale}, k=${sampleCounts.join('/')})`
}

const footer = (metrics: EvalMetrics | null, options: RenderOptions): string => {
  const parts = [
    options.runUrl ? `[Full report](${options.runUrl})` : 'Full report unavailable',
    options.artifactUrl ? `[Artifacts](${options.artifactUrl})` : 'Artifacts unavailable',
  ]
  if (options.commitSha) {
    parts.push(`commit \`${options.commitSha.slice(0, 7)}\``)
  }
  if (metrics) {
    parts.push(suiteScale(metrics))
  }
  return parts.join(' · ')
}

/** Render the sticky pull-request comment from current metrics and optional checked-in baselines. */
export const renderEvalComment = (
  metrics: EvalMetrics | null,
  baselines: Record<string, EvalBaseline>,
  options: RenderOptions,
): string => {
  const informational = options.informational ?? true
  if (!metrics) {
    return [
      evalCommentMarker,
      '## AI Evals — ❌ eval metrics were not produced',
      '',
      'Eval metrics were not produced. Check the workflow logs and report artifact.',
      '',
      footer(null, options),
    ].join('\n')
  }

  const comparison = compareMetricsToBaselines(metrics, baselines)
  const verdict = verdictCopy(comparison, informational)
  return [
    evalCommentMarker,
    `## AI Evals — ${verdict.title}`,
    '',
    `**TL;DR:** ${verdict.tldr}`,
    '',
    ...careTable(comparison, informational),
    ...modelTable(metrics, comparison),
    ...failureSection(metrics),
    ...fullNumbersSection(metrics, comparison),
    ...glossarySection(),
    footer(metrics, options),
  ].join('\n')
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
  const metrics = existsSync(metricsPath)
    ? (JSON.parse(readFileSync(metricsPath, 'utf8')) as EvalMetrics)
    : null
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
