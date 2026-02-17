import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EvalResult, EvalSummary } from './types'

/** Generate summary statistics from results */
export const summarize = (results: EvalResult[]): EvalSummary => {
  const total = results.length
  const passed = results.filter((r) => r.passed).length

  const byModel: EvalSummary['byModel'] = {}
  const byMode: EvalSummary['byMode'] = {}

  for (const r of results) {
    const model = r.scenario.modelName
    const mode = r.scenario.modeName

    byModel[model] ??= { total: 0, passed: 0, passRate: 0 }
    byModel[model].total++
    if (r.passed) byModel[model].passed++

    byMode[mode] ??= { total: 0, passed: 0, passRate: 0 }
    byMode[mode].total++
    if (r.passed) byMode[mode].passed++
  }

  const rate = (p: number, t: number) => (t === 0 ? 0 : Math.round((p / t) * 100))

  for (const stats of Object.values(byModel)) stats.passRate = rate(stats.passed, stats.total)
  for (const stats of Object.values(byMode)) stats.passRate = rate(stats.passed, stats.total)

  return { total, passed, failed: total - passed, passRate: rate(passed, total), byModel, byMode }
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

  console.log(`\n${b}By Mode:${reset}`)
  for (const [mode, stats] of Object.entries(summary.byMode)) {
    const color = stats.passRate >= 80 ? g : stats.passRate >= 50 ? y : r
    console.log(`  ${color}${mode}: ${stats.passed}/${stats.total} (${stats.passRate}%)${reset}`)
  }

  // Show failures
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

/** Write a markdown report file */
export const writeMarkdownReport = (results: EvalResult[], summary: EvalSummary, outputPath: string) => {
  const lines: string[] = [
    '# Eval Results',
    '',
    `**Date**: ${new Date().toISOString()}`,
    `**Total**: ${summary.total} scenarios | **Passed**: ${summary.passed} | **Failed**: ${summary.failed} | **Pass Rate**: ${summary.passRate}%`,
    '',
    '## By Model',
    '',
    '| Model | Passed | Total | Rate |',
    '|-------|--------|-------|------|',
    ...Object.entries(summary.byModel).map(([model, s]) => `| ${model} | ${s.passed} | ${s.total} | ${s.passRate}% |`),
    '',
    '## By Mode',
    '',
    '| Mode | Passed | Total | Rate |',
    '|------|--------|-------|------|',
    ...Object.entries(summary.byMode).map(([mode, s]) => `| ${mode} | ${s.passed} | ${s.total} | ${s.passRate}% |`),
    '',
    '## Detailed Results',
    '',
    '| Scenario | Status | Citations | Widgets | Links | Steps | Chars | Time | Failures |',
    '|----------|--------|-----------|---------|-------|-------|-------|------|----------|',
    ...results.map(
      (r) =>
        `| ${r.scenario.id} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.citations.length} | ${r.widgets.length} | ${r.linkPreviewUrls.length} | ${r.toolCallCount} | ${r.responseLength} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.failures.join('; ') || '-'} |`,
    ),
    '',
  ]

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, lines.join('\n'), 'utf-8')
  console.log(`\nReport saved to: ${outputPath}`)
}

/** Generate both console and file reports */
export const generateReport = (results: EvalResult[]) => {
  const summary = summarize(results)
  printConsoleReport(results, summary)

  const outputPath = process.env.EVAL_OUTPUT ?? '.team/eval-results.md'
  writeMarkdownReport(results, summary, outputPath)
}
