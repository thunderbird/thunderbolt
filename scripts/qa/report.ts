#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Filed, Scorecard } from './file-findings'
import { type FindingFile, loadFindings } from './findings'
import type { Verified, VerifiedFinding } from './verify'

type Stop = 'done' | 'max_budget' | 'max_turns' | 'timeout' | 'error'
export type Session = {
  charter: string
  cost_usd: number
  turns: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  stop: Stop
}

type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
}
export type ResultMessage = {
  type: 'result'
  subtype?: string
  is_error?: boolean
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  /** All zeros on a budget cut, so tokens come from `modelUsage`. */
  usage?: { input_tokens?: number; output_tokens?: number }
  modelUsage?: Record<string, ModelUsage>
}

const toStop = (subtype?: string): Stop => {
  if (subtype === 'success') return 'done'
  if (subtype === 'error_max_budget_usd') return 'max_budget'
  if (subtype === 'error_max_turns') return 'max_turns'
  return 'error'
}

const readJson = async <T>(path: string): Promise<T | undefined> => {
  const file = Bun.file(path)
  return (await file.exists()) ? ((await file.json()) as T) : undefined
}

/**
 * Session metrics from a claude-code-action execution file (a JSON array of SDK messages ending in the
 * `result` message). Tokens are summed from `modelUsage`: on a budget cut `usage` is all zeros.
 * A missing file or result message is `timeout` when the job timed out, otherwise `error`.
 */
export const sessionFromExecution = async (path: string, charter: string, timedOut = false): Promise<Session> => {
  // A job killed mid-write leaves a truncated file: the session was cut, and its numbers are unknown.
  const messages = await readJson<{ type?: string }[]>(path).catch((error) => {
    console.error(`Unreadable execution file ${path}: ${error}`)
    return undefined
  })
  const result = messages?.findLast((m) => m.type === 'result') as ResultMessage | undefined
  const usage = Object.values(result?.modelUsage ?? {})
  const sum = (pick: (u: ModelUsage) => number | undefined) => usage.reduce((total, u) => total + (pick(u) ?? 0), 0)
  const fallbackStop = timedOut ? 'timeout' : 'error'
  return {
    charter,
    cost_usd: result?.total_cost_usd ?? sum((u) => u.costUSD),
    turns: result?.num_turns ?? 0,
    duration_ms: result?.duration_ms ?? 0,
    input_tokens: sum((u) => u.inputTokens),
    output_tokens: sum((u) => u.outputTokens),
    cache_read_tokens: sum((u) => u.cacheReadInputTokens),
    cache_creation_tokens: sum((u) => u.cacheCreationInputTokens),
    stop: !result ? fallbackStop : result.is_error && result.subtype === 'success' ? 'error' : toStop(result.subtype),
  }
}

/** Suggested cap = max observed + 50%; undefined without samples. A run has at most nine sessions per step. */
export const suggestCap = (samples: number[]) => (samples.length === 0 ? undefined : Math.max(...samples) * 1.5)

/** The fields of `qa/canaries/canaries.json` the matcher reads; the rest is for people. */
type Canary = { patch: string; keywords: string[] }
type CanaryResult = {
  found: number
  total: number
  results: (Canary & { found: boolean })[]
  /** Broke on the normal build too: real bugs, never counted. */
  real: string[]
  /** Caused by a canary but matching no canary's keywords. */
  unattributed: string[]
}

const findingId = (f: Pick<FindingFile, 'charterDir' | 'id'>) => `${f.charterDir}/${f.id}`
const findingText = ({ finding }: FindingFile) =>
  [finding.title, ...finding.steps, finding.actual].join(' ').toLowerCase()

const mentions = (canary: Canary, f: FindingFile) =>
  canary.keywords.some((k) => findingText(f).includes(k.toLowerCase()))

/**
 * A canary is found when a canary-leg finding (confirmed or flaky) replays on the normal build without failing, so
 * the canary patch caused it, and mentions one of the canary's keywords; one finding finds one canary at most.
 * Area and oracle type are not compared: the explorer files the same bug under different ones. A finding the
 * baseline never ran, or ran on an unhealthy stack, is not proven canary-caused and counts as real.
 */
export const matchCanaries = (canaries: Canary[], findings: VerifiedFinding[], baseline: Verified): CanaryResult => {
  const caused = (f: VerifiedFinding) =>
    !baseline.stack_unhealthy &&
    baseline.dropped.some(
      ({ gate, file }) =>
        gate === 'replay' &&
        findingId(file) === findingId(f) &&
        'replay' in file &&
        file.replay.runs > 0 &&
        file.replay.failed === 0,
    )
  const canaryCaused = findings.filter(caused)
  // ponytail: greedy in canary order, so overlapping keywords can undercount; use a bipartite match if they do.
  const used = new Set<VerifiedFinding>()
  const results = canaries.map((c) => {
    const match = canaryCaused.find((f) => !used.has(f) && mentions(c, f))
    if (match) used.add(match)
    return { ...c, found: match !== undefined }
  })
  return {
    found: results.filter((r) => r.found).length,
    total: results.length,
    results,
    real: findings.filter((f) => !caused(f)).map(findingId),
    unattributed: canaryCaused.filter((f) => !canaries.some((c) => mentions(c, f))).map(findingId),
  }
}

type Summary = { visited: string[]; skipped: { screen: string; reason: string }[] }

type ReportInput = {
  sessions: Session[]
  summaries: Map<string, Summary>
  found: number
  verified?: Verified
  filed?: Filed[]
  scorecard?: Scorecard
  canary?: CanaryResult
}

const stopLabel = {
  done: 'done',
  max_budget: 'BUDGET CAP',
  max_turns: 'TURN CAP',
  timeout: 'TIMEOUT',
  error: 'ERROR',
} as const satisfies Record<Stop, string>

const usd = (n: number) => `$${n.toFixed(2)}`
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`
const tokens = (s: Session) =>
  `${s.input_tokens} in / ${s.output_tokens} out / ${s.cache_read_tokens} cache read / ${s.cache_creation_tokens} cache write`
const escapeCell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** Fix sessions record their metrics as `fix-<fp>`; every other session explored a charter. */
const isFix = (s: Session) => s.charter.startsWith('fix-')

/** True when explore sessions ran and every one errored or timed out (a revoked key, a retired model id). */
export const nothingExplored = (sessions: Session[]) => {
  const explore = sessions.filter((s) => !isFix(s))
  return explore.length > 0 && explore.every((s) => s.stop === 'error' || s.stop === 'timeout')
}

const calibrationRows = (explore: Session[], fixes: Session[], judgeCost?: number) => {
  const row = (step: string, metric: string, samples: number[], format: (n: number) => string) => {
    const cap = suggestCap(samples)
    return cap === undefined
      ? undefined
      : `| ${step} | ${metric} | ${samples.length} | ${format(Math.max(...samples))} | ${format(cap)} |`
  }
  const steps = [
    ['explore', explore],
    ['fix', fixes],
  ] as const
  return [
    ...steps.flatMap(([step, samples]) => [
      row(
        step,
        'cost',
        samples.map((s) => s.cost_usd),
        usd,
      ),
      row(
        step,
        'turns',
        samples.map((s) => s.turns),
        (n) => `${Math.ceil(n)}`,
      ),
      row(
        step,
        'duration',
        samples.map((s) => s.duration_ms),
        minutes,
      ),
    ]),
    row('judge', 'cost', judgeCost === undefined ? [] : [judgeCost], usd),
  ].filter((r): r is string => r !== undefined)
}

const gateYield = ({ found, verified, filed }: ReportInput) => {
  if (!verified) return []
  const dropped = (gate: string) => verified.dropped.filter((d) => d.gate === gate).length
  const afterOracle = found - verified.observations.length - dropped('schema')
  const afterLint = afterOracle - dropped('lint')
  const afterReplay = afterLint - dropped('replay')
  // Flaky findings are never judged, and a regression is a new ticket too.
  const filedCount = filed?.filter((a) => ['created', 'regression'].includes(a.would ?? a.action)).length
  return [
    `found ${found} → oracle ${afterOracle} → lint ${afterLint} → replay ${afterReplay} (${verified.flaky.length} flaky)` +
      ` → judge ${verified.confirmed.length}${filedCount === undefined ? '' : ` → filed ${filedCount}`}`,
  ]
}

/** Render the run report as Markdown. Cut and failed sessions come first so an incomplete charter never looks clean. */
export const renderReport = (input: ReportInput) => {
  const { sessions, summaries, verified, filed, scorecard, canary } = input
  const out: string[] = ['# Weekly QA run']
  const explore = sessions.filter((s) => !isFix(s))
  const fixes = sessions.filter(isFix)
  const total = (list: Session[]) =>
    `${usd(list.reduce((t, s) => t + s.cost_usd, 0))}, ${list.reduce((t, s) => t + s.turns, 0)} turns, ` +
    minutes(list.reduce((t, s) => t + s.duration_ms, 0))
  const cut = sessions.filter((s) => s.stop !== 'done')
  if (cut.length > 0) {
    out.push(
      '',
      `## ⚠️ ${cut.length} INCOMPLETE session(s)`,
      ...cut.map(
        (s) =>
          `- **${s.charter}**: ${stopLabel[s.stop]} after ${s.turns} turns, ${usd(s.cost_usd)}; ` +
          (isFix(s) ? 'its patch may be partial' : 'the charter was not fully explored'),
      ),
    )
  }
  out.push(
    '',
    '## Sessions',
    '| charter | cost | turns | duration | tokens | stop |',
    '|---|---|---|---|---|---|',
    ...sessions.map(
      (s) =>
        `| ${s.charter} | ${usd(s.cost_usd)} | ${s.turns} | ${minutes(s.duration_ms)} | ${tokens(s)} | ${s.stop === 'done' ? 'done' : `**${stopLabel[s.stop]}**`} |`,
    ),
    '',
    `Total explore: ${total(explore)}. Fix: ${fixes.length ? total(fixes) : 'n/a'}. ` +
      `Judge: ${verified?.judge_usage ? usd(verified.judge_usage.cost_usd) : 'n/a'}.`,
    '',
    '## Coverage',
    ...explore.flatMap((s) => {
      const summary = summaries.get(s.charter)
      if (!summary) return [`- **${s.charter}**: no summary (session cut)`]
      const skipped = summary.skipped.map((k) => `${k.screen} (${k.reason})`).join('; ') || 'none'
      return [`- **${s.charter}**: visited ${summary.visited.join(', ') || 'none'}; skipped ${skipped}`]
    }),
  )
  if (verified) {
    out.push('', '## Gate yield', ...gateYield(input))
    out.push(
      '',
      `### Dropped (${verified.dropped.length})`,
      ...verified.dropped.map((d) => `- ${d.file.charterDir}/${d.file.id}: **${d.gate}** — ${escapeCell(d.reason)}`),
    )
  }
  if (filed) {
    out.push(
      '',
      '## Filed',
      ...filed.map((a) =>
        `- ${a.action}${a.would ? ` (would ${a.would})` : ''} ${a.fp} ${a.severity} ${a.identifier ?? ''} ${a.reason ?? ''}`.trimEnd(),
      ),
    )
  }
  if (scorecard) out.push('', '## Scorecard', '```json', JSON.stringify(scorecard, null, 2), '```')
  if (canary) {
    out.push(
      '',
      `## Canary recall: ${canary.found}/${canary.total}`,
      ...canary.results.map((r) => `- ${r.found ? 'found' : '**MISSED**'} ${r.patch}`),
      `Unattributed canary-caused findings: ${canary.unattributed.join(', ') || 'none'}`,
      `Real bugs seen in the canary leg (not counted): ${canary.real.join(', ') || 'none'}`,
    )
  }
  const rows = calibrationRows(explore, fixes, verified?.judge_usage?.cost_usd)
  if (rows.length > 0) {
    out.push(
      '',
      '## Calibration hint (cap = max observed + 50%)',
      '| step | metric | samples | max observed | suggested cap |',
      '|---|---|---|---|---|',
      ...rows,
    )
  }
  return `${out.join('\n')}\n`
}

const loadSessions = async (outDir: string) => {
  const paths = await Array.fromAsync(new Bun.Glob('*/session.json').scan(outDir))
  return Promise.all(paths.sort().map((p) => Bun.file(join(outDir, p)).json() as Promise<Session>))
}

const runSummary = async (outDir: string) => {
  const sessions = await loadSessions(outDir)
  const summaries = new Map<string, Summary>()
  for (const s of sessions) {
    const summary = await readJson<Summary>(join(outDir, s.charter, 'findings.json'))
    if (summary) summaries.set(s.charter, summary)
  }
  const { valid, rejected } = await loadFindings(outDir)
  const report = renderReport({
    sessions,
    summaries,
    found: valid.length + rejected.length,
    verified: await readJson<Verified>(join(outDir, 'verified.json')),
    filed: await readJson<Filed[]>(join(outDir, 'filed.json')),
    scorecard: await readJson<Scorecard>(join(outDir, 'scorecard.json')),
    canary: await readJson<CanaryResult>(join(outDir, 'canary.json')),
  })
  await writeFile(join(outDir, 'report.md'), report)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report)
  return { report, nothingExplored: nothingExplored(sessions) }
}

/**
 * Canary leg: match its confirmed and flaky findings against `canaries.json` and the baseline (the same findings
 * replayed on the normal build, its `candidates.json`), and write `canary.json`. The filer never sees the canary
 * leg: the file job downloads only the weekly leg's `verified.json`.
 */
export const runCanary = async (outDir: string, baselineDir: string, canariesPath = 'qa/canaries/canaries.json') => {
  const verified: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const baseline: Verified = await Bun.file(join(baselineDir, 'candidates.json')).json()
  const canaries: Canary[] = await Bun.file(canariesPath).json()
  const result = matchCanaries(canaries, [...verified.confirmed, ...verified.flaky], baseline)
  await writeFile(join(outDir, 'canary.json'), JSON.stringify(result, null, 2))
  return result
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'qa-out' },
      'execution-file': { type: 'string' },
      charter: { type: 'string' },
      'timed-out': { type: 'boolean', default: false },
      baseline: { type: 'string' },
    },
  })
  const out = values.out
  if (positionals[0] === 'session') {
    if (!values.charter || !values['execution-file']) throw new Error('session needs --charter and --execution-file')
    const session = await sessionFromExecution(values['execution-file'], values.charter, values['timed-out'])
    await mkdir(join(out, values.charter), { recursive: true })
    await writeFile(join(out, values.charter, 'session.json'), JSON.stringify(session, null, 2))
  } else if (positionals[0] === 'summary') {
    const summary = await runSummary(out)
    console.log(summary.report)
    // The report is written first; failing then lets notify-on-failure fire although every job stayed green.
    if (summary.nothingExplored) {
      console.error('::error::Every explore session ended in an error or a timeout.')
      process.exitCode = 1
    }
  } else if (positionals[0] === 'canary') {
    if (!values.baseline) throw new Error('canary needs --baseline')
    const result = await runCanary(out, values.baseline)
    console.log(`canary recall ${result.found}/${result.total}`)
  } else {
    throw new Error('usage: report.ts session|summary|canary --out qa-out [--baseline dir]')
  }
}
