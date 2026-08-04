/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { aggregateEvalMetrics } from './stats'
import type { EvalMetrics, EvalResult, EvalSummary } from './types'

const rateEmoji = (rate: number) => (rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴')

const formatDate = (date: Date) =>
  date.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })

const timestamp = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const formatPercent = (rate: number) => `${(rate * 100).toFixed(1)}%`
const gateVerdict = (passed: boolean) => (passed ? '✅ pass' : '❌ fail')

/** Generate summary statistics from results */
export const summarize = (results: EvalResult[]): EvalSummary => {
  const total = results.length
  const passed = results.filter((r) => r.passed).length

  const byModel: EvalSummary['byModel'] = {}
  const byEngine: EvalSummary['byEngine'] = {}
  const byMode: EvalSummary['byMode'] = {}

  for (const r of results) {
    const model = r.scenario.modelName
    const engine = r.scenario.engineName
    const mode = r.scenario.modeName

    byModel[model] ??= { total: 0, passed: 0, passRate: 0 }
    byModel[model].total++
    if (r.passed) {
      byModel[model].passed++
    }

    byEngine[engine] ??= { total: 0, passed: 0, passRate: 0 }
    byEngine[engine].total++
    if (r.passed) {
      byEngine[engine].passed++
    }

    byMode[mode] ??= { total: 0, passed: 0, passRate: 0 }
    byMode[mode].total++
    if (r.passed) {
      byMode[mode].passed++
    }
  }

  const rate = (p: number, t: number) => (t === 0 ? 0 : Math.round((p / t) * 100))

  for (const stats of Object.values(byModel)) {
    stats.passRate = rate(stats.passed, stats.total)
  }
  for (const stats of Object.values(byEngine)) {
    stats.passRate = rate(stats.passed, stats.total)
  }
  for (const stats of Object.values(byMode)) {
    stats.passRate = rate(stats.passed, stats.total)
  }

  return { total, passed, failed: total - passed, passRate: rate(passed, total), byModel, byEngine, byMode }
}

/** Print a console summary with colors */
export const printConsoleReport = (results: EvalResult[], summary: EvalSummary) => {
  const g = '\x1b[32m'
  const r = '\x1b[31m'
  const y = '\x1b[33m'
  const b = '\x1b[1m'
  const reset = '\x1b[0m'

  console.log('\n' + '='.repeat(60))
  console.log(`${b}EVAL REPORT${reset}`)
  console.log('='.repeat(60))

  console.log(`\n${b}Overall:${reset} ${summary.passed}/${summary.total} passed (${summary.passRate}%)`)

  console.log(`\n${b}By Model:${reset}`)
  for (const [model, stats] of Object.entries(summary.byModel)) {
    const color = stats.passRate >= 80 ? g : stats.passRate >= 50 ? y : r
    console.log(`  ${color}${model}: ${stats.passed}/${stats.total} (${stats.passRate}%)${reset}`)
  }

  console.log(`\n${b}By Engine:${reset}`)
  for (const [engine, stats] of Object.entries(summary.byEngine)) {
    const color = stats.passRate >= 80 ? g : stats.passRate >= 50 ? y : r
    console.log(`  ${color}${engine}: ${stats.passed}/${stats.total} (${stats.passRate}%)${reset}`)
  }

  console.log(`\n${b}By Mode:${reset}`)
  for (const [mode, stats] of Object.entries(summary.byMode)) {
    const color = stats.passRate >= 80 ? g : stats.passRate >= 50 ? y : r
    console.log(`  ${color}${mode}: ${stats.passed}/${stats.total} (${stats.passRate}%)${reset}`)
  }

  const failures = results.filter((r) => !r.passed)
  if (failures.length > 0) {
    console.log(`\n${b}${r}Failures (${failures.length}):${reset}`)
    for (const f of failures) {
      console.log(`  ${r}FAIL${reset} ${f.scenario.id}`)
      for (const reason of f.failures) {
        console.log(`    - ${reason}`)
      }
    }
  }

  console.log('\n' + '='.repeat(60))
}

const buildNecessityLines = (results: EvalResult[], metrics: EvalMetrics, now: Date): string[] => {
  if (!results.some(({ scenario }) => scenario.category)) {
    return []
  }
  const lines = ['## Search Necessity Gate', '']
  for (const [groupKey, group] of Object.entries(metrics.groups)) {
    lines.push(
      `### ${groupKey}`,
      '',
      '| Category | Passed | Rate | Wilson 95% | Gate | Verdict |',
      '|----------|:------:|:----:|:----------:|:----:|:-------:|',
      ...Object.entries(group.categories).map(
        ([category, stats]) =>
          `| ${category} | ${stats.passed}/${stats.total} | ${formatPercent(stats.rate)} | ${formatPercent(stats.wilson.lower)}–${formatPercent(stats.wilson.upper)} | ≥${formatPercent(stats.threshold)} | ${gateVerdict(stats.gatePassed)} |`,
      ),
      '',
      '| Headline metric | Result | Gate | Verdict |',
      '|-----------------|:------:|:----:|:-------:|',
      `| Unnecessary-search rate | ${group.headline.unnecessarySearchRate.count}/${group.headline.unnecessarySearchRate.total} (${formatPercent(group.headline.unnecessarySearchRate.rate)}) | ≤${formatPercent(group.headline.unnecessarySearchRate.threshold)} | ${gateVerdict(group.headline.unnecessarySearchRate.gatePassed)} |`,
      `| Missed-search rate | ${group.headline.missedSearchRate.count}/${group.headline.missedSearchRate.total} (${formatPercent(group.headline.missedSearchRate.rate)}) | ≤${formatPercent(group.headline.missedSearchRate.threshold)} | ${gateVerdict(group.headline.missedSearchRate.gatePassed)} |`,
      `| Mean web calls per no-search-expected prompt | ${group.headline.meanWebCallsNoSearchExpected.toFixed(3)} | — | — |`,
      '',
    )
  }

  const today = now.toISOString().slice(0, 10)
  const overdue = [
    ...new Set(
      results
        .filter(({ scenario }) => scenario.reviewBy && scenario.reviewBy < today)
        .map(({ scenario }) => `${scenario.id} (${scenario.reviewBy})`),
    ),
  ]
  if (overdue.length > 0) {
    lines.push('### Past-due review dates', '', ...overdue.map((warning) => `- ⚠️ ${warning}`), '')
  }
  return lines
}

/** Write machine-readable modal outcomes and aggregates beside the markdown report. */
export const writeMetricsReport = (
  results: EvalResult[],
  markdownPath: string,
  generatedAt = new Date().toISOString(),
): string => {
  const outputPath = join(dirname(markdownPath), 'eval-metrics.json')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(aggregateEvalMetrics(results, generatedAt), null, 2)}\n`, 'utf-8')
  return outputPath
}

/** Write a markdown report file. When `detailed` is true, includes a Failures section with prompts and reasons. */
export const writeMarkdownReport = (
  results: EvalResult[],
  summary: EvalSummary,
  outputPath: string,
  detailed: boolean,
  now = new Date(),
) => {
  const models = [...new Set(results.map((r) => r.scenario.modelName))].join(', ')
  const engines = [...new Set(results.map((r) => r.scenario.engineName))].join(', ')
  const modes = [...new Set(results.map((r) => r.scenario.modeName))].join(', ')
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0)

  const lines: string[] = [
    `# ${rateEmoji(summary.passRate)} Eval Report — ${summary.passRate}% pass rate`,
    '',
    `> **${formatDate(now)}** | ${summary.total} scenarios | ${(totalDuration / 1000).toFixed(0)}s total`,
    '>',
    `> Models: \`${models}\` | Engines: \`${engines}\` | Modes: \`${modes}\``,
    '',
    '---',
    '',
    '## Overview',
    '',
    `| | Passed | Failed | Total | Rate |`,
    `|---|:---:|:---:|:---:|:---:|`,
    `| **All** | ${summary.passed} | ${summary.failed} | ${summary.total} | ${rateEmoji(summary.passRate)} **${summary.passRate}%** |`,
    '',
    '### By Model',
    '',
    '| Model | Passed | Failed | Total | Rate |',
    '|-------|:---:|:---:|:---:|:---:|',
    ...Object.entries(summary.byModel).map(
      ([model, s]) =>
        `| ${model} | ${s.passed} | ${s.total - s.passed} | ${s.total} | ${rateEmoji(s.passRate)} ${s.passRate}% |`,
    ),
    '',
    '### By Engine',
    '',
    '| Engine | Passed | Failed | Total | Rate |',
    '|--------|:---:|:---:|:---:|:---:|',
    ...Object.entries(summary.byEngine).map(
      ([engine, s]) =>
        `| ${engine} | ${s.passed} | ${s.total - s.passed} | ${s.total} | ${rateEmoji(s.passRate)} ${s.passRate}% |`,
    ),
    '',
    '### By Mode',
    '',
    '| Mode | Passed | Failed | Total | Rate |',
    '|------|:---:|:---:|:---:|:---:|',
    ...Object.entries(summary.byMode).map(
      ([mode, s]) =>
        `| ${mode} | ${s.passed} | ${s.total - s.passed} | ${s.total} | ${rateEmoji(s.passRate)} ${s.passRate}% |`,
    ),
    '',
    '---',
    '',
    ...buildNecessityLines(results, aggregateEvalMetrics(results, now.toISOString()), now),
    ...(results.some(({ scenario }) => scenario.category) ? ['---', ''] : []),
    '## Results',
    '',
    '| | Scenario | Citations | Widgets | Links | Web calls | Dups | Samples | Errors | Chars | Time |',
    '|---|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---:|',
    ...results.map((r) => {
      const icon = r.passed ? '✅' : '❌'
      return `| ${icon} | ${r.scenario.id} | ${r.citations.length} | ${r.widgets.length} | ${r.linkPreviewUrls.length} | ${r.toolCallCount} | ${r.duplicateToolCallCount} | ${r.passedSampleCount ?? Number(r.passed)}/${r.sampleCount ?? 1} | ${r.errorSampleCount ?? Number(Boolean(r.error))} | ${r.responseLength} | ${(r.durationMs / 1000).toFixed(1)}s |`
    }),
    '',
  ]

  if (detailed) {
    const failures = results.filter((r) => !r.passed)
    if (failures.length > 0) {
      lines.push('---', '', '## Failures', '')
      for (const f of failures) {
        lines.push(
          `### ❌ ${f.scenario.id}`,
          '',
          '| Field | Value |',
          '|-------|-------|',
          `| **Prompt** | ${f.scenario.prompt} |`,
          `| **Duration** | ${(f.durationMs / 1000).toFixed(1)}s |`,
          ...(f.error ? [`| **Error** | \`${f.error}\` |`] : []),
          '',
          '**Failure reasons:**',
          '',
          ...f.failures.map((reason) => `- ${reason}`),
          '',
        )
      }
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, lines.join('\n'), 'utf-8')
  console.log(`\nReport saved to: ${outputPath}`)
}

/** Generate both console and file reports */
export const generateReport = (results: EvalResult[], detailed = false) => {
  const summary = summarize(results)
  printConsoleReport(results, summary)

  const outputPath = process.env.EVAL_OUTPUT ?? `evals/eval-results-${timestamp()}.md`
  const now = new Date()
  writeMarkdownReport(results, summary, outputPath, detailed, now)
  const metricsPath = writeMetricsReport(results, outputPath, now.toISOString())
  console.log(`Metrics saved to: ${metricsPath}`)
}
