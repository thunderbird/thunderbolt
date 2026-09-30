/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { lintReproSpec, type RawFinding } from './findings'
import {
  judge,
  replay,
  replayEnv,
  type CreateMessage,
  type ReplayReport,
  type RunReplay,
  type Verified,
} from './verify'

const validSpec = (title: string) => `import { expect, test } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('${title}', async ({ page }) => {
  await loginViaEmailCode(page)
  await expect(page.getByText('${title}')).toBeVisible()
})
`

const makeFinding = (title: string, oracle: RawFinding['oracle']): RawFinding => ({
  title,
  area: 'chat',
  charter: 'c2-chat',
  viewport: 'desktop',
  oracle,
  steps: ['Open the chat', 'Send a message'],
  expected: 'The reply appears',
  actual: 'Nothing happens',
  repro_spec: `repro/${title}.spec.ts`,
})

const pageError = { type: 'page-error', evidence: 'TypeError: messages is undefined' }

let outDir: string
let qaDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'qa-verify-out-'))
  qaDir = await mkdtemp(join(tmpdir(), 'qa-verify-qa-'))
  await Bun.write(join(qaDir, 'noise.txt'), '# header\n\n  ResizeObserver loop  \n')
  await Bun.write(join(qaDir, 'judge.md'), 'JUDGE PROMPT')
  await Bun.write(join(qaDir, 'known-issues.md'), 'KNOWN ISSUES')
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
  await rm(qaDir, { recursive: true, force: true })
})

/** Writes `c2-chat/findings/<title>.json` and, unless `spec` is null, its repro spec. */
const writeFinding = async (finding: RawFinding, spec: string | null = validSpec(finding.title)) => {
  await Bun.write(join(outDir, 'c2-chat/findings', `${finding.title}.json`), JSON.stringify(finding))
  if (spec !== null) await Bun.write(join(outDir, 'c2-chat', finding.repro_spec), spec)
}

const controlSpec = () => join(qaDir, 'control/repro/stack.spec.ts')

/**
 * A runner that reports the given result statuses per spec file (relative to `outDir`), one Playwright spec entry
 * per run, plus the control spec's statuses. Every run carries a long, coloured error message.
 */
const fakeRunner =
  (statuses: Record<string, string[]>, calls: string[][], control = ['passed', 'passed', 'passed']): RunReplay =>
  async (specs) => {
    calls.push(specs)
    const entries: [string, string[]][] = [...Object.entries(statuses), [relative(outDir, controlSpec()), control]]
    const report: ReplayReport = {
      config: { rootDir: outDir },
      errors: [],
      suites: entries.map(([file, runs]) => ({
        specs: runs.map((status, run) => ({
          file,
          tests: [
            {
              results: [
                {
                  status,
                  errors: [
                    { message: 'Test timeout of 60000ms exceeded.' },
                    { message: `\u001b[31mError: run ${run} of ${file}\u001b[39m\n${'call log\n'.repeat(300)}` },
                  ],
                  attachments: [
                    { name: 'video', path: join(process.cwd(), `qa-out/replay/${file}-${run}/video.webm`) },
                    { name: 'trace', path: join(process.cwd(), `qa-out/replay/${file}-${run}/trace.zip`) },
                  ],
                },
              ],
            },
          ],
        })),
      })),
    }
    return report
  }

const titles = (files: { finding: RawFinding }[]) => files.map((file) => file.finding.title)
const droppedAt = (result: Verified, gate: Verified['dropped'][number]['gate']) =>
  result.dropped.filter((entry) => entry.gate === gate)

describe('replay', () => {
  test('only findings with an oracle, outside the noise list and with a clean spec reach Playwright', async () => {
    await Bun.write(join(outDir, 'c2-chat/findings/broken.json'), '{ not json')
    await writeFinding(makeFinding('no-oracle', { type: 'looks-off', evidence: 'the button seems odd' }))
    await writeFinding(makeFinding('blank-evidence', { type: 'page-error', evidence: '  ' }))
    await writeFinding(makeFinding('noise', { type: 'console-error', evidence: 'Error: ResizeObserver loop limit' }))
    await writeFinding(makeFinding('console', { type: 'console-error', evidence: 'Failed to load chat list' }))
    // The noise list only applies to console errors.
    await writeFinding(makeFinding('page-noise', { type: 'page-error', evidence: 'ResizeObserver loop crashed' }))
    await writeFinding(makeFinding('unsafe', pageError), 'const key = process.env.ANTHROPIC_API_KEY\n')
    await writeFinding(makeFinding('missing-spec', pageError), null)
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls).toEqual([
      [controlSpec(), join(outDir, 'c2-chat/repro/console.spec.ts'), join(outDir, 'c2-chat/repro/page-noise.spec.ts')],
    ])
    expect(titles(result.observations)).toEqual(['blank-evidence', 'no-oracle', 'noise'])
    expect(droppedAt(result, 'schema')).toEqual([
      {
        file: expect.objectContaining({ charterDir: 'c2-chat', id: 'broken' }),
        gate: 'schema',
        reason: expect.any(String),
      },
    ])
    const lint = droppedAt(result, 'lint')
    expect(lint.map((entry) => entry.file.id)).toEqual(['missing-spec', 'unsafe'])
    expect(lint[0].reason).toBe('repro spec not found')
    expect(lint[1].reason).toContain('"process" is not allowed')
  })

  test('failed 3/3 is confirmed, 1–2/3 flaky and 0/3 dropped, keeping the first failed run details', async () => {
    for (const title of ['always', 'twice', 'once', 'never']) await writeFinding(makeFinding(title, pageError))
    // Two findings with one spec share its replay.
    await writeFinding({ ...makeFinding('always-again', pageError), repro_spec: 'repro/always.spec.ts' }, null)
    const calls: string[][] = []
    const runner = fakeRunner(
      {
        'c2-chat/repro/always.spec.ts': ['failed', 'timedOut', 'failed'],
        'c2-chat/repro/twice.spec.ts': ['passed', 'failed', 'failed', 'skipped'],
        'c2-chat/repro/once.spec.ts': ['failed', 'interrupted', 'passed'],
        'c2-chat/repro/never.spec.ts': ['passed', 'passed', 'passed'],
      },
      calls,
    )

    const result = await replay(outDir, runner, qaDir)

    expect(calls[0]).toHaveLength(5)
    expect(titles(result.confirmed)).toEqual(['always-again', 'always'])
    expect(result.confirmed[0].replay).toEqual(result.confirmed[1].replay)
    expect(result.confirmed[1]).toMatchObject({
      replay: { failed: 3, runs: 3 },
      artifacts: {
        video: 'qa-out/replay/c2-chat/repro/always.spec.ts-0/video.webm',
        trace: 'qa-out/replay/c2-chat/repro/always.spec.ts-0/trace.zip',
      },
    })
    expect(titles(result.flaky)).toEqual(['once', 'twice'])
    // The first failed run's error, without ANSI colours and capped.
    expect(result.confirmed[1].replay.error).toStartWith(
      'Test timeout of 60000ms exceeded.\nError: run 0 of c2-chat/repro/always.spec.ts\ncall log\n',
    )
    expect(result.confirmed[1].replay.error).toHaveLength(1_500)
    expect(result.flaky.map(({ replay: { failed, runs } }) => [failed, runs])).toEqual([
      [1, 3],
      [2, 3],
    ])
    expect(result.flaky[1].artifacts.video).toBe('qa-out/replay/c2-chat/repro/twice.spec.ts-1/video.webm')
    expect(droppedAt(result, 'replay')).toEqual([
      {
        file: expect.objectContaining({ id: 'never', replay: { failed: 0, runs: 3 }, artifacts: {} }),
        gate: 'replay',
        reason: 'failed 0/3 replays',
      },
    ])
  })

  test('a spec missing from the report is dropped, and nothing replayable means no Playwright run', async () => {
    await writeFinding(makeFinding('lost', pageError))
    const calls: string[][] = []
    const result = await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(droppedAt(result, 'replay')[0].reason).toBe('failed 0/0 replays')

    await rm(join(outDir, 'c2-chat'), { recursive: true })
    await writeFinding(makeFinding('no-oracle', { type: 'looks-off', evidence: 'odd' }))
    await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(calls).toHaveLength(1)
  })

  test('a failed control run aborts the replay: nothing is confirmed and the output says why', async () => {
    for (const title of ['always', 'twice']) await writeFinding(makeFinding(title, pageError))
    const runner = fakeRunner(
      { 'c2-chat/repro/always.spec.ts': ['failed', 'failed', 'failed'], 'c2-chat/repro/twice.spec.ts': ['failed'] },
      [],
      ['passed', 'timedOut', 'passed'],
    )

    const result = await replay(outDir, runner, qaDir)

    expect(result.stack_unhealthy).toStartWith(
      'control spec failed 1/3 runs: Test timeout of 60000ms exceeded.\nError: run 1 of ',
    )
    expect(result.confirmed).toEqual([])
    expect(result.flaky).toEqual([])
    expect(result.dropped.map((entry) => [entry.file.id, entry.gate, entry.reason])).toEqual([
      ['always', 'replay', 'stack unhealthy'],
      ['twice', 'replay', 'stack unhealthy'],
    ])
    const written: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
    expect(written.stack_unhealthy).toBe(result.stack_unhealthy)
  })

  test('a control spec missing from the report counts as an unhealthy stack', async () => {
    await writeFinding(makeFinding('always', pageError))
    const result = await replay(outDir, fakeRunner({ 'c2-chat/repro/always.spec.ts': ['failed'] }, [], []), qaDir)
    expect(result.stack_unhealthy).toBe('control spec failed 0/0 runs: it did not run')
    expect(result.confirmed).toEqual([])
  })

  test('a spec that fails to load is dropped at lint, and the rest replay again with the control', async () => {
    for (const title of ['good', 'broken']) await writeFinding(makeFinding(title, pageError))
    const good = join(outDir, 'c2-chat/repro/good.spec.ts')
    const broken = join(outDir, 'c2-chat/repro/broken.spec.ts')
    const linkError = {
      message:
        "SyntaxError: The requested module '../../../e2e/helpers' does not provide an export named 'loginX'\n  at x",
    }
    const calls: string[][] = []
    const listed: string[][] = []
    const replays = fakeRunner({ 'c2-chat/repro/good.spec.ts': ['failed', 'failed', 'failed'] }, calls)
    // Like Playwright: one file that fails to load stops the whole run, and the error names no file.
    const runner: RunReplay = async (specs, dir, opts) => {
      if (opts?.list) listed.push(specs)
      if (specs.includes(broken)) return { config: { rootDir: outDir }, suites: [], errors: [linkError] }
      if (opts?.list) return { config: { rootDir: outDir }, suites: [], errors: [] }
      return replays(specs, dir)
    }

    const result = await replay(outDir, runner, qaDir)

    expect(listed).toEqual([[broken], [good]])
    expect(calls).toEqual([[controlSpec(), good]])
    expect(result.stack_unhealthy).toBeUndefined()
    expect(titles(result.confirmed)).toEqual(['good'])
    expect(droppedAt(result, 'lint')).toEqual([
      {
        file: expect.objectContaining({ id: 'broken' }),
        gate: 'lint',
        reason: `failed to load: ${linkError.message.split('\n')[0]}`,
      },
    ])
  })

  test('a load error that no repro spec explains marks the stack unhealthy with that error', async () => {
    await writeFinding(makeFinding('always', pageError))
    const listed: string[][] = []
    const runner: RunReplay = async (specs, _dir, opts) => {
      if (opts?.list) listed.push(specs)
      return {
        config: { rootDir: outDir },
        suites: [],
        errors: opts?.list ? [] : [{ message: 'Error: helpers broke' }],
      }
    }
    const result = await replay(outDir, runner, qaDir)
    expect(listed).toHaveLength(1)
    expect(result.stack_unhealthy).toBe('control spec failed 0/0 runs: Error: helpers broke')
    expect(droppedAt(result, 'replay').map((entry) => entry.reason)).toEqual(['stack unhealthy'])
  })

  test('Playwright gets only the allowlisted variables, never the caller environment', () => {
    expect(Object.keys(replayEnv('qa-out')).sort()).toEqual([
      'CI',
      'HOME',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'QA_BASE_URL',
      'QA_OUT',
    ])
  })

  test('the control spec passes the repro spec lint', async () => {
    const source = await Bun.file(join(import.meta.dir, '../../qa/control/repro/stack.spec.ts')).text()
    expect(lintReproSpec(source)).toEqual([])
  })

  test('writes candidates.json with the verified.json shape', async () => {
    await writeFinding(makeFinding('always', pageError))
    const result = await replay(outDir, fakeRunner({ 'c2-chat/repro/always.spec.ts': ['failed'] }, []), qaDir)
    const written: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
    expect(written).toEqual(result)
    expect(Object.keys(written).sort()).toEqual(['confirmed', 'dropped', 'flaky', 'observations'])
    expect(Object.keys(written.confirmed[0]).sort()).toEqual(['artifacts', 'charterDir', 'finding', 'id', 'replay'])
  })
})

describe('judge', () => {
  const candidate = (title: string) => ({
    charterDir: 'c2-chat',
    id: title,
    finding: makeFinding(title, pageError),
    replay: { failed: 3, runs: 3, error: `Error: expect(locator).toBeVisible() failed for ${title}` },
    artifacts: { video: `qa-out/replay/${title}/video.webm` },
  })

  /** Answers each call with the reply keyed by the finding title found in its prompt. */
  const fakeCreate =
    (replies: Record<string, string>, calls: Anthropic.MessageCreateParamsNonStreaming[]): CreateMessage =>
    async (params) => {
      calls.push(params)
      const prompt = String(params.messages[0].content)
      const reply = Object.entries(replies).find(([title]) => prompt.includes(`"title": "${title}"`))?.[1] ?? ''
      return {
        content: [{ type: 'text', text: reply, citations: null }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 250 },
      }
    }

  const writeCandidates = async (candidates: Verified) => {
    await Bun.write(join(outDir, 'candidates.json'), JSON.stringify(candidates))
    for (const file of [...candidates.confirmed, ...candidates.flaky]) {
      await Bun.write(join(outDir, file.charterDir, file.finding.repro_spec), validSpec(file.finding.title))
    }
  }

  test('keeps what the judge keeps and drops the rest, defaulting to drop on a malformed reply', async () => {
    const observation = { charterDir: 'c2-chat', id: 'obs', finding: makeFinding('obs', pageError) }
    const earlierDrop = { file: observation, gate: 'lint' as const, reason: 'bad spec' }
    await writeCandidates({
      confirmed: [candidate('real'), candidate('intended'), candidate('garbled'), candidate('wrong-shape')],
      flaky: [candidate('flaky')],
      observations: [observation],
      dropped: [earlierDrop],
    })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
    const create = fakeCreate(
      {
        real: '{"keep":true,"reason":"The send button throws on every click."}',
        intended: '{"keep":false,"reason":"Documented behaviour."}',
        garbled: 'Sure! {"keep": true',
        'wrong-shape': '{"keep":"yes","reason":"looks real"}',
      },
      calls,
    )

    const result = await judge(outDir, create, qaDir)

    expect(calls).toHaveLength(4)
    expect(result.confirmed).toEqual([
      { ...candidate('real'), judge: { keep: true, reason: 'The send button throws on every click.' } },
    ])
    expect(result.flaky).toEqual([candidate('flaky')])
    expect(result.observations).toEqual([observation])
    expect(result.dropped.map((entry) => [entry.file.id, entry.gate, entry.reason])).toEqual([
      ['obs', 'lint', 'bad spec'],
      ['intended', 'judge', 'Documented behaviour.'],
      ['garbled', 'judge', 'malformed judge reply (stop_reason: end_turn)'],
      ['wrong-shape', 'judge', 'malformed judge reply (stop_reason: end_turn)'],
    ])
    expect(result.judge_usage).toEqual({ input_tokens: 4000, output_tokens: 1000, cost_usd: 0.036 })
    expect(await Bun.file(join(outDir, 'verified.json')).json()).toEqual(result)
  })

  test('sends one bounded, structured call per candidate with only the finding, its spec and the known issues', async () => {
    await writeCandidates({ confirmed: [candidate('real')], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    await judge(outDir, fakeCreate({ real: '{"keep":true,"reason":"ok"}' }, calls), qaDir)

    const [params] = calls
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.max_tokens).toBeLessThanOrEqual(8192)
    expect(params.system).toBe('JUDGE PROMPT\n\nKNOWN ISSUES')
    expect(params.output_config?.format?.type).toBe('json_schema')
    expect(params.output_config?.format?.schema).toMatchObject({ required: ['keep', 'reason'] })
    expect(params.messages).toHaveLength(1)
    const prompt = String(params.messages[0].content)
    expect(prompt).toContain('TypeError: messages is undefined')
    expect(prompt).toContain(validSpec('real'))
    expect(prompt).toContain(
      '<replay_failure>\nError: expect(locator).toBeVisible() failed for real\n</replay_failure>',
    )
    expect(prompt).not.toContain('qa-out/replay')
  })

  test('a refusal or a truncated reply is dropped, and no candidates means no calls', async () => {
    await writeCandidates({ confirmed: [candidate('refused')], flaky: [], observations: [], dropped: [] })
    const refuse: CreateMessage = async () => ({
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const result = await judge(outDir, refuse, qaDir)
    expect(result.dropped[0].reason).toBe('malformed judge reply (stop_reason: refusal)')

    await writeCandidates({ confirmed: [], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
    const empty = await judge(outDir, fakeCreate({}, calls), qaDir)
    expect(calls).toHaveLength(0)
    expect(empty.judge_usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 })
  })
})
