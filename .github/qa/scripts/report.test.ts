/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawFinding } from './findings'
import {
  checkCoverage,
  matchCanaries,
  nothingExplored,
  renderReport,
  runCanary,
  runSummary,
  sessionFromExecution,
  suggestCap,
  type Coverage,
  type ResultMessage,
  type Session,
  type TranscriptMessage,
} from './report'
import type { Verified, VerifiedFinding } from './verify'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qa-report-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const modelUsage = {
  'claude-sonnet-5-5': {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 1000,
    cacheCreationInputTokens: 200,
    costUSD: 1.5,
  },
  'claude-haiku-4-5': {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 20,
    costUSD: 0.25,
  },
}

const writeExecution = async (result: Partial<Omit<ResultMessage, 'type'>>) => {
  const path = join(dir, 'execution.json')
  await writeFile(path, JSON.stringify([{ type: 'system' }, { type: 'assistant' }, { type: 'result', ...result }]))
  return path
}

describe('sessionFromExecution', () => {
  it('reads a finished session and sums tokens across models', async () => {
    const path = await writeExecution({
      subtype: 'success',
      total_cost_usd: 1.75,
      num_turns: 12,
      duration_ms: 90_000,
      usage: { input_tokens: 1 },
      modelUsage,
    })
    expect(await sessionFromExecution(path, 'c4')).toEqual({
      charter: 'c4',
      cost_usd: 1.75,
      turns: 12,
      duration_ms: 90_000,
      input_tokens: 110,
      output_tokens: 55,
      cache_read_tokens: 1100,
      cache_creation_tokens: 220,
      stop: 'done',
    })
  })

  it('marks a budget cut and takes tokens from modelUsage, not the zeroed usage', async () => {
    const path = await writeExecution({
      subtype: 'error_max_budget_usd',
      is_error: true,
      total_cost_usd: 10.2,
      num_turns: 40,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage,
    })
    const session = await sessionFromExecution(path, 'c1')
    expect(session.stop).toBe('max_budget')
    expect(session.input_tokens).toBe(110)
    expect(session.cost_usd).toBe(10.2)
  })

  it('marks a turn cut and falls back to the summed model cost when total is missing', async () => {
    const path = await writeExecution({ subtype: 'error_max_turns', is_error: true, num_turns: 150, modelUsage })
    const session = await sessionFromExecution(path, 'c2')
    expect(session.stop).toBe('max_turns')
    expect(session.cost_usd).toBe(1.75)
  })

  it('treats an unknown error subtype as an error', async () => {
    const path = await writeExecution({ subtype: 'error_during_execution', is_error: true })
    expect((await sessionFromExecution(path, 'c2')).stop).toBe('error')
  })

  it('is an error for a missing file and a timeout when the job timed out', async () => {
    const missing = join(dir, 'nope.json')
    expect((await sessionFromExecution(missing, 'c3')).stop).toBe('error')
    expect(await sessionFromExecution(missing, 'c3', true)).toMatchObject({ stop: 'timeout', cost_usd: 0, turns: 0 })
  })

  it('handles an execution file without a result message or with broken JSON', async () => {
    const noResult = join(dir, 'a.json')
    await writeFile(noResult, JSON.stringify([{ type: 'assistant' }]))
    expect((await sessionFromExecution(noResult, 'c3', true)).stop).toBe('timeout')
    const broken = join(dir, 'b.json')
    await writeFile(broken, '[{"type":')
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    expect((await sessionFromExecution(broken, 'c3')).stop).toBe('error')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`Unreadable execution file ${broken}`))
    logged.mockRestore()
  })
})

describe('suggestCap', () => {
  it('is max + 50%, and undefined with no samples', () => {
    expect(suggestCap([1, 4, 2])).toBe(6)
    expect(suggestCap([])).toBeUndefined()
  })
})

const session = (over: Partial<Session>): Session => ({
  charter: 'c1',
  cost_usd: 2,
  turns: 30,
  duration_ms: 600_000,
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 1,
  cache_creation_tokens: 1,
  stop: 'done',
  ...over,
})

describe('nothingExplored', () => {
  it('is true only when every explore session errored or timed out, whatever the fix sessions did', () => {
    const failed = [session({ charter: 'c1', stop: 'error' }), session({ charter: 'c2', stop: 'timeout' })]
    expect(nothingExplored(failed)).toBe(true)
    expect(nothingExplored([...failed, session({ charter: 'fix-ab12cd34' })])).toBe(true)
    expect(nothingExplored([...failed, session({ charter: 'c3', stop: 'max_turns' })])).toBe(false)
    expect(nothingExplored([session({ charter: 'fix-ab12cd34', stop: 'error' })])).toBe(false)
    expect(nothingExplored([])).toBe(false)
  })
})

const raw = (area: string, type: string): RawFinding => ({
  title: 't',
  area: area as RawFinding['area'],
  charter: 'c8-phone',
  viewport: 'phone',
  oracle: { type, evidence: 'quoted' },
  steps: ['s'],
  expected: 'e',
  actual: 'a',
  repro_spec: 'repro/1.spec.ts',
})
const verifiedFinding = (area: string, type: string, id = '1'): VerifiedFinding => ({
  charterDir: 'c8-phone',
  id,
  finding: raw(area, type),
  replay: { failed: 3, runs: 3 },
  artifacts: {},
})
const emptyVerified: Verified = { confirmed: [], flaky: [], observations: [], dropped: [] }

describe('renderReport', () => {
  it('flags cut sessions at the top and says when a charter has no summary', () => {
    const report = renderReport({
      sessions: [
        session({ charter: 'c1' }),
        session({ charter: 'c2', stop: 'max_budget' }),
        session({ charter: 'c3', stop: 'timeout' }),
      ],
      summaries: new Map([['c1', { visited: ['chat'] }]]),
      coverage: new Map(),
      found: 0,
    })
    const firstSection = report.split('## Sessions')[0]
    expect(firstSection).toContain('2 INCOMPLETE')
    expect(firstSection).toContain('**c2**: BUDGET CAP')
    expect(firstSection).toContain('**c3**: TIMEOUT')
    expect(report).toContain('- **c1**: no function list; visited chat')
    expect(report).toContain('- **c2**: no function list; no summary (session cut)')
  })

  it('has no incomplete banner when every session finished', () => {
    expect(
      renderReport({ sessions: [session({})], summaries: new Map(), coverage: new Map(), found: 0 }),
    ).not.toContain('INCOMPLETE')
  })

  it('reports gate yield, the full drop list, filed actions and canary recall', () => {
    const verified: Verified = {
      ...emptyVerified,
      confirmed: [verifiedFinding('skills', 'page-error')],
      flaky: [verifiedFinding('layout', 'overflow', '2')],
      observations: [{ charterDir: 'c1', id: '9', finding: raw('chat', 'x') }],
      dropped: [
        { file: { charterDir: 'c1', id: '3', reason: 'x' }, gate: 'schema', reason: 'bad | json' },
        { file: { charterDir: 'c1', id: '4', finding: raw('chat', 'stuck') }, gate: 'judge', reason: 'known issue' },
      ],
      judge_usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.12 },
    }
    const report = renderReport({
      sessions: [session({})],
      summaries: new Map(),
      coverage: new Map(),
      found: 6,
      verified,
      filed: [
        { fp: 'abcd1234', charterDir: 'c1', id: '1', severity: 'Medium', action: 'dry-run', would: 'created' },
        { fp: 'bcde2345', charterDir: 'c1', id: '5', severity: 'High', action: 'regression' },
        { fp: 'cdef3456', charterDir: 'c1', id: '6', severity: 'High', action: 'commented' },
      ],
      canary: {
        found: 1,
        total: 2,
        results: [
          { patch: 'a.patch', keywords: [], found: true },
          { patch: 'b.patch', keywords: [], found: false },
        ],
        real: ['c8-phone/7'],
        unattributed: [],
      },
    })
    expect(report).toContain('found 6 → oracle 4 → lint 4 → replay 4 (1 flaky) → judge 1 → filed 2')
    expect(report).toContain('c1/3: **schema** — bad \\| json')
    expect(report).toContain('c1/4: **judge** — known issue')
    expect(report).toContain('dry-run (would created) abcd1234 Medium')
    expect(report).toContain('Judge: $0.12')
    expect(report).toContain('Canary recall: 1/2')
    expect(report).toContain('**MISSED** b.patch')
    expect(report).toContain('Real bugs seen in the canary leg (not counted): c8-phone/7')
  })

  it('adds a calibration row per metric with max observed and the +50% cap', () => {
    const report = renderReport({
      sessions: [
        session({ cost_usd: 2, turns: 30 }),
        session({ charter: 'c2', cost_usd: 4, turns: 60, duration_ms: 1_200_000 }),
      ],
      summaries: new Map(),
      coverage: new Map(),
      found: 0,
    })
    expect(report).toContain('| explore | cost | 2 | $4.00 | $6.00 |')
    expect(report).toContain('| explore | turns | 2 | 60 | 90 |')
    expect(report).toContain('| explore | duration | 2 | 20.0 min | 30.0 min |')
  })

  it('keeps fix sessions out of the explore calibration and the coverage list', () => {
    const report = renderReport({
      sessions: [
        session({ cost_usd: 2, turns: 30 }),
        session({ charter: 'fix-ab12cd34', cost_usd: 8, turns: 90, stop: 'max_turns' }),
      ],
      summaries: new Map(),
      coverage: new Map(),
      found: 0,
    })
    expect(report).toContain('| explore | cost | 1 | $2.00 | $3.00 |')
    expect(report).toContain('| fix | cost | 1 | $8.00 | $12.00 |')
    expect(report).toContain('| fix | turns | 1 | 90 | 135 |')
    expect(report).toContain('**fix-ab12cd34**: TURN CAP after 90 turns, $8.00; its patch may be partial')
    expect(report.split('## Coverage')[1]).not.toContain('fix-ab12cd34')
  })
})

describe('checkCoverage', () => {
  const record = (id: string) =>
    ['Write', 'File created successfully', `/runner/qa-out/c4/attempts/${id}.json`] as const
  const browser = (tool: string, result = 'ok', device = '') =>
    [`mcp__playwright${device}__browser_${tool}`, result] as const
  const transcriptOf = (steps: readonly (readonly [string, string, string?])[]): TranscriptMessage[] =>
    steps.flatMap(([name, result, path], i) => [
      { message: { content: [{ type: 'tool_use' as const, id: `t${i}`, name, input: { file_path: path } }] } },
      { message: { content: [{ type: 'tool_result' as const, tool_use_id: `t${i}`, content: result }] } },
    ])
  const attempt = (
    id: string,
    fn: string,
    status: 'passed' | 'failed' | 'blocked' | 'unattempted',
    observed: string,
  ) => ({
    id,
    attempt: { function: fn, setup: 'fresh user', action: 'did it', expected: 'it works', observed, status },
  })
  const fns = (...ids: string[]) => ids.map((id) => ({ id, outcome: 'works', reload: id.endsWith('!') }))
  const verdicts = (coverage: Coverage) => coverage.verdicts.map((v) => [v.id, v.state, v.reason])
  const snapshot = '- heading "Skills" [level=1] [ref=e1]\n  - button "Skill Alpha One" [ref=e5] [cursor=pointer]'

  it('covers a function whose quote is in a browser result after its action, across snapshot lines', () => {
    const transcript = transcriptOf([browser('click'), browser('snapshot', snapshot), record('1'), record('2')])
    const coverage = checkCoverage(
      fns('edit', 'slash'),
      [
        attempt('1', 'edit', 'passed', 'heading "Skills" [level=1]\n - button "Skill Alpha One"'),
        attempt('2', 'slash', 'failed', 'button "Skill Alpha One"'),
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['edit', 'passed', undefined],
      ['slash', 'failed', undefined],
    ])
  })

  it('matches a quote of an evaluate result whether it was copied with its JSON escapes or without', () => {
    const result = '### Result\n"Delete this project?\\n\\nChats are kept as \\"ordinary\\" chats."'
    const transcript = transcriptOf([browser('click'), browser('evaluate', result), record('1'), record('2')])
    const coverage = checkCoverage(
      fns('decoded', 'escaped'),
      [
        attempt('1', 'decoded', 'passed', 'Delete this project?\n\nChats are kept as "ordinary" chats.'),
        attempt('2', 'escaped', 'passed', 'Delete this project?\\n\\nChats are kept as \\"ordinary\\"'),
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['decoded', 'passed', undefined],
      ['escaped', 'passed', undefined],
    ])
  })

  it('does not back an invented quote, typed text the tool echoes, a short quote or a Write result', () => {
    const echo =
      "### Ran Playwright code\n```js\nawait page.fill('Skill Alpha One');\n```\n### Page\n- Page URL: /skills"
    const transcript = transcriptOf([
      browser('type', echo),
      browser('snapshot', snapshot),
      record('1'),
      record('2'),
      record('3'),
      record('4'),
    ])
    const coverage = checkCoverage(
      fns('a', 'b', 'c', 'd'),
      [
        attempt('1', 'a', 'passed', 'Skill Beta was saved'),
        attempt('2', 'b', 'passed', "fill('Skill Alpha One')"),
        attempt('3', 'c', 'passed', 'Skills'),
        attempt('4', 'd', 'passed', 'File created successfully'),
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['a', 'unsupported', 'quote not in a browser tool result of this attempt'],
      ['b', 'unsupported', 'quote not in a browser tool result of this attempt'],
      ['c', 'unsupported', 'quote under 10 characters'],
      ['d', 'unsupported', 'quote not in a browser tool result of this attempt'],
    ])
  })

  it("needs an action before the quote and a quote from the attempt's own window", () => {
    const transcript = transcriptOf([
      browser('snapshot', 'Skill Alpha One'),
      browser('click'),
      record('1'),
      browser('click'),
      browser('snapshot', 'Skill Beta Two'),
      record('2'),
      record('3'),
    ])
    const coverage = checkCoverage(
      fns('first', 'second', 'third', 'unwritten'),
      [
        attempt('1', 'first', 'passed', 'Skill Alpha One'),
        attempt('2', 'second', 'passed', 'Skill Alpha One'),
        attempt('3', 'third', 'passed', 'Skill Beta Two'),
        attempt('9', 'unwritten', 'passed', 'Skill Beta Two'),
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['first', 'unsupported', 'no browser action before the quoted result'],
      ['second', 'unsupported', 'quote not in a browser tool result of this attempt'],
      ['third', 'passed', undefined],
      ['unwritten', 'unsupported', 'record not written in this session'],
    ])
  })

  it('needs a reload after the change for a passed reload function, but not for a failed one', () => {
    const transcript = transcriptOf([
      browser('click'),
      browser('snapshot', 'Skill Alpha One'),
      record('1'),
      record('2'),
      browser('click', 'ok', '_b'),
      browser('navigate'),
      browser('snapshot', 'Skill Alpha One', '_b'),
      record('3'),
      browser('navigate'),
      browser('snapshot', 'Skill Alpha One'),
      record('4'),
    ])
    const coverage = checkCoverage(
      fns('saved!', 'lost!', 'reloaded!', 'reload-only!'),
      [
        attempt('1', 'saved!', 'passed', 'Skill Alpha One'),
        attempt('2', 'lost!', 'failed', 'Skill Alpha One'),
        attempt('3', 'reloaded!', 'passed', 'Skill Alpha One'),
        attempt('4', 'reload-only!', 'passed', 'Skill Alpha One'),
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['saved!', 'unsupported', 'no reload between the change and the quoted result'],
      ['lost!', 'failed', undefined],
      ['reloaded!', 'passed', undefined],
      ['reload-only!', 'unsupported', 'no reload between the change and the quoted result'],
    ])
  })

  it('counts every listed function: blocked, unattempted and missing ones, with invalid and unknown records', () => {
    const transcript = transcriptOf([browser('click'), browser('snapshot', 'Skill Alpha One'), record('1')])
    const coverage = checkCoverage(
      fns('done', 'blocked', 'skipped', 'missing'),
      [
        attempt('1', 'done', 'passed', 'Skill Alpha One'),
        attempt('2', 'blocked', 'blocked', 'no reorder control'),
        attempt('3', 'skipped', 'unattempted', 'ran out of ideas'),
        attempt('4', 'other', 'passed', 'Skill Alpha One'),
        { id: 'bad' },
      ],
      transcript,
    )
    expect(verdicts(coverage)).toEqual([
      ['done', 'passed', undefined],
      ['blocked', 'blocked', undefined],
      ['skipped', 'unattempted', undefined],
      ['missing', 'unattempted', undefined],
    ])
    expect(coverage).toMatchObject({ records: 5, invalid: ['bad'], unknown: ['other'], transcript: true })
  })

  it('covers nothing without a transcript', () => {
    const coverage = checkCoverage(fns('done'), [attempt('1', 'done', 'passed', 'Skill Alpha One')])
    expect(coverage.transcript).toBe(false)
    expect(verdicts(coverage)).toEqual([['done', 'unsupported', 'no transcript']])
  })

  it('renders covered counts, the open functions and the no-transcript state per session', () => {
    const transcript = transcriptOf([browser('click'), browser('snapshot', 'Skill Alpha One'), record('1')])
    const files = [attempt('1', 'done', 'failed', 'Skill Alpha One'), attempt('2', 'blocked', 'blocked', 'no control')]
    const report = renderReport({
      sessions: [session({ charter: 'c4' }), session({ charter: 'c8' })],
      summaries: new Map([['c4', { visited: ['Skills'] }]]),
      coverage: new Map([
        ['c4', checkCoverage(fns('done', 'blocked', 'missing'), files, transcript)],
        ['c8', checkCoverage(fns('done'), files)],
      ]),
      found: 0,
    })
    expect(report).toContain(
      '- **c4**: 1/3 covered; failed: done; blocked: blocked; unattempted: missing; visited Skills',
    )
    expect(report).toContain(
      '- **c8**: 0/1 covered, **no transcript** (2 records unchecked); unsupported: done; ' +
        'unknown function ids: blocked; no summary (session cut)',
    )
  })
})

describe('runSummary', () => {
  it('reads attempt records and the transcript of each session against functions.json', async () => {
    const qaDir = join(dir, 'qa')
    const outDir = join(dir, 'out')
    await mkdir(join(outDir, 'c4/attempts'), { recursive: true })
    await mkdir(qaDir)
    const list = [{ id: 'skill-create', outcome: 'shows' }]
    await writeFile(join(qaDir, 'functions.json'), JSON.stringify({ c4: list, c8: list }))
    await writeFile(join(outDir, 'c4/session.json'), JSON.stringify(session({ charter: 'c4' })))
    // A save step cut short: the transcript is broken, and that session counts as having none.
    await mkdir(join(outDir, 'c8'))
    await writeFile(join(outDir, 'c8/session.json'), JSON.stringify(session({ charter: 'c8' })))
    await writeFile(join(outDir, 'c8/transcript.json'), '[{"message":')
    await writeFile(join(outDir, 'c4/findings.json'), JSON.stringify({ visited: ['Skills'], findings_written: 0 }))
    const observed = 'button "Skill Alpha One"'
    await writeFile(
      join(outDir, 'c4/attempts/1.json'),
      JSON.stringify({ function: 'skill-create', setup: 's', action: 'a', expected: 'e', observed, status: 'passed' }),
    )
    await writeFile(join(outDir, 'c4/attempts/2.json'), '{ not json')
    const steps = [
      ['mcp__playwright__browser_click', 'ok'],
      ['mcp__playwright__browser_snapshot', observed],
      ['Write', 'ok', join(outDir, 'c4/attempts/1.json')],
    ]
    const transcript = steps.flatMap(([name, content, path], i) => [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `t${i}`, name, input: { file_path: path } }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content }] } },
    ])
    await writeFile(join(outDir, 'c4/transcript.json'), JSON.stringify(transcript))
    const stepSummary = join(dir, 'step-summary.md')

    const { report } = await runSummary(outDir, qaDir, stepSummary)

    expect(report).toContain('- **c4**: 1/1 covered; invalid records: 2; visited Skills')
    expect(report).toContain(
      '- **c8**: 0/1 covered, **no transcript** (0 records unchecked); unattempted: skill-create',
    )
    expect(await readFile(join(outDir, 'report.md'), 'utf8')).toBe(report)
    expect(await readFile(stepSummary, 'utf8')).toBe(report)
  })
})

describe('canaries', () => {
  const canaries = [
    { patch: 'a.patch', keywords: ['preferred name'] },
    { patch: 'b.patch', keywords: ['delet'] },
    { patch: 'c.patch', keywords: ['subtitle'] },
  ]
  const finding = (id: string, title: string, area = 'other', type = 'console-error') => ({
    ...verifiedFinding(area, type, id),
    finding: { ...raw(area, type), title },
  })
  const droppedOnNormal = (ids: string[], runs = 3): Verified => ({
    ...emptyVerified,
    dropped: ids.map((id) => ({
      file: { ...verifiedFinding('other', 'console-error', id), replay: { failed: 0, runs } },
      gate: 'replay' as const,
      reason: `failed 0/${runs} replays`,
    })),
  })

  it('counts a finding that drops on the normal build and names a keyword, whatever its area and oracle', () => {
    const result = matchCanaries(
      canaries,
      [finding('1', 'Deleting a skill logs an error'), finding('2', 'Row subtitle spills out', 'skills')],
      droppedOnNormal(['1', '2']),
    )
    expect(result.results.map((r) => r.found)).toEqual([false, true, true])
    expect(result.found).toBe(2)
  })

  it('does not count a bug that also fails on the normal build, and lists it as real', () => {
    const result = matchCanaries(canaries, [finding('3', 'Long subtitle overflows the bubble')], emptyVerified)
    expect(result.found).toBe(0)
    expect(result.real).toEqual(['c8-phone/3'])
  })

  it('does not trust a baseline from an unhealthy stack', () => {
    const baseline = { ...droppedOnNormal(['1']), stack_unhealthy: 'control failed' }
    expect(matchCanaries(canaries, [finding('1', 'Delete fails')], baseline)).toMatchObject({
      found: 0,
      real: ['c8-phone/1'],
    })
  })

  it('does not count a spec that never ran on the normal build', () => {
    const result = matchCanaries(canaries, [finding('1', 'Deleting a skill logs an error')], droppedOnNormal(['1'], 0))
    expect(result).toMatchObject({ found: 0, real: ['c8-phone/1'] })
  })

  it('lets one finding find one canary at most', () => {
    const both = finding('6', 'Deleting a skill leaves its subtitle behind')
    const result = matchCanaries(canaries, [both], droppedOnNormal(['6']))
    expect(result.results.map((r) => r.found)).toEqual([false, true, false])
  })

  it('matches keywords case-insensitively in steps and actual too', () => {
    const f = finding('4', 'Something odd')
    f.finding.steps = ['Type a Preferred Name']
    expect(matchCanaries(canaries, [f], droppedOnNormal(['4'])).results[0].found).toBe(true)
  })

  it('reports a canary-caused finding with no keyword as unattributed and does not count it', () => {
    const result = matchCanaries(canaries, [finding('5', 'Sidebar glitch')], droppedOnNormal(['5']))
    expect(result).toMatchObject({ found: 0, unattributed: ['c8-phone/5'], real: [] })
  })

  it('matches the confirmed and flaky canary-leg findings against the baseline and writes canary.json', async () => {
    const baselineDir = join(dir, 'baseline')
    await mkdir(baselineDir)
    await writeFile(join(baselineDir, 'candidates.json'), JSON.stringify(droppedOnNormal(['1'])))
    await writeFile(
      join(dir, 'verified.json'),
      JSON.stringify({
        ...emptyVerified,
        confirmed: [finding('1', 'Delete skill throws')],
        flaky: [finding('2', 'Unrelated real bug')],
      }),
    )
    const canariesPath = join(dir, 'canaries.json')
    await writeFile(canariesPath, JSON.stringify(canaries))

    const result = await runCanary(dir, baselineDir, canariesPath)

    expect(result).toMatchObject({ found: 1, real: ['c8-phone/2'] })
    expect(JSON.parse(await readFile(join(dir, 'canary.json'), 'utf8'))).toEqual(result)
  })

  it('fails loudly without a baseline', async () => {
    await writeFile(join(dir, 'canaries.json'), JSON.stringify(canaries))
    await writeFile(join(dir, 'verified.json'), JSON.stringify(emptyVerified))
    await expect(runCanary(dir, join(dir, 'missing'), join(dir, 'canaries.json'))).rejects.toThrow('candidates.json')
  })
})
