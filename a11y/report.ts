/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns `results.jsonl` from `wcag.audit.ts` into `report.md`: one row per
 * problem with the WCAG criteria, how serious it is, and where it showed up.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding } from './support/checks'

const dir = import.meta.dirname
const resultsFile = join(dir, 'results.jsonl')
const findings: Finding[] = existsSync(resultsFile)
  ? readFileSync(resultsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : []

const notesFile = join(dir, 'notes.jsonl')
type NoteLine = { note?: string; started?: string; completed?: string }
const noteLines: NoteLine[] = existsSync(notesFile)
  ? readFileSync(notesFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : []
const notes = noteLines.flatMap((line) => (line.note ? [line.note] : []))
const started = new Set(noteLines.flatMap((line) => (line.started ? [line.started] : [])))
const completed = new Set(noteLines.flatMap((line) => (line.completed ? [line.completed] : [])))
const unfinished = [...started].filter((screen) => !completed.has(screen))
// An unreachable target or a crash before the first scan leaves nothing recorded, which must not read as clean.
const runFailed = (process.env.A11Y_EXIT_STATUS ?? '0') !== '0'
const incomplete = runFailed || completed.size === 0 || unfinished.length > 0

const impactOrder = ['critical', 'serious', 'moderate', 'minor', 'unknown']
const screenOf = (state: string) => state.replace(/ \((light|dark|default theme)\)$/, '')

type Row = { finding: Finding; screens: Set<string>; instances: number; examples: Set<string> }
const rows = new Map<string, Row>()
for (const finding of findings) {
  // The summary names the control for focus-return findings, so each affected control stays its own row.
  const key = `${finding.source}:${finding.rule}:${finding.summary}`
  const row = rows.get(key) ?? { finding, screens: new Set(), instances: 0, examples: new Set() }
  row.screens.add(screenOf(finding.state))
  row.instances += finding.count
  finding.examples.forEach((example) => row.examples.size < 4 && row.examples.add(example))
  rows.set(key, row)
}
const sorted = [...rows.values()].sort(
  (a, b) => impactOrder.indexOf(a.finding.impact) - impactOrder.indexOf(b.finding.impact) || b.instances - a.instances,
)

const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
const baseUrl = process.env.A11Y_BASE_URL ?? 'http://localhost:1420'
const lines = [
  '# WCAG audit',
  '',
  `Target: ${baseUrl} · Run: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  '',
  'axe-core (WCAG 2.0/2.1/2.2 A and AA rules, plus best practices) on every screen in light and dark,',
  'plus scripted checks: keyboard focus visibility, focus return after closing dialogs, reflow at',
  '200% and 400% zoom (640px and 320px wide), and controls sharing one name.',
  '',
  ...(incomplete
    ? [
        '**Incomplete: the audit did not finish.** Findings below are partial and the absence of a problem proves nothing.',
        '',
        `- Screens completed: ${[...completed].join(', ') || 'none'}`,
        ...(unfinished.length ? [`- Screens cut off: ${unfinished.join(', ')}`] : []),
        ...(runFailed ? ['- The Playwright run failed; see its output.'] : []),
        '',
      ]
    : []),
  ...(notes.length ? ['## Coverage', '', ...notes.map((note) => `- ${note}`), ''] : []),
  `Screens: ${[...new Set(findings.map((finding) => screenOf(finding.state)))].sort().join(', ') || 'none with findings'}`,
  '',
  sorted.length === 0
    ? incomplete
      ? 'No problems found so far.'
      : 'No problems found.'
    : `${sorted.length} distinct problems.`,
  '',
  '| Impact | WCAG | Problem | Screens | Instances | Check |',
  '| --- | --- | --- | --- | --- | --- |',
  ...sorted.map(
    ({ finding, screens, instances }) =>
      `| ${finding.impact} | ${finding.criteria.join(', ') || 'best practice'} | ${escape(finding.summary)} | ${screens.size} | ${instances} | ${finding.source === 'axe' ? `[axe: ${finding.rule}](${finding.helpUrl})` : finding.rule} |`,
  ),
  '',
  '## Details',
  '',
  ...sorted.flatMap(({ finding, screens, examples }) => [
    `### ${escape(finding.summary)}`,
    '',
    `${finding.impact} · WCAG ${finding.criteria.join(', ') || 'best practice'} · ${[...screens].join(', ')}`,
    '',
    ...[...examples].map((example) => `- \`${escape(example).slice(0, 220)}\``),
    '',
  ]),
]
writeFileSync(join(dir, 'report.md'), `${lines.join('\n')}\n`)
console.log(`Wrote a11y/report.md: ${sorted.length} distinct problems from ${findings.length} findings`)
