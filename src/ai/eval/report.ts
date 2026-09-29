/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acceptEval, serializeArtifact } from './stats'
import type { EvalManifest, EvalMetrics, EvalTrial } from './types'

const percent = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(1)}%`)

/** Render the same manifest-driven acceptance and numbers for terminal, Markdown and PR comments. */
export const renderMetricsReport = (metrics: EvalMetrics, detailed = false): string => {
  const acceptance = acceptEval(metrics)
  const lines = [
    `# Eval Report — ${acceptance.exitCode === 0 ? 'pass' : 'non-passing'} (exit ${acceptance.exitCode})${acceptance.partial ? ' — partial; not definition-of-done evidence' : ''}`,
    '',
    '| Cell | Acceptance | Post-retry errors | First-attempt errors (generation / judge) | Tool infra / misuse |',
    '|---|---|---|---|---|',
    ...metrics.manifest.cells.map(({ key }) => {
      const group = metrics.groups[key]
      const decision = acceptance.cells[key]
      if (!group) {
        return `| ${key} | absent | — | — | — |`
      }
      const reliability = group.reliability
      return `| ${key} | ${decision.exitCode === 0 ? 'pass' : `exit ${decision.exitCode}`} | ${reliability.errors}/${reliability.planned} (${percent(reliability.rate)}) | ${percent(reliability.firstAttemptErrorRate)} (${reliability.firstAttemptGenerationErrors}/${reliability.planned} / ${reliability.firstAttemptJudgeErrors}/${reliability.planned}) | ${percent(reliability.toolInfraErrorRate)} / ${percent(reliability.toolMisuseRate)} |`
    }),
    '',
    `Pooled post-retry error rate (diagnostic only): ${percent(metrics.pooledErrorRate)}. Per-cell gate: ≤10%.`,
    '',
    ...acceptance.reasons.map((reason) => `- ${reason}`),
    '',
    '## Category quality and search headlines',
    '',
  ]
  for (const [key, group] of Object.entries(metrics.groups)) {
    lines.push(
      `### ${key}`,
      '',
      '| Category | State | Quality | Valid / planned | 95% SEM | pass^3 (coverage) | End-to-end | Gate |',
      '|---|---|---|---|---|---|---|---|',
    )
    for (const [category, stats] of Object.entries(group.categories)) {
      const interval = stats.interval
      const uncertainty = interval
        ? `±${percent(interval.margin)}; ${interval.label}${interval.flagged ? '; low-information interval' : ''}`
        : '—'
      lines.push(
        `| ${category} | ${stats.state} | ${percent(stats.rate)} | ${stats.valid}/${stats.planned} | ${uncertainty} | ${stats.pass3 ? `${percent(stats.pass3.rate)} (${stats.pass3.eligible}/${stats.pass3.required})` : 'omitted'} | ${percent(stats.endToEnd)} | ≥${percent(stats.threshold)} |`,
      )
    }
    lines.push('', '| Headline | State | Count / valid | Rate |', '|---|---|---|---|')
    for (const [name, metric] of [
      ['Unnecessary-search rate', group.headline.unnecessarySearchRate],
      ['Missed-search rate', group.headline.missedSearchRate],
    ] as const) {
      lines.push(`| ${name} | ${metric.state} | ${metric.count}/${metric.total} | ${percent(metric.rate)} |`)
    }
    lines.push(
      '',
      `Mean web calls, no-search expected: ${group.headline.meanWebCallsNoSearchExpected ?? '—'}. Scored turn not reached: ${group.scoredTurnNotReached}. Core any-failure rule: ${group.corePassed ? 'pass' : 'non-passing'}.`,
      '',
      '| Scenario | c / f / e / n | Behaviour (completeness) |',
      '|---|---|---|',
    )
    for (const [id, scenario] of Object.entries(group.scenarios)) {
      lines.push(
        `| ${id} | ${scenario.c}/${scenario.f}/${scenario.e}/${scenario.n} | ${scenario.behaviour} (${scenario.completeness}) |`,
      )
      if (detailed && (scenario.f || scenario.e)) {
        lines.push('', `Prompt: ${scenario.prompt}`, ...scenario.failures.map((failure) => `- ${failure}`), '')
      }
    }
    lines.push('')
  }
  const overdue = metrics.manifest.scenarios.filter(
    ({ scenario }) => scenario.reviewBy && scenario.reviewBy < metrics.generatedAt.slice(0, 10),
  )
  if (overdue.length) {
    lines.push(
      '### Past-due review dates',
      '',
      ...overdue.map(({ scenario }) => `- ${scenario.id} (${scenario.reviewBy})`),
      '',
    )
  }
  lines.push('## Run manifest', '', '```json', serializeArtifact(metrics.manifest, undefined, 2), '```', '')
  return JSON.parse(serializeArtifact(lines.join('\n'))) as string
}

/** Start a fresh append-only journal before execution; completed trials survive a later crash. */
export const startTrialJournal = (manifest: EvalManifest, directory: string): string => {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'eval-trials.jsonl')
  writeFileSync(path, `${serializeArtifact({ schemaVersion: 4, manifest })}\n`)
  return path
}

/** Append exactly one completed trial, with credentials removed before writing. */
export const appendTrial = (path: string, trial: EvalTrial): void => {
  appendFileSync(path, `${serializeArtifact(trial)}\n`)
}

/** Write the manifest, every trial and aggregates beside the human-readable report. */
export const writeMetricsReport = (metrics: EvalMetrics, markdownPath: string): string => {
  const path = join(dirname(markdownPath), 'eval-metrics.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${serializeArtifact(metrics, undefined, 2)}\n`)
  return path
}

/** Write a report using the shared acceptance policy. */
export const writeMarkdownReport = (metrics: EvalMetrics, outputPath: string, detailed = false): void => {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderMetricsReport(metrics, detailed))
}

/** Publish local report artifacts and print the same per-cell verdicts. */
export const generateReport = (
  metrics: EvalMetrics,
  detailed = false,
  outputPath = process.env.EVAL_OUTPUT ?? 'evals/eval-results.md',
): void => {
  writeMarkdownReport(metrics, outputPath, detailed)
  writeMetricsReport(metrics, outputPath)
  console.log(renderMetricsReport(metrics))
}
