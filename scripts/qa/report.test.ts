/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawFinding } from './findings'
import {
  matchCanaries,
  renderReport,
  runCanary,
  sessionFromExecution,
  suggestCap,
  type ResultMessage,
  type Session,
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
    expect((await sessionFromExecution(broken, 'c3')).stop).toBe('error')
  })
})

describe('suggestCap', () => {
  it('is max + 50% under 20 samples and undefined with none', () => {
    expect(suggestCap([1, 4, 2])).toBe(6)
    expect(suggestCap([])).toBeUndefined()
  })

  it('uses p95 + 50% from 20 samples, ignoring the single outlier', () => {
    const samples = [...Array.from({ length: 19 }, (_, i) => i + 1), 100]
    expect(suggestCap(samples)).toBe(19 * 1.5)
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
      summaries: new Map([['c1', { visited: ['chat'], skipped: [{ screen: 'export', reason: 'no data' }] }]]),
      found: 0,
    })
    const firstSection = report.split('## Sessions')[0]
    expect(firstSection).toContain('2 INCOMPLETE')
    expect(firstSection).toContain('**c2**: BUDGET CAP')
    expect(firstSection).toContain('**c3**: TIMEOUT')
    expect(report).toContain('- **c1**: visited chat; skipped export (no data)')
    expect(report).toContain('- **c2**: no summary (session cut)')
  })

  it('has no incomplete banner when every session finished', () => {
    expect(renderReport({ sessions: [session({})], summaries: new Map(), found: 0 })).not.toContain('INCOMPLETE')
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
      found: 6,
      verified,
      filed: [{ fp: 'abcd1234', severity: 'Medium', action: 'dry-run', would: 'created' }],
      canary: {
        found: 1,
        total: 3,
        results: [
          { patch: 'a.patch', charter: 'c8', area: 'skills', oracle: 'page-error', description: '', found: true },
          {
            patch: 'b.patch',
            charter: 'c8',
            area: 'settings',
            oracle: 'lost-on-reload',
            description: '',
            found: false,
          },
        ],
      },
    })
    expect(report).toContain('found 6 → oracle 4 → lint 4 → replay 4 (1 flaky) → judge 3 → filed 1')
    expect(report).toContain('c1/3: **schema** — bad \\| json')
    expect(report).toContain('c1/4: **judge** — known issue')
    expect(report).toContain('dry-run (would created) abcd1234 Medium')
    expect(report).toContain('Judge: $0.12')
    expect(report).toContain('Canary recall: 1/3')
    expect(report).toContain('**MISSED** b.patch')
  })

  it('adds a calibration row per metric with max observed and the +50% cap', () => {
    const report = renderReport({
      sessions: [
        session({ cost_usd: 2, turns: 30 }),
        session({ charter: 'c2', cost_usd: 4, turns: 60, duration_ms: 1_200_000 }),
      ],
      summaries: new Map(),
      found: 0,
    })
    expect(report).toContain('| explore | cost | 2 | $4.00 | $6.00 |')
    expect(report).toContain('| explore | turns | 2 | 60 | 90 |')
    expect(report).toContain('| explore | duration | 2 | 20.0 min | 30.0 min |')
  })
})

describe('canaries', () => {
  const canaries = [
    { patch: 'a.patch', charter: 'c8-phone', area: 'settings', oracle: 'lost-on-reload', description: '' },
    { patch: 'b.patch', charter: 'c8-phone', area: 'skills', oracle: 'page-error', description: '' },
    { patch: 'c.patch', charter: 'c8-phone', area: 'layout', oracle: 'overflow', description: '' },
  ]

  it('matches on area and oracle type, not on the oracle alone', () => {
    const result = matchCanaries(canaries, [
      verifiedFinding('settings', 'lost-on-reload'),
      verifiedFinding('chat', 'page-error'),
    ])
    expect(result.found).toBe(1)
    expect(result.results.map((r) => r.found)).toEqual([true, false, false])
  })

  it('moves matched findings out of confirmed and flaky so they are never filed', async () => {
    const other = verifiedFinding('chat', 'stuck', '5')
    await writeFile(
      join(dir, 'verified.json'),
      JSON.stringify({
        ...emptyVerified,
        confirmed: [verifiedFinding('settings', 'lost-on-reload'), other],
        flaky: [verifiedFinding('layout', 'overflow', '2')],
      }),
    )
    await mkdir(join(dir, 'c'))
    const canariesPath = join(dir, 'canaries.json')
    await writeFile(canariesPath, JSON.stringify(canaries))

    const result = await runCanary(dir, canariesPath)

    expect(result.found).toBe(2)
    const written = JSON.parse(await readFile(join(dir, 'verified.json'), 'utf8'))
    expect(written.confirmed).toEqual([other])
    expect(written.flaky).toEqual([])
    expect(written.canaryFindings).toHaveLength(2)
    expect(JSON.parse(await readFile(join(dir, 'canary.json'), 'utf8')).found).toBe(2)
  })
})
