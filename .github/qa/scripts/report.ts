#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { Canary } from './canaries'
import { type Filed, sanitize, type Scorecard } from './file-findings'
import { type FindingFile, loadFindings, realAiCharters } from './findings'
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
 * the reverted fixes caused it, and mentions one of the canary's keywords; one finding finds one canary at most.
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

/** One entry of `.github/qa/functions.json`: what must work in an area, and whether it must survive a reload. */
export type QaFunction = { id: string; outcome: string; reload?: boolean }

const attemptSchema = z.object({
  function: z.string(),
  setup: z.string(),
  action: z.string(),
  expected: z.string(),
  observed: z.string(),
  status: z.enum(['passed', 'failed', 'blocked', 'unattempted']),
})
type Attempt = z.infer<typeof attemptSchema>
/** `<charter>/attempts/<id>.json` as the explorer wrote it; `attempt` is missing when it is no valid record. */
export type AttemptFile = { id: string; attempt?: Attempt }

/** An entry of `<charter>/transcript.json`, as `.github/qa/transcript.jq` writes it. */
export type TranscriptMessage = {
  message: {
    content: (
      | { type: 'tool_use'; id: string; name: string; input?: { file_path?: string } }
      | { type: 'tool_result'; tool_use_id: string; content: string }
    )[]
  }
}
type Step = { kind: 'call'; tool: string; path?: string } | { kind: 'result'; tool: string; text: string }

const toSteps = (transcript: TranscriptMessage[]): Step[] => {
  const blocks = transcript.flatMap((m) => m.message.content)
  const names = new Map(blocks.flatMap((b) => (b.type === 'tool_use' ? [[b.id, b.name] as const] : [])))
  return blocks.map(
    (b): Step =>
      b.type === 'tool_use'
        ? { kind: 'call', tool: b.name, path: b.input?.file_path }
        : { kind: 'result', tool: names.get(b.tool_use_id) ?? '', text: b.content },
  )
}

/** `click` for `mcp__playwright__browser_click` (and device B's `mcp__playwright_b__…`); undefined for other tools. */
const browserTool = (tool: string) => /^mcp__playwright(?:_b)?__browser_(\w+)$/.exec(tool)?.[1]
const readOnlyTools = new Set([
  'snapshot',
  'console_messages',
  'network_requests',
  'network_request',
  'evaluate',
  'find',
  'take_screenshot',
  'wait_for',
])
const isAction = (step: Step) => {
  const tool = step.kind === 'call' ? browserTool(step.tool) : undefined
  return tool !== undefined && !readOnlyTools.has(tool)
}
const isNavigation = (step: Step) =>
  step.kind === 'call' && ['navigate', 'navigate_back'].includes(browserTool(step.tool) ?? '')
/** The id of the attempt record a Write call wrote; undefined for every other step. */
const recordWritten = (step: Step) =>
  step.kind === 'call' && step.tool === 'Write' ? /\/attempts\/([^/]+)\.json$/.exec(step.path ?? '')?.[1] : undefined

/**
 * Spacing, the JSON escapes of an evaluate result and the snapshot's `[ref=…]` and `[cursor=…]` markers do not count,
 * so a quote may span snapshot lines and be copied from an evaluate result either escaped or not.
 */
const normalize = (text: string) =>
  text
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["\\])/g, '$1')
    .replace(/\[(?:ref|cursor)=[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
/** A browser tool echoes the code it ran, typed text included, which says nothing about the page. */
const echoedCode = /### Ran Playwright code\n```\w*\n[\s\S]*?\n```/g
const minQuote = 10

/**
 * Why an attempt's `observed` quote is not backed by the transcript, or undefined when it is. The quote must be in a
 * browser tool's result within the attempt's window (from the previous record written after a browser action to
 * its own record), after a browser action in that window and, with `reload`, after a navigation that follows a
 * change in that window. The code a tool echoes back never counts.
 */
const evidenceProblem = (steps: Step[], { id, attempt }: { id: string; attempt: Attempt }, reload: boolean) => {
  const end = steps.findLastIndex((step) => recordWritten(step) === id)
  if (end < 0) return 'record not written in this session'
  const quote = normalize(attempt.observed)
  if (quote.length < minQuote) return `quote under ${minQuote} characters`
  // Records written back to back, with no browser action in between, share one window.
  const start =
    1 +
    steps.findLastIndex((step, i) => i < end && recordWritten(step) !== undefined && steps.slice(i, end).some(isAction))
  const quoted = steps.flatMap((step, i) =>
    i >= start &&
    i < end &&
    step.kind === 'result' &&
    browserTool(step.tool) !== undefined &&
    normalize(step.text.replace(echoedCode, '')).includes(quote)
      ? [i]
      : [],
  )
  if (quoted.length === 0) return 'quote not in a browser tool result of this attempt'
  const first = (pick: (step: Step) => boolean) => steps.findIndex((step, i) => i >= start && pick(step))
  const action = first(isAction)
  if (!quoted.some((r) => action >= 0 && action < r)) return 'no browser action before the quoted result'
  // ponytail: any reload after the window's first change counts, even one before the change under test; tie the
  // reload to the last change before the quote if sampled attempts show explorers exploiting it.
  const change = first((step) => isAction(step) && !isNavigation(step))
  if (reload && !quoted.some((r) => change >= 0 && steps.slice(change, r).some(isNavigation))) {
    return 'no reload between the change and the quoted result'
  }
  return undefined
}

type Verdict = { id: string; state: 'passed' | 'failed' | 'unsupported' | 'blocked' | 'unattempted'; reason?: string }
export type Coverage = {
  verdicts: Verdict[]
  records: number
  invalid: string[]
  unknown: string[]
  transcript: boolean
}

/**
 * Evidence-supported coverage of one session. Every function in the area's list gets a verdict, so one without a
 * record is unattempted. A function is covered (passed or failed) only when one of its passed or failed attempts is
 * backed by the transcript (`evidenceProblem`); without a transcript none is. A passed attempt at a `reload`
 * function also needs the reload; a failed one does not.
 */
export const checkCoverage = (
  functions: QaFunction[],
  files: AttemptFile[],
  transcript?: TranscriptMessage[],
): Coverage => {
  const steps = transcript && toSteps(transcript)
  const records = files.flatMap(({ id, attempt }) => (attempt ? [{ id, attempt }] : []))
  const verdict = ({ id, reload }: QaFunction): Verdict => {
    const tries = records.filter((r) => r.attempt.function === id)
    const checked = tries
      .filter((r) => r.attempt.status === 'passed' || r.attempt.status === 'failed')
      .map((r) => ({
        status: r.attempt.status,
        problem: steps ? evidenceProblem(steps, r, reload === true && r.attempt.status === 'passed') : 'no transcript',
      }))
    const backed = checked.filter((c) => c.problem === undefined)
    if (backed.length > 0) return { id, state: backed.some((c) => c.status === 'failed') ? 'failed' : 'passed' }
    if (checked.length > 0) return { id, state: 'unsupported', reason: checked[0].problem }
    return { id, state: tries.some((r) => r.attempt.status === 'blocked') ? 'blocked' : 'unattempted' }
  }
  const known = new Set(functions.map((fn) => fn.id))
  return {
    verdicts: functions.map(verdict),
    records: files.length,
    invalid: files.filter((f) => !f.attempt).map((f) => f.id),
    unknown: [...new Set(records.map((r) => r.attempt.function).filter((id) => !known.has(id)))],
    transcript: steps !== undefined,
  }
}

type ReportInput = {
  sessions: Session[]
  coverage: Map<string, Coverage>
  /** The charter directory of every finding file the explorers wrote, valid or not. */
  found: string[]
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
/** Model-written text for the public job summary: one line, no foreign links or images, capped. */
const safe = (text: string, max: number) => sanitize(escapeCell(text), max)

/** Free sessions record their metrics as `free-<case>-<platform>`: they play a case and have no function list. */
const isFree = (charter: string) => charter.startsWith('free-')

const verdictStates = ['passed', 'failed', 'unsupported', 'blocked', 'unattempted'] as const

/**
 * A charter session's coverage of its function list. A free session's "functions" are the names of its own attempt
 * records, so it lists what it tried, passed ones included, instead of a share covered.
 */
const coverageParts = (charter: string, { verdicts, records, invalid, unknown, transcript }: Coverage) => {
  const free = isFree(charter)
  const covered = verdicts.filter((v) => v.state === 'passed' || v.state === 'failed').length
  const groups = [
    ...verdictStates
      .filter((state) => free || state !== 'passed')
      .map((state): [string, string[]] => [
        state,
        verdicts
          .filter((v) => v.state === state)
          .map((v) => (v.reason && transcript ? `${safe(v.id, 40)} (${v.reason})` : safe(v.id, 40))),
      ]),
    ['invalid records', invalid.map((id) => safe(id, 40))],
    ['unknown function ids', unknown.map((id) => safe(id, 40))],
  ] satisfies [string, string[]][]
  const headline = free ? `tried ${verdicts.length}` : `${covered}/${verdicts.length} covered`
  return [
    `${headline}${transcript ? '' : `, **no transcript** (${records} records unchecked)`}`,
    ...groups.filter(([, ids]) => ids.length > 0).map(([label, ids]) => `${label}: ${ids.join(', ')}`),
  ]
}

const coverageLine = (charter: string, coverage?: Coverage) =>
  `- **${charter}**: ${(coverage ? coverageParts(charter, coverage) : ['no function list']).join('; ')}`

/** A flaky finding with its evidence. A security finding's text stays out of the public summary. */
const flakyLine = ({ charterDir, id, finding, replay }: VerifiedFinding) => {
  const text =
    finding.area === 'security'
      ? 'security finding, text withheld'
      : `${safe(finding.title, 150)} — ${finding.oracle.type}: "${safe(finding.oracle.evidence, 300)}"`
  return `- ${charterDir}/${id}: ${text} (failed ${replay.failed}/${replay.runs} replays)`
}

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

/** One group of sessions' findings: how many the explorers wrote, what verify made of them, and what was filed. */
type Findings = { found: number; verified?: Verified; filed?: Filed[] }

/** The findings of the sessions whose charter directory `keep` selects. */
const findingsOf = ({ found, verified, filed }: ReportInput, keep: (charterDir: string) => boolean): Findings => ({
  found: found.filter(keep).length,
  verified: verified && {
    ...verified,
    confirmed: verified.confirmed.filter((f) => keep(f.charterDir)),
    flaky: verified.flaky.filter((f) => keep(f.charterDir)),
    observations: verified.observations.filter((f) => keep(f.charterDir)),
    dropped: verified.dropped.filter((d) => keep(d.file.charterDir)),
    deferred: verified.deferred?.filter((d) => keep(d.file.charterDir)),
  },
  filed: filed?.filter((a) => keep(a.charterDir)),
})

const gateYield = (found: number, verified: Verified, filed?: Filed[]) => {
  const dropped = (gate: string) => verified.dropped.filter((d) => d.gate === gate).length
  const deferred = (step: string) => (verified.deferred ?? []).filter((d) => d.step === step).length
  const afterOracle = found - verified.observations.length - dropped('schema')
  const afterLint = afterOracle - dropped('lint')
  const afterReplay = afterLint - deferred('replay') - dropped('replay')
  // Flaky findings are never judged, and a regression is a new ticket too.
  const filedCount = filed?.filter((a) => ['created', 'regression'].includes(a.would ?? a.action)).length
  return [
    `found ${found} → oracle ${afterOracle} → lint ${afterLint} → replay ${afterReplay} ` +
      `(${verified.flaky.length} flaky, ${deferred('replay')} deferred) → judge ${verified.confirmed.length} ` +
      `(${deferred('judge')} deferred)${filedCount === undefined ? '' : ` → filed ${filedCount}`}`,
  ]
}

/** Gate yield, the flaky, deferred and dropped lists, and what was filed; `label` tells two groups' sections apart. */
const findingsSection = ({ found, verified, filed }: Findings, label: string) => {
  const out: string[] = []
  if (verified) {
    out.push('', `## Gate yield${label}`, ...gateYield(found, verified, filed))
    out.push('', `### Flaky (${verified.flaky.length}), never filed`, ...verified.flaky.map(flakyLine))
    const deferred = verified.deferred ?? []
    if (deferred.length > 0) {
      out.push(
        '',
        `### Deferred (${deferred.length}), over a cap`,
        ...deferred.map((d) => `- ${d.file.charterDir}/${d.file.id}: **${d.step}** — ${d.reason}`),
      )
    }
    out.push(
      '',
      `### Dropped (${verified.dropped.length})`,
      ...verified.dropped.map((d) => `- ${d.file.charterDir}/${d.file.id}: **${d.gate}** — ${safe(d.reason, 500)}`),
    )
  }
  if (filed) {
    out.push(
      '',
      `## Filed${label}`,
      ...filed.map((a) =>
        `- ${a.action}${a.would ? ` (would ${a.would})` : ''} ${a.fp} ${a.severity} ${a.identifier ?? ''} ${a.reason ?? ''}`.trimEnd(),
      ),
    )
  }
  return out
}

const total = (list: Session[]) =>
  `${usd(list.reduce((t, s) => t + s.cost_usd, 0))}, ${list.reduce((t, s) => t + s.turns, 0)} turns, ` +
  minutes(list.reduce((t, s) => t + s.duration_ms, 0))
const metricCells = (s: Session) =>
  `${usd(s.cost_usd)} | ${s.turns} | ${minutes(s.duration_ms)} | ${tokens(s)} | ${s.stop === 'done' ? 'done' : `**${stopLabel[s.stop]}**`}`

const cutNote = (s: Session) => {
  if (isFix(s)) return 'its patch may be partial'
  return isFree(s.charter) ? 'the case was not fully played' : 'the charter was not fully explored'
}

/** The free sessions, apart from the charters: one case on every platform, what each tried, and their findings. */
const freeSection = ({ coverage }: ReportInput, free: Session[], findings: Findings) => [
  '',
  '## Free session',
  'One case, played on every platform with the real AI. What a session tried is its own attempt records, each ' +
    'checked against the transcript like a charter function. App providers: not measured.',
  '',
  '| session (free-case-platform) | cost | turns | duration | tokens | stop |',
  '|---|---|---|---|---|---|',
  ...free.map((s) => `| ${s.charter} | ${metricCells(s)} |`),
  '',
  `Total: ${total(free)}.`,
  '',
  '### What was tried',
  ...free.map((s) => coverageLine(s.charter, coverage.get(s.charter))),
  ...findingsSection(findings, ' (free session)'),
]

/** Render the run report as Markdown. Cut and failed sessions come first so an incomplete charter never looks clean. */
export const renderReport = (input: ReportInput) => {
  const { sessions, coverage, verified, scorecard, canary } = input
  const out: string[] = ['# Weekly QA run']
  const explore = sessions.filter((s) => !isFix(s))
  const fixes = sessions.filter(isFix)
  const free = explore.filter((s) => isFree(s.charter))
  const chartered = explore.filter((s) => !isFree(s.charter))
  const cut = sessions.filter((s) => s.stop !== 'done')
  if (cut.length > 0) {
    out.push(
      '',
      `## ⚠️ ${cut.length} INCOMPLETE session(s)`,
      ...cut.map(
        (s) => `- **${s.charter}**: ${stopLabel[s.stop]} after ${s.turns} turns, ${usd(s.cost_usd)}; ${cutNote(s)}`,
      ),
    )
  }
  out.push(
    '',
    '## Sessions',
    '| charter | cost | turns | duration | tokens | stop |',
    '|---|---|---|---|---|---|',
    ...sessions.filter((s) => !isFree(s.charter)).map((s) => `| ${s.charter} | ${metricCells(s)} |`),
    '',
    `Total explore: ${total(chartered)}. Fix: ${fixes.length ? total(fixes) : 'n/a'}. ` +
      `Judge: ${verified?.judge_usage ? usd(verified.judge_usage.cost_usd) : 'n/a'}.` +
      // The backend logs no token counts for the app's own provider calls.
      (chartered.some((s) => realAiCharters.has(s.charter)) ? ' App providers (real-AI charters): not measured.' : ''),
    '',
    '## Coverage',
    'A function counts only when a passed or failed attempt quotes a browser tool result seen after its action, ' +
      'and after a reload where the function needs one.',
    ...chartered.map((s) => coverageLine(s.charter, coverage.get(s.charter))),
    ...findingsSection(
      findingsOf(input, (charterDir) => !isFree(charterDir)),
      '',
    ),
  )
  const freeFindings = findingsOf(input, isFree)
  if (free.length > 0 || freeFindings.found > 0) out.push(...freeSection(input, free, freeFindings))
  if (scorecard) out.push('', '## Scorecard', '```json', JSON.stringify(scorecard, null, 2), '```')
  if (canary) {
    out.push(
      '',
      `## Canary recall: ${canary.found}/${canary.total}`,
      'Each canary is a recent fix from main, reverted in the canary build.',
      ...canary.results.map(
        (r) => `- ${r.found ? 'found' : '**MISSED**'} ${safe(r.title, 150)} (${r.sha.slice(0, 9)}, ${r.charter})`,
      ),
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

const parseAttempt = (text: string) => {
  try {
    return attemptSchema.safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}

const loadAttempts = async (charterDir: string): Promise<AttemptFile[]> => {
  const paths = await Array.fromAsync(new Bun.Glob('attempts/*.json').scan(charterDir))
  return Promise.all(
    paths.sort().map(async (path) => ({
      id: basename(path, '.json'),
      attempt: parseAttempt(await readFile(join(charterDir, path), 'utf8')),
    })),
  )
}

/**
 * Writes `<outDir>/report.md` from everything the run produced, appends it to `stepSummary` when given, and says
 * whether nothing was explored. Coverage reads each session's attempt records and transcript against `functions.json`.
 */
export const runSummary = async (
  outDir: string,
  qaDir = '.github/qa',
  stepSummary = process.env.GITHUB_STEP_SUMMARY,
) => {
  const sessions = await loadSessions(outDir)
  const lists: Record<string, QaFunction[]> = await Bun.file(join(qaDir, 'functions.json')).json()
  const functions = new Map(Object.entries(lists))
  const coverage = new Map<string, Coverage>()
  for (const s of sessions) {
    const dir = join(outDir, s.charter)
    const attempts = await loadAttempts(dir)
    // A free session has no list: each name it gave its own attempts counts as one function.
    const tried = new Set(attempts.flatMap((f) => (f.attempt ? [f.attempt.function] : [])))
    const list = isFree(s.charter) ? [...tried].map((id) => ({ id, outcome: 'tried' })) : functions.get(s.charter)
    if (list) {
      // A save step cut short can leave a broken file: that session has no transcript.
      const transcript = await readJson<TranscriptMessage[]>(join(dir, 'transcript.json')).catch(() => undefined)
      coverage.set(s.charter, checkCoverage(list, attempts, transcript))
    }
  }
  const { valid, rejected } = await loadFindings(outDir)
  const report = renderReport({
    sessions,
    coverage,
    found: [...valid, ...rejected].map((f) => f.charterDir),
    verified: await readJson<Verified>(join(outDir, 'verified.json')),
    filed: await readJson<Filed[]>(join(outDir, 'filed.json')),
    scorecard: await readJson<Scorecard>(join(outDir, 'scorecard.json')),
    canary: await readJson<CanaryResult>(join(outDir, 'canary.json')),
  })
  await writeFile(join(outDir, 'report.md'), report)
  if (stepSummary) await appendFile(stepSummary, report)
  return { report, nothingExplored: nothingExplored(sessions) }
}

/**
 * Canary leg: match its confirmed and flaky findings against the canaries `canaries.ts` picked and the baseline (the
 * same findings replayed on the normal build, its `candidates.json`), and write `canary.json`. The filer never sees
 * the canary leg: the file job downloads only the weekly leg's `verified.json`. A dispatch's `charters` list runs only
 * some canary legs; the canaries of the others never ran, so they are left out rather than counted as missed.
 */
export const runCanary = async (outDir: string, baselineDir: string, canariesPath: string, chartersInput = '') => {
  const verified: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const baseline: Verified = await Bun.file(join(baselineDir, 'candidates.json')).json()
  const picked: Canary[] = await Bun.file(canariesPath).json()
  const ran = chartersInput.split(/[ ,]+/).filter(Boolean)
  const canaries = ran.length === 0 ? picked : picked.filter((c) => ran.includes(c.charter))
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
      canaries: { type: 'string' },
      charters: { type: 'string', default: '' },
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
    if (!values.baseline || !values.canaries) throw new Error('canary needs --baseline and --canaries')
    const result = await runCanary(out, values.baseline, values.canaries, values.charters)
    console.log(`canary recall ${result.found}/${result.total}`)
  } else {
    throw new Error('usage: report.ts session|summary|canary --out qa-out [--baseline dir --canaries manifest.json]')
  }
}
