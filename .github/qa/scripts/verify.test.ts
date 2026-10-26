/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { lintReproSpec, type RawFinding } from './findings'
import type { TranscriptMessage } from './report'
import { checkMaestroFlow } from './maestro-flow'
import {
  judge,
  legStartOf,
  nativeReplayCap,
  oracleOf,
  replay,
  replayEnv,
  screenshotTaken,
  verifyNativeFix,
  worstJudgeCost,
  type CreateMessage,
  type FlowRun,
  type ReplayReport,
  type RunFlow,
  type RunReplay,
  type Verified,
  type VerifiedFinding,
} from './verify'

const validSpec = (title: string) => `import { expect, test } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('${title}', async ({ page }) => {
  await loginViaEmailCode(page)
  await test.step('bug check', async () => {
    await expect(page.getByText('${title}')).toBeVisible()
  })
})
`

const makeFinding = (title: string, oracle: RawFinding['oracle']): RawFinding & { repro_spec: string } => ({
  title,
  area: 'chat',
  charter: 'c2-chat-desktop',
  viewport: 'desktop',
  oracle,
  steps: ['Open the chat', 'Send a message'],
  expected: 'The reply appears',
  actual: 'Nothing happens',
  repro_spec: `repro/${title}.spec.ts`,
})

const pageError = { type: 'page-error', evidence: 'TypeError: messages is undefined' }

const shotFile = 'page-2026-10-19T16-08-14-750Z.png'

/** A visual finding: a screenshot under the session's `mcp/` instead of a repro spec. */
const makeVisual = (title: string, screenshot = `mcp/${shotFile}`): RawFinding => ({
  ...makeFinding(title, { type: 'visual', evidence: 'The send button sits under the composer toolbar' }),
  area: 'layout',
  element: 'button "Send"',
  function: 'chat-send',
  screenshot,
  repro_spec: undefined,
})

/**
 * What Playwright MCP 0.0.83 returns for `browser_take_screenshot` without a filename, run with
 * `--file-paths absolute`; transcript.json keeps the text block only, not the image.
 */
const screenshotResult = (dir: string, file = shotFile) =>
  `### Result\n- [Screenshot of viewport](${dir}/${file})\n### Ran Playwright code\n\`\`\`js\n` +
  `// Screenshot viewport and save it as ${dir}/${file}\nawait page.screenshot({\n  path: '${dir}/${file}',\n` +
  `  scale: 'css',\n  type: 'png'\n});\n\`\`\`\n### Events\n` +
  `- New console entries: ${dir}/console-2026-10-19T16-08-14-157Z.log#L2`
const sessionDir = '/home/runner/work/thunderbolt/thunderbolt/qa-out/c2-chat-desktop'

const callsOf = (steps: (readonly [string, string])[]): TranscriptMessage[] =>
  steps.flatMap(([name, result], i) => [
    { message: { content: [{ type: 'tool_use' as const, id: `t${i}`, name }] } },
    { message: { content: [{ type: 'tool_result' as const, tool_use_id: `t${i}`, content: result }] } },
  ])

/** The start of a PNG of that size: its signature and IHDR chunk, all the screenshot checks read. */
const pngOf = (width: number, height: number) => {
  const ihdr = Buffer.alloc(8)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), ihdr])
}

/**
 * The start of a JPEG of that size: SOI, an APP0 and a DHT segment to skip (DHT's marker, C4, sits among the
 * frame-header markers), then the SOF0 frame header.
 */
const jpegOf = (width: number, height: number) => {
  const sof = Buffer.from('ffc0001108000000000301', 'hex')
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  const app0 = 'ffe000104a46494600010100000100010000'
  const dht = 'ffc4000900000000000000'
  return Buffer.concat([Buffer.from(`ffd8${app0}${dht}`, 'hex'), sof])
}

const pngBytes = pngOf(1280, 800)

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

/** Writes `c2-chat-desktop/findings/<title>.json` and, unless `spec` is null, its repro spec. */
const writeFinding = async (finding: RawFinding, spec: string | null = validSpec(finding.title)) => {
  await Bun.write(join(outDir, 'c2-chat-desktop/findings', `${finding.title}.json`), JSON.stringify(finding))
  if (spec !== null && finding.repro_spec) await Bun.write(join(outDir, 'c2-chat-desktop', finding.repro_spec), spec)
}

/** Writes c2-chat-desktop's transcript with the given tool calls, and the screenshot file `mcp/<shotFile>`. */
const writeSession = async (steps: (readonly [string, string])[]) => {
  await Bun.write(join(outDir, 'c2-chat-desktop/transcript.json'), JSON.stringify(callsOf(steps)))
  await Bun.write(join(outDir, 'c2-chat-desktop/mcp', shotFile), pngBytes)
}

const controlSpec = () => join(qaDir, 'control/stack.spec.ts')

/** The bug step of a run with that status: holding the error when the run failed or timed out. */
const bugStepOf = (status: string) =>
  status === 'failed' || status === 'timedOut'
    ? [{ title: 'bug check', duration: 12, error: { message: 'Error: expect(locator).toBeVisible() failed' } }]
    : [{ title: 'bug check', duration: 12 }]

/**
 * A runner that reports the given result statuses per spec file (relative to `outDir`), one Playwright spec entry
 * per run, plus the control spec's statuses. Every run carries a long, colored error message, and a failed one fails
 * inside its bug step.
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
                  steps: bugStepOf(status),
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
  test('a probe line filed as a console error is an observation, as a layout finding it replays', async () => {
    await Bun.write(join(qaDir, 'noise.txt'), await Bun.file(join(import.meta.dir, '../noise.txt')).text())
    const evidence = '[ERROR] [qa-layout] covered button "Continue" @ http://localhost:1424/layout-probe.js:209'
    await writeFinding(makeFinding('mislabeled', { type: 'console-error', evidence }))
    await writeFinding(makeFinding('layout', { type: 'layout', evidence }))
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(titles(result.observations)).toEqual(['mislabeled'])
    expect(calls[0]).toEqual([controlSpec(), join(outDir, 'c2-chat-desktop/repro/layout.spec.ts')])
  })

  test('only findings with an oracle, outside the noise list and with a clean spec reach Playwright', async () => {
    await Bun.write(join(outDir, 'c2-chat-desktop/findings/broken.json'), '{ not json')
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
      [
        controlSpec(),
        join(outDir, 'c2-chat-desktop/repro/console.spec.ts'),
        join(outDir, 'c2-chat-desktop/repro/page-noise.spec.ts'),
      ],
    ])
    expect(titles(result.observations)).toEqual(['blank-evidence', 'no-oracle', 'noise'])
    expect(droppedAt(result, 'schema')).toEqual([
      {
        file: expect.objectContaining({ charterDir: 'c2-chat-desktop', id: 'broken' }),
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
        'c2-chat-desktop/repro/always.spec.ts': ['failed', 'timedOut', 'failed'],
        'c2-chat-desktop/repro/twice.spec.ts': ['passed', 'failed', 'failed', 'skipped'],
        'c2-chat-desktop/repro/once.spec.ts': ['failed', 'interrupted', 'passed'],
        'c2-chat-desktop/repro/never.spec.ts': ['passed', 'passed', 'passed'],
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
        video: 'qa-out/replay/c2-chat-desktop/repro/always.spec.ts-0/video.webm',
        trace: 'qa-out/replay/c2-chat-desktop/repro/always.spec.ts-0/trace.zip',
      },
    })
    expect(titles(result.flaky)).toEqual(['once', 'twice'])
    // The first failed run's error, without ANSI colors and capped.
    expect(result.confirmed[1].replay.error).toStartWith(
      'Test timeout of 60000ms exceeded.\nError: run 0 of c2-chat-desktop/repro/always.spec.ts\ncall log\n',
    )
    expect(result.confirmed[1].replay.error).toHaveLength(1_500)
    expect(result.flaky.map(({ replay: { failed, runs } }) => [failed, runs])).toEqual([
      [1, 3],
      [2, 3],
    ])
    expect(result.flaky[1].artifacts.video).toBe('qa-out/replay/c2-chat-desktop/repro/twice.spec.ts-1/video.webm')
    expect(droppedAt(result, 'replay')).toEqual([
      {
        file: expect.objectContaining({ id: 'never', replay: { failed: 0, runs: 3 }, artifacts: {} }),
        gate: 'replay',
        reason: 'failed 0/3 replays',
      },
    ])
  })

  test('a real-AI charter confirms at 2/3 failures and is flaky at 1/3, while other charters still need 3/3', async () => {
    const real = 'c5-widgets-connections-desktop'
    for (const title of ['twice', 'once', 'never', 'always']) {
      const finding = { ...makeFinding(title, pageError), charter: real }
      await Bun.write(join(outDir, real, 'findings', `${title}.json`), JSON.stringify(finding))
      await Bun.write(join(outDir, real, finding.repro_spec), validSpec(title))
    }
    await writeFinding(makeFinding('fake-twice', pageError))
    const runner = fakeRunner(
      {
        [`${real}/repro/twice.spec.ts`]: ['failed', 'passed', 'timedOut'],
        [`${real}/repro/once.spec.ts`]: ['passed', 'failed', 'passed'],
        [`${real}/repro/never.spec.ts`]: ['passed', 'passed', 'passed'],
        [`${real}/repro/always.spec.ts`]: ['failed', 'failed', 'failed'],
        'c2-chat-desktop/repro/fake-twice.spec.ts': ['failed', 'passed', 'failed'],
      },
      [],
    )

    const result = await replay(outDir, runner, qaDir)

    expect(titles(result.confirmed)).toEqual(['always', 'twice'])
    expect(titles(result.flaky)).toEqual(['fake-twice', 'once'])
    expect(droppedAt(result, 'replay').map((entry) => entry.file.id)).toEqual(['never'])
  })

  test('replays at most 20 findings and defers the rest, in path order', async () => {
    const ids = Array.from({ length: 21 }, (_, n) => `f${String(n).padStart(2, '0')}`)
    for (const id of ids) await writeFinding(makeFinding(id, pageError))
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls[0]).toHaveLength(21) // the control spec and 20 findings
    expect(calls[0]).not.toContain(join(outDir, 'c2-chat-desktop/repro/f20.spec.ts'))
    expect(result.deferred).toEqual([
      { file: expect.objectContaining({ id: 'f20' }), step: 'replay', reason: 'over the cap of 20 replayed findings' },
    ])
    expect(result.dropped.map((entry) => entry.file.id)).not.toContain('f20')
  })

  test('a spec missing from the report is dropped, and nothing replayable means no Playwright run', async () => {
    await writeFinding(makeFinding('lost', pageError))
    const calls: string[][] = []
    const result = await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(droppedAt(result, 'replay')[0].reason).toBe('failed 0/0 replays')

    await rm(join(outDir, 'c2-chat-desktop'), { recursive: true })
    await writeFinding(makeFinding('no-oracle', { type: 'looks-off', evidence: 'odd' }))
    await replay(outDir, fakeRunner({}, calls), qaDir)
    expect(calls).toHaveLength(1)
  })

  test('a failed control run aborts the replay: nothing is confirmed and the output says why', async () => {
    for (const title of ['always', 'twice']) await writeFinding(makeFinding(title, pageError))
    const runner = fakeRunner(
      {
        'c2-chat-desktop/repro/always.spec.ts': ['failed', 'failed', 'failed'],
        'c2-chat-desktop/repro/twice.spec.ts': ['failed'],
      },
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
    const result = await replay(
      outDir,
      fakeRunner({ 'c2-chat-desktop/repro/always.spec.ts': ['failed'] }, [], []),
      qaDir,
    )
    expect(result.stack_unhealthy).toBe('control spec failed 0/0 runs: it did not run')
    expect(result.confirmed).toEqual([])
  })

  type ReplayResult = ReplayReport['suites'][number]['specs'][number]['tests'][number]['results'][number]
  const expectFailed = 'Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe'
  /**
   * Results as Playwright 1.60's JSON reporter wrote them, cut to what replay reads. The reporter leaves `steps` out
   * when the run entered none.
   */
  const playwrightResults = {
    // The local validation's c1 spec: a 429 on the code request, so the sign-in waited for the code input forever.
    signInTimeout: {
      status: 'timedOut',
      errors: [
        { message: '\u001b[31mTest timeout of 120000ms exceeded.\u001b[39m' },
        {
          message:
            'Error: locator.fill: Test timeout of 120000ms exceeded.\nCall log:\n' +
            `\u001b[2m  - waiting for locator('input[autocomplete="one-time-code"]')\u001b[22m\n`,
        },
      ],
      attachments: [],
    },
    failedInOtherStep: {
      status: 'failed',
      steps: [{ title: 'sign in', duration: 3, error: { message: expectFailed } }],
      errors: [{ message: expectFailed }],
      attachments: [],
    },
    failedInStep: {
      status: 'failed',
      steps: [
        { title: 'sign in', duration: 0 },
        { title: 'bug check', duration: 2, error: { message: expectFailed } },
      ],
      errors: [{ message: expectFailed }],
      attachments: [],
    },
    // A test timeout while the step still ran: no error on the step, and a duration of -1.
    timedOutInStep: {
      status: 'timedOut',
      steps: [{ title: 'bug check', duration: -1 }],
      errors: [{ message: '\u001b[31mTest timeout of 1000ms exceeded.\u001b[39m' }],
      attachments: [],
    },
    timedOutAfterStep: {
      status: 'timedOut',
      steps: [{ title: 'bug check', duration: 0 }],
      errors: [{ message: '\u001b[31mTest timeout of 1000ms exceeded.\u001b[39m' }],
      attachments: [],
    },
    passed: { status: 'passed', steps: [{ title: 'bug check', duration: 0 }], errors: [], attachments: [] },
    // The bug check inside another step: the error shows on both.
    failedInNestedStep: {
      status: 'failed',
      steps: [
        {
          title: 'welcome dialog',
          duration: 4,
          error: { message: expectFailed },
          steps: [{ title: 'bug check', duration: 2, error: { message: expectFailed } }],
        },
      ],
      errors: [{ message: expectFailed }],
      attachments: [],
    },
  } satisfies Record<string, ReplayResult>

  /** A runner reporting the given results per spec file (relative to `outDir`), one spec entry per result. */
  const resultsRunner =
    (results: Record<string, ReplayResult[]>): RunReplay =>
    async () => ({
      config: { rootDir: outDir },
      errors: [],
      suites: Object.entries(results).map(([file, runs]) => ({
        specs: runs.map((result) => ({ file, tests: [{ results: [result] }] })),
      })),
    })

  test('a run confirms the bug only when it failed inside the bug check step; one failing before it is unreached', async () => {
    for (const title of ['inside', 'nested', 'timeout', 'sign-in', 'mixed', 'after', 'fixed']) {
      await writeFinding(makeFinding(title, pageError))
    }
    const { signInTimeout, failedInOtherStep, failedInStep, failedInNestedStep, timedOutInStep, timedOutAfterStep } =
      playwrightResults
    const { passed } = playwrightResults
    const spec = (title: string) => `c2-chat-desktop/repro/${title}.spec.ts`

    const result = await replay(
      outDir,
      resultsRunner({
        [spec('inside')]: [failedInStep, failedInStep, failedInStep],
        [spec('nested')]: [failedInNestedStep, failedInNestedStep, failedInNestedStep],
        [spec('timeout')]: [timedOutInStep, failedInStep, timedOutInStep],
        [spec('sign-in')]: [signInTimeout, signInTimeout, signInTimeout],
        [spec('mixed')]: [failedInStep, failedInOtherStep, failedInStep],
        [spec('after')]: [failedInStep, timedOutAfterStep, failedInStep],
        [spec('fixed')]: [passed, passed, passed],
        [relative(outDir, controlSpec())]: [passed, passed, passed],
      }),
      qaDir,
    )

    expect(titles(result.confirmed)).toEqual(['inside', 'nested', 'timeout'])
    const counts = ({ id, replay: { failed, runs, inconclusive, reason } }: VerifiedFinding) => [
      id,
      failed,
      runs,
      inconclusive,
      reason,
    ]
    expect(result.flaky.map(counts)).toEqual([
      ['after', 2, 2, 1, '1 of 3 runs failed before the bug check step'],
      ['mixed', 2, 2, 1, '1 of 3 runs failed before the bug check step'],
      ['sign-in', 0, 0, 3, '3 of 3 runs failed before the bug check step'],
    ])
    expect(result.flaky.at(-1)?.replay.error).toContain('waiting for locator(\'input[autocomplete="one-time-code"]\')')
    expect(droppedAt(result, 'replay').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['fixed', 'failed 0/3 replays'],
    ])
  })

  test('a real-AI finding still confirms on 2 failures in the bug check step beside 1 run that never reached it', async () => {
    const real = 'c5-widgets-connections-desktop'
    for (const title of ['twice', 'once']) {
      const finding = { ...makeFinding(title, pageError), charter: real }
      await Bun.write(join(outDir, real, 'findings', `${title}.json`), JSON.stringify(finding))
      await Bun.write(join(outDir, real, finding.repro_spec), validSpec(title))
    }
    const { signInTimeout, failedInStep, passed } = playwrightResults

    const result = await replay(
      outDir,
      resultsRunner({
        [`${real}/repro/twice.spec.ts`]: [failedInStep, signInTimeout, failedInStep],
        [`${real}/repro/once.spec.ts`]: [failedInStep, signInTimeout, passed],
        [relative(outDir, controlSpec())]: [passed, passed, passed],
      }),
      qaDir,
    )

    expect(result.confirmed.map(({ id, replay }) => [id, replay.failed, replay.runs, replay.reason])).toEqual([
      ['twice', 2, 2, undefined],
    ])
    expect(result.flaky.map(({ id, replay }) => [id, replay.reason])).toEqual([
      ['once', '1 of 3 runs failed before the bug check step'],
    ])
  })

  test('the control spec has no bug check step, so any failed run of it marks the stack unhealthy', async () => {
    await writeFinding(makeFinding('inside', pageError))
    const { signInTimeout, failedInStep, passed } = playwrightResults

    const result = await replay(
      outDir,
      resultsRunner({
        'c2-chat-desktop/repro/inside.spec.ts': [failedInStep, failedInStep, failedInStep],
        [relative(outDir, controlSpec())]: [passed, signInTimeout, passed],
      }),
      qaDir,
    )

    expect(result.stack_unhealthy).toStartWith('control spec failed 1/3 runs: Test timeout of 120000ms exceeded.')
    expect(result.confirmed).toEqual([])
  })

  test('a spec without the bug check step is dropped at lint and never replays', async () => {
    const loose = `import { expect, test } from '@playwright/test'

test('loose', async ({ page }) => {
  // bug check
  await expect(page.getByText('loose')).toBeVisible()
})
`
    await writeFinding(makeFinding('loose', pageError), loose)
    const renamed = validSpec('renamed').replace("'bug check'", "'check the bug'")
    await writeFinding(makeFinding('renamed', pageError), renamed)
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls).toEqual([])
    const reason = "no test.step('bug check', …) holds the assertion"
    expect(droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['loose', reason],
      ['renamed', reason],
    ])
  })

  test('a spec that fails to load is dropped at lint, and the rest replay again with the control', async () => {
    for (const title of ['good', 'broken']) await writeFinding(makeFinding(title, pageError))
    const good = join(outDir, 'c2-chat-desktop/repro/good.spec.ts')
    const broken = join(outDir, 'c2-chat-desktop/repro/broken.spec.ts')
    const linkError = {
      message:
        "SyntaxError: The requested module '../../../e2e/helpers' does not provide an export named 'loginX'\n  at x",
    }
    const calls: string[][] = []
    const listed: string[][] = []
    const replays = fakeRunner({ 'c2-chat-desktop/repro/good.spec.ts': ['failed', 'failed', 'failed'] }, calls)
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

  test('replay confirms a visual finding whose screenshot the browser tool took, without Playwright', async () => {
    await writeFinding(makeVisual('shot'), null)
    await writeSession([['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`)]])
    const calls: string[][] = []

    const result = await replay(outDir, fakeRunner({}, calls), qaDir)

    expect(calls).toEqual([])
    expect(result.confirmed).toEqual([
      {
        charterDir: 'c2-chat-desktop',
        id: 'shot',
        finding: makeVisual('shot'),
        replay: { failed: 0, runs: 0 },
        artifacts: { screenshot: relative(process.cwd(), join(outDir, 'c2-chat-desktop/mcp', shotFile)) },
      },
    ])
  })

  test('a visual finding does not take a place under the replay cap', async () => {
    for (let n = 0; n < 20; n++) await writeFinding(makeFinding(`f${String(n).padStart(2, '0')}`, pageError))
    await writeFinding(makeVisual('shot'), null)
    await writeSession([['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`)]])

    const result = await replay(outDir, fakeRunner({}, []), qaDir)

    expect(result.deferred).toEqual([])
    expect(titles(result.confirmed)).toEqual(['shot'])
  })

  test('replay drops a visual finding whose screenshot the session never took, or that is missing', async () => {
    await writeFinding(makeVisual('untaken'), null)
    await writeFinding(makeVisual('lost', 'mcp/page-lost.png'), null)
    await writeSession([
      // The explorer typed the file name into the page and read it back: not a screenshot.
      ['mcp__playwright__browser_evaluate', `### Result\n"${sessionDir}/mcp/${shotFile}"`],
      ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, 'page-lost.png')],
    ])

    const result = await replay(outDir, fakeRunner({}, []), qaDir)

    expect(result.confirmed).toEqual([])
    expect(droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['lost', 'screenshot not found'],
      ['untaken', 'screenshot not taken by the browser tool in this session'],
    ])
  })

  /** A Write or Edit call on `file_path`, as transcript.jq keeps it, and its result. */
  const fileTool = (name: string, id: string, file_path: string): TranscriptMessage[] => [
    { message: { content: [{ type: 'tool_use', id, name, input: { file_path } }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]

  /** Writes each screenshot under c2-chat-desktop/mcp/, a visual finding named after it, and a transcript taking them all. */
  const writeShots = async (shots: Record<string, Buffer>, extra: TranscriptMessage[] = []) => {
    const steps = Object.keys(shots).map(
      (name) => ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, name)] as const,
    )
    await Bun.write(join(outDir, 'c2-chat-desktop/transcript.json'), JSON.stringify([...callsOf(steps), ...extra]))
    for (const [name, bytes] of Object.entries(shots)) {
      await Bun.write(join(outDir, 'c2-chat-desktop/mcp', name), bytes)
      await writeFinding(makeVisual(name.replace(/\.\w+$/, ''), `mcp/${name}`), null)
    }
  }

  const replayDrops = async () => {
    const result = await replay(outDir, fakeRunner({}, []), qaDir)
    return {
      confirmed: titles(result.confirmed),
      dropped: droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason]),
    }
  }

  test('replay drops a visual finding whose screenshot a file tool wrote after the browser', async () => {
    await writeShots({ 'written.png': pngBytes, 'edited.png': pngBytes, 'kept.png': pngBytes }, [
      ...fileTool('Write', 'w0', `${sessionDir}/mcp/written.png`),
      ...fileTool('Edit', 'w1', `${sessionDir}/mcp/edited.png`),
      ...fileTool('Write', 'w2', `${sessionDir}/findings/kept.json`),
    ])

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [
        ['edited', 'screenshot written by a file tool, not the browser'],
        ['written', 'screenshot written by a file tool, not the browser'],
      ],
    })
  })

  test('replay drops a visual finding whose screenshot is not a PNG or a JPEG', async () => {
    await writeShots({ 'text.png': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'kept.png': pngBytes })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [['text', 'screenshot is not a PNG or JPEG image']],
    })
  })

  test("replay drops a visual finding whose screenshot is over the API's 10 MB image limit", async () => {
    // 7.5 MB of bytes is 10 MB once base64-encoded, which is how the API measures it.
    await writeShots({ 'huge.png': Buffer.concat([pngBytes, Buffer.alloc(7_500_000)]), 'kept.png': pngBytes })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [['huge', "screenshot over the API's 10 MB image limit"]],
    })
  })

  test("replay drops a visual finding whose screenshot is over the API's 8000 px image limit", async () => {
    await writeShots({ 'tall.png': pngOf(1280, 8001), 'wide.jpeg': jpegOf(8001, 600), 'kept.jpeg': jpegOf(1280, 8000) })

    expect(await replayDrops()).toEqual({
      confirmed: ['kept'],
      dropped: [
        ['tall', "screenshot over the API's 8000 px image limit"],
        ['wide', "screenshot over the API's 8000 px image limit"],
      ],
    })
  })

  test('a screenshot counts only when a browser screenshot result of the same device names it', () => {
    const transcript = callsOf([
      ['mcp__playwright__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp`, 'page-a.png')],
      ['mcp__playwright_b__browser_take_screenshot', screenshotResult(`${sessionDir}/mcp-b`, 'page-b.png')],
      ['mcp__playwright__browser_evaluate', `${sessionDir}/mcp/page-c.png`],
    ])
    expect(screenshotTaken(transcript, 'mcp/page-a.png')).toBe(true)
    expect(screenshotTaken(transcript, 'mcp-b/page-b.png')).toBe(true)
    expect(screenshotTaken(transcript, 'mcp/page-b.png')).toBe(false)
    expect(screenshotTaken(transcript, 'mcp/page-c.png')).toBe(false)
  })

  test('Playwright gets only the allowlisted variables, never the caller environment', () => {
    const env = replayEnv('qa-out', { QA_FRONTEND_PORT: '2424', QA_ONBOARDING_PORT: '2425', ANTHROPIC_API_KEY: 'k' })
    expect(Object.keys(env).sort()).toEqual([
      'CI',
      'HOME',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_NO_COPY_PROMPT',
      'QA_FRONTEND_PORT',
      'QA_ONBOARDING_PORT',
      'QA_OUT',
    ])
    expect([env.QA_FRONTEND_PORT, env.QA_ONBOARDING_PORT]).toEqual(['2424', '2425'])
  })

  test('the control spec passes the repro spec lint', async () => {
    const source = await Bun.file(join(import.meta.dir, '../control/stack.spec.ts')).text()
    expect(lintReproSpec(source)).toEqual([])
  })

  test('a screenshot the Maestro gate saved counts like a browser one', () => {
    const transcript = callsOf([
      ['mcp__maestro__take_screenshot', `Saved to ${sessionDir}/maestro/shot-2.jpg`],
      ['mcp__maestro__run', `ok\n${sessionDir}/maestro/shot-3.jpg`],
    ])
    expect(screenshotTaken(transcript, 'maestro/shot-2.jpg')).toBe(true)
    expect(screenshotTaken(transcript, 'maestro/shot-3.jpg')).toBe(false)
  })

  test('writes candidates.json with the verified.json shape', async () => {
    await writeFinding(makeFinding('always', pageError))
    const result = await replay(outDir, fakeRunner({ 'c2-chat-desktop/repro/always.spec.ts': ['failed'] }, []), qaDir)
    const written: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
    expect(written).toEqual(result)
    expect(Object.keys(written).sort()).toEqual(['confirmed', 'deferred', 'dropped', 'flaky', 'observations'])
    expect(Object.keys(written.confirmed[0]).sort()).toEqual(['artifacts', 'charterDir', 'finding', 'id', 'replay'])
  })
})

describe('replay of native flows', () => {
  const session = 'c2-chat-power-user-ios'
  const nameLine = '[qa-layout] focused-clipped textbox "Enter your name"'
  const layout = { type: 'layout', evidence: nameLine }
  const assertFailed = { type: 'assert-failed', evidence: 'The sent message never shows' }

  /** An iOS finding proven by `repro/<title>.yaml`. */
  const makeNative = (title: string, oracle: RawFinding['oracle']): RawFinding => ({
    ...makeFinding(title, oracle),
    charter: 'c2-chat-power-user',
    viewport: 'ios',
    repro_spec: undefined,
    repro_flow: `repro/${title}.yaml`,
  })
  /**
   * A flow that asserts its own title, so the fake device can tell flows apart, and ends on the screen, as a layout
   * flow must.
   */
  const flowOf = (title: string) =>
    `- launchApp\n- inputText: \${EMAIL}\n- assertVisible: ${title}\n- waitForAnimationToEnd\n`

  /** Writes `<dir>/findings/<title>.json` and, unless `flow` is null, its repro flow. */
  const writeNative = async (finding: RawFinding, flow: string | null = flowOf(finding.title), dir = session) => {
    await Bun.write(join(outDir, dir, 'findings', `${finding.title}.json`), JSON.stringify(finding))
    if (flow !== null) await Bun.write(join(outDir, dir, 'repro', `${finding.title}.yaml`), flow)
  }

  beforeEach(() => Bun.write(join(qaDir, 'control/stack.yaml'), flowOf('stack control')))

  type FlowCall = { title: string; run: number; session: string }
  /** Answers each run with the next result queued for the flow whose title it asserts; with none left, it passes. */
  const fakeFlow =
    (results: Record<string, Partial<FlowRun>[]>, calls: FlowCall[]): RunFlow =>
    async (yaml, _outDir, run, session) => {
      const title = /assertVisible: "?([^"\n]+)/.exec(yaml)?.[1] ?? ''
      calls.push({ title, run, session })
      return { passed: true, layout: [], logs: [], ...results[title]?.shift() }
    }

  const nativeReplay = (results: Record<string, Partial<FlowRun>[]>, calls: FlowCall[] = []) =>
    replay(outDir, fakeRunner({}, []), qaDir, fakeFlow(results, calls))

  test('a layout run fails when the probe logs the quoted line: 3/3 confirmed, 1/3 flaky, anything else 0/3', async () => {
    for (const title of ['always', 'once', 'elsewhere']) await writeNative(makeNative(title, layout))
    await writeNative(makeNative('ready', { type: 'layout', evidence: '[qa-layout] ready' }))
    const video = 'qa-out/videos/run-4.mp4'
    const seen = { layout: ['[qa-layout] ready', nameLine], video }
    const unseen = { layout: ['[qa-layout] ready'] }
    const other = { layout: ['[qa-layout] focused-clipped textbox "Search locations"'] }

    const result = await nativeReplay({
      always: [seen, seen, seen],
      once: [unseen, seen, unseen],
      // A flow that fails before the screen is run again; the extra run shows nothing either.
      elsewhere: [other, { passed: false, error: 'Element not found: Continue' }, other],
      ready: [unseen, unseen, unseen],
    })

    expect(titles(result.confirmed)).toEqual(['always'])
    expect(result.confirmed[0]).toMatchObject({
      replay: { failed: 3, runs: 3, error: `the layout probe logged ${nameLine}` },
      artifacts: { video },
    })
    expect(result.flaky.map(({ id, replay: { failed, runs } }) => [id, failed, runs])).toEqual([['once', 1, 3]])
    expect(droppedAt(result, 'replay').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['elsewhere', 'failed 0/3 replays'],
      ['ready', 'failed 0/3 replays'],
    ])
  })

  test('a flow outside the allow list is dropped at lint and never reaches the device', async () => {
    await writeNative(makeNative('script', assertFailed), '- launchApp\n- runScript: steal.js\n')
    await writeNative(makeNative('variable', assertFailed), '- launchApp\n- inputText: ${HOME}\n')
    await writeNative(makeNative('missing', assertFailed), null)
    const calls: FlowCall[] = []

    const result = await nativeReplay({}, calls)

    expect(calls).toEqual([])
    const lint = droppedAt(result, 'lint')
    expect(lint.map((entry) => entry.file.id)).toEqual(['missing', 'script', 'variable'])
    expect(lint[0].reason).toBe('repro flow not found')
    expect(lint[1].reason).toContain('runScript')
    expect(lint[2].reason).toContain('(EMAIL)')
  })

  test('a layout flow that ends on an assertion is dropped at lint, so a failing one cannot buy reruns', async () => {
    // Such a flow fails every run without the line, and replay reruns each of those as inconclusive.
    await writeNative(makeNative('visible', layout), '- launchApp\n- assertVisible: Never shown\n')
    await writeNative(makeNative('hidden', layout), '- launchApp\n- assertNotVisible:\n    text: Continue\n')
    const screenWait = '- extendedWaitUntil:\n    visible: What should we call you?\n    timeout: 120000\n'
    await writeNative(makeNative('waits', layout), `- launchApp\n- assertVisible: waits\n${screenWait}`)
    // Only a layout flow must stop on the screen; any other repro asserts the expected behaviour.
    await writeNative(makeNative('asserts', assertFailed))
    const calls: FlowCall[] = []

    const result = await nativeReplay({}, calls)

    const reason = 'a layout flow ends on the screen, with no assertion'
    expect(droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['hidden', reason],
      ['visible', reason],
    ])
    expect(new Set(calls.map((call) => call.title))).toEqual(new Set(['stack control', 'asserts', 'waits']))
  })

  test('a failure-oracle flow must end on a plain assertion, so a block cannot pull its steps into the proof', async () => {
    // Replay splits at the last command: a block there would carry the whole way to the bug into the confirming part.
    const retry = '- launchApp\n- retry:\n    commands:\n      - tapOn: Search\n      - assertVisible: x\n'
    await writeNative(makeNative('retry', assertFailed), retry)
    const nested = '- launchApp\n- runFlow:\n    commands:\n      - assertVisible: x\n'
    await writeNative(makeNative('nested', assertFailed), nested)
    await writeNative(makeNative('tap', assertFailed), '- launchApp\n- tapOn: Continue\n')
    const wait = '- launchApp\n- extendedWaitUntil:\n    visible: Reply\n    timeout: 60000\n'
    await writeNative(makeNative('waits', assertFailed), wait)
    // A stuck oracle's symptom is the wait that never ends, and a trailing settle is skipped.
    await writeNative(makeNative('stuck', { type: 'stuck', evidence: 'The reply never comes' }), wait)
    await writeNative(makeNative('settled', assertFailed))

    const result = await nativeReplay({})

    const reason = 'the flow does not end on a plain assertVisible or assertNotVisible (a wait, for stuck)'
    expect(droppedAt(result, 'lint').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['nested', reason],
      ['retry', reason],
      ['tap', reason],
      ['waits', reason],
    ])
    expect(droppedAt(result, 'replay').map((entry) => entry.file.id)).toEqual(['settled', 'stuck'])
  })

  test('a control flow that fails once marks the stack unhealthy, and no finding runs or is confirmed', async () => {
    await writeNative(makeNative('always', assertFailed))
    const calls: FlowCall[] = []
    const failure = 'Assertion is false: "Ask anything" is visible'

    const result = await nativeReplay({ 'stack control': [{}, { passed: false, error: failure }, {}] }, calls)

    expect(result.stack_unhealthy).toBe(`control flow failed 1/3 runs: ${failure}`)
    expect(calls.map((call) => call.title)).toEqual(['stack control', 'stack control', 'stack control'])
    expect(result.confirmed).toEqual([])
    expect(result.dropped.map((entry) => [entry.file.id, entry.gate, entry.reason])).toEqual([
      ['always', 'replay', 'stack unhealthy'],
    ])
  })

  test('a log oracle fails a run when a new log line holds the evidence, whatever the run-specific noise', async () => {
    const line = (time: string, pid: string, hash: string, chat: string) =>
      `webview: 2026-10-19 ${time} Df Thunderbolt Dev[${pid}] [com.apple.WebKit:Generic] WebContent[49912] ` +
      `tauri://localhost/assets/entry-${hash}.js:824:330924: CONSOLE ERROR Failed to load chat ${chat}`
    const quoted = line('22:54:08.037', '49907:1b54a6', 'DR7YbkT0', '7d3f2a1b-0c4e-4f5a-9b6d-1e2f3a4b5c6d')
    const later = line('23:10:41.502', '51022:22c1', 'Xk2pQ9aZ', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
    await writeNative(makeNative('console', { type: 'console-error', evidence: quoted }))
    await writeNative(makeNative('quiet', { type: 'page-error', evidence: 'TypeError: messages is undefined' }))
    const server = 'backend: INFO: - - "POST /v1/chat HTTP/1.1" 500 Internal Server Error 12ms'
    await writeNative(makeNative('server', { type: 'http-5xx', evidence: server }))
    const raw =
      'backend: \u001b[32mINFO\u001b[39m: \u001b[36m- - "POST /v1/chat HTTP/1.1" 500 Internal Server Error 31ms'
    const logs = { logs: [later, raw] }

    const result = await nativeReplay({
      console: [logs, logs, logs],
      quiet: [logs, logs, logs],
      server: [logs, logs, logs],
    })

    expect(titles(result.confirmed)).toEqual(['console', 'server'])
    expect(result.confirmed[0].replay.error).toBe(`logged during the run: ${later}`)
    expect(droppedAt(result, 'replay').map((entry) => entry.file.id)).toEqual(['quiet'])
  })

  test('a layout run whose flow stopped before the line is inconclusive and run again, up to 3 extra runs', async () => {
    // Run 39380764343: of three iOS runs, two stopped on earlier screens and one reached the clipped name field.
    const early = { passed: false, error: 'Assertion is false: "What should we call you?" is visible' }
    const seen = { layout: ['[qa-layout] ready', nameLine] }
    const unseen = { layout: ['[qa-layout] ready'] }
    for (const title of ['run5', 'stuck', 'passing'])
      await writeNative(makeNative(title, layout), undefined, 'c1-first-run-ios')
    // An Android real-AI session confirms on 2 of 3 conclusive runs.
    const real = 'c3-models-providers-android'
    await writeNative({ ...makeNative('real', layout), viewport: 'android' }, undefined, real)
    // A run that fails after the probe logged the line still shows the bug.
    const seenThenFailed = { ...early, layout: [nameLine] }
    const calls: FlowCall[] = []

    const result = await nativeReplay(
      {
        run5: [early, seen, early, seen, seen],
        stuck: [early, early, seen, early, seen, early, seen],
        passing: [unseen, seen, seen],
        real: [early, seen, unseen, seenThenFailed],
      },
      calls,
    )

    const counts = ({ id, replay }: { id: string; replay: VerifiedFinding['replay'] }) => [
      id,
      replay.failed,
      replay.runs,
      replay.inconclusive ?? 0,
    ]
    expect(result.confirmed.map(counts)).toEqual([
      ['run5', 3, 3, 2],
      ['real', 2, 3, 1],
    ])
    // 3 extra runs and still only two conclusive: flaky, whatever those two showed. A passed run without the line
    // counts as not shown and is not run again.
    expect(result.flaky.map(counts)).toEqual([
      ['passing', 2, 3, 0],
      ['stuck', 2, 2, 4],
    ])
    expect(result.flaky.find(({ id }) => id === 'stuck')?.replay.reason).toBe('only 2 of 3 runs reached the screen')
    expect(calls.filter((call) => call.title === 'stuck')).toHaveLength(6)
    expect(calls.filter((call) => call.title === 'passing')).toHaveLength(3)
  })

  test('a native leg replays at most nativeReplayCap findings, so its worst case fits the job, and defers the rest', async () => {
    const ids = Array.from({ length: nativeReplayCap + 1 }, (_, n) => `f${n}`)
    for (const id of ids) await writeNative(makeNative(id, assertFailed))
    const calls: FlowCall[] = []

    const result = await nativeReplay({}, calls)

    expect(new Set(calls.map((call) => call.title))).toEqual(new Set(['stack control', ...ids.slice(0, -1)]))
    expect(result.deferred).toEqual([
      {
        file: expect.objectContaining({ id: ids.at(-1) }),
        step: 'replay',
        reason: `over the cap of ${nativeReplayCap} replayed findings`,
      },
    ])
  })

  test('replay lines are compared as the gate showed them, so cleaned evidence still matches', async () => {
    const android = 'c2-chat-power-user-android'
    const onAndroid = (finding: RawFinding) => ({ ...finding, viewport: 'android' })
    const line = (time: string, pid: string, hash: string) =>
      `webview: ${time}  ${pid}  ${pid} E Tauri/Console: File: http://tauri.localhost/assets/index-${hash}.js - ` +
      'Line 12 - Msg: Uncaught TypeError: chat.title is undefined'
    // What read_logs showed the explorer, as it quoted it.
    const quoted = 'webview: 1792454400.123  4321  4321 E Tauri/Console: File: [link removed] - Line 12 - Msg: Uncaught'
    const crash = { type: 'page-error', evidence: `${quoted} TypeError: chat.title is undefined` }
    await writeNative(onAndroid(makeNative('console', crash)), undefined, android)
    const link = '[qa-layout] overflow-text link "https://example.com/a/very/long/path/that/never/wraps"'
    const overflow = { type: 'layout', evidence: '[qa-layout] overflow-text link "[link removed]"' }
    await writeNative(onAndroid(makeNative('overflow', overflow)), undefined, android)
    const run = { logs: [line('1792454999.456', '5555', 'Ab12Cd34')], layout: ['[qa-layout] ready', link] }

    const result = await nativeReplay({ console: [run, run, run], overflow: [run, run, run] })

    expect(result.confirmed.map(({ id, replay }) => [id, replay.failed, replay.error])).toEqual([
      [
        'console',
        3,
        `logged during the run: ${line('1792454999.456', '5555', 'Ab12Cd34').replace(/http\S+/, '[link removed]')}`,
      ],
      ['overflow', 3, 'the layout probe logged [qa-layout] overflow-text link "[link removed]"'],
    ])
  })

  test('the session dir, not the finding, picks spec or flow: a forged field is dropped and the leg goes on', async () => {
    await writeNative(makeNative('chat', assertFailed))
    const forged = { ...makeNative('forged', assertFailed), repro_flow: undefined, repro_spec: 'repro/forged.spec.ts' }
    await writeNative({ ...forged, charter: 'c7-two-devices' })
    await writeNative({ ...forged, title: 'desktop', viewport: 'desktop' })
    const playwright: string[][] = []
    const failed = { passed: false, error: 'Assertion is false: "hello" is visible' }

    const result = await replay(
      outDir,
      fakeRunner({}, playwright),
      qaDir,
      fakeFlow({ chat: [failed, failed, failed] }, []),
    )

    expect(playwright).toEqual([])
    expect(titles(result.confirmed)).toEqual(['chat'])
    const specOnDevice =
      'a native session proves a finding with a repro_flow; only c7 on Android also takes a repro_spec'
    expect(droppedAt(result, 'schema').map((entry) => [entry.file.id, entry.reason])).toEqual([
      ['desktop', specOnDevice],
      ['forged', specOnDevice],
    ])
  })

  test("a finding's viewport comes from its session dir, so an iOS finding written as phone replays as ios", async () => {
    // Run 39373388149: both native sessions copied the template's "phone" into every finding.
    await writeNative({ ...makeNative('name', layout), viewport: 'phone' })
    const calls: FlowCall[] = []
    const run = { layout: ['[qa-layout] ready', nameLine] }

    const result = await nativeReplay({ name: [run, run, run] }, calls)

    expect(result.confirmed.map((file) => [file.id, file.finding.viewport, file.replay.failed])).toEqual([
      ['name', 'ios', 3],
    ])
    expect(calls.filter((call) => call.title === 'name')).toHaveLength(3)
  })

  test('each run starts from a clean app: its own run number, with the session that picks the build', async () => {
    await writeNative(makeNative('name', layout), undefined, 'c1-first-run-ios')
    await writeNative(makeNative('chat', assertFailed))
    const calls: FlowCall[] = []

    await nativeReplay({}, calls)

    expect(calls.map(({ title, run, session }) => `${run} ${title} ${session}`)).toEqual([
      '1 stack control control',
      '2 stack control control',
      '3 stack control control',
      '4 name c1-first-run-ios',
      '5 name c1-first-run-ios',
      '6 name c1-first-run-ios',
      '7 chat c2-chat-power-user-ios',
      '8 chat c2-chat-power-user-ios',
      '9 chat c2-chat-power-user-ios',
    ])
  })

  test('a driver that did not start is tried again and never counts as the bug', async () => {
    await writeNative(makeNative('always', assertFailed))
    await writeNative(makeNative('stalled', assertFailed))
    const driver = { passed: false, error: 'Unable to launch app: iOS driver not ready in time' }
    const failed = { passed: false, error: 'Assertion is false: "hello" is visible' }
    const calls: FlowCall[] = []

    const result = await nativeReplay(
      { always: [driver, failed, failed, failed], stalled: [driver, driver, failed, failed] },
      calls,
    )

    expect(calls.filter((call) => call.title === 'always')).toHaveLength(4)
    expect(result.confirmed.map(({ id, replay }) => [id, replay])).toEqual([
      ['always', { failed: 3, runs: 3, error: failed.error }],
    ])
    // Its second driver failure in a row is a run without the bug.
    expect(result.flaky.map(({ id, replay: { failed, runs } }) => [id, failed, runs])).toEqual([['stalled', 2, 3]])
  })

  test('a flow finding needs a device: replay without one refuses to run', async () => {
    await writeNative(makeNative('always', assertFailed))
    await expect(replay(outDir, fakeRunner({}, []), qaDir)).rejects.toThrow('--native')
  })

  const list = z.array(z.unknown())
  const commands = (yaml: string) => list.parse(Bun.YAML.parse(yaml.split('\n---\n')[1]))
  const asWritten = (source: string) => {
    const check = checkMaestroFlow(source, { appId: 'x', vars: ['EMAIL'] })
    if (!check.ok) throw new Error(check.problems.join('; '))
    return commands(check.yaml)
  }
  const readSignIn = async () =>
    list.parse(Bun.YAML.parse(await Bun.file(join(import.meta.dir, '../control/sign-in.yaml')).text()))
  const landing = (visible: string) => ({ extendedWaitUntil: { visible, timeout: 120000 } })

  test('the control flow and the harness steps pass the allow list, and the control is the sign-in', async () => {
    for (const file of ['stack.yaml', 'sign-in.yaml', 'consent.yaml']) {
      const source = await Bun.file(join(import.meta.dir, '../control', file)).text()
      for (const appId of ['net.thunderbird.thunderbolt.dev', 'net.thunderbird.thunderbolt']) {
        expect(checkMaestroFlow(source, { appId, vars: ['EMAIL'] })).toMatchObject({ ok: true })
      }
    }
    const stack = await Bun.file(join(import.meta.dir, '../control/stack.yaml')).text()
    expect(asWritten(stack)).toEqual([...(await readSignIn()), landing('Ask me anything…')])
  })

  test("the driver guide's sign-in block is the harness's, and its landing waits fit each build", async () => {
    const guide = await Bun.file(join(import.meta.dir, '../drivers/maestro.md')).text()
    const block = /start the flow with this sign-in[\s\S]*?```yaml\n([\s\S]*?)```/.exec(guide)?.[1] ?? ''
    expect(asWritten(block.replace(/^ {2}/gm, ''))).toEqual(await readSignIn())
    const wait = (build: string) => new RegExp(`${build}[^\\n]*: \`(- extendedWaitUntil: [^\`]+)\``).exec(guide)?.[1]
    expect(asWritten(wait('c1-first-run') ?? '')).toEqual([landing('Welcome to Thunderbolt!')])
    expect(asWritten(wait('any other session') ?? '')).toEqual([landing('Ask me anything…')])
  })

  test('a flow that waits for the first screen without typing the code is signed in by the harness first', async () => {
    // Run 39391108579: every iOS flow pressed Continue and then waited for the welcome screen, with no code typed.
    const c1 = 'c1-first-run-ios'
    const welcome = '- extendedWaitUntil:\n    visible: Welcome to Thunderbolt!\n    timeout: 60000\n'
    const partial = `- launchApp\n- tapOn: Email\n- inputText: \${EMAIL}\n- tapOn: Continue\n${welcome}- tapOn: Skip\n`
    await writeNative(makeNative('unsigned', layout), partial, c1)
    const typed = `- launchApp\n- retry:\n    commands:\n      - inputText: '12345678'\n${welcome}- tapOn: Skip\n`
    await writeNative(makeNative('typed', layout), typed, c1)
    // A bug on the sign-in screen itself never waits for a later one.
    await writeNative(makeNative('login', layout), '- launchApp\n- tapOn: Email\n', c1)
    // Run 39391108579's flows wrote the chat's ellipsis as three dots.
    const chat = '- launchApp\n- extendedWaitUntil:\n    visible:\n      text: Ask me anything...\n'
    await writeNative(makeNative('chat', layout), chat)
    const flows = new Map<string, { flow: unknown[]; signIn?: unknown[] }>()
    const record: RunFlow = async (yaml, _outDir, _run, _session, signIn) => {
      flows.set(yaml, { flow: commands(yaml), signIn: signIn === undefined ? undefined : commands(signIn) })
      return { passed: true, layout: [], logs: [] }
    }

    await replay(outDir, fakeRunner({}, []), qaDir, record)

    const signIn = await readSignIn()
    // Control first, then the findings in path order: c1's login, typed and unsigned, then c2's chat.
    expect([...flows.values()].slice(1)).toEqual([
      { flow: asWritten('- launchApp\n- tapOn: Email\n') },
      { flow: asWritten(typed) },
      { signIn: [...signIn, landing('Welcome to Thunderbolt!')], flow: asWritten(partial).slice(4) },
      { signIn: [...signIn, landing('Ask me anything…')], flow: asWritten(chat).slice(1) },
    ])
  })

  // A fresh install opens onboarding on the privacy step; the explorer's own app may have had it behind it.
  const c1 = 'c1-first-run-ios'
  const code = "- launchApp\n- inputText: '12345678'\n"
  const welcome = '- extendedWaitUntil:\n    visible: Welcome to Thunderbolt!\n'
  /** `control/consent.yaml` as the sign-in step ends with it: skipped while `text` shows. */
  const consentUnless = async (text: string) => {
    const [wizard, settle, block] = list.parse(
      Bun.YAML.parse(await Bun.file(join(import.meta.dir, '../control/consent.yaml')).text()),
    )
    const { runFlow } = z.object({ runFlow: z.object({ when: z.object({}).loose() }).loose() }).parse(block)
    return [wizard, settle, { runFlow: { ...runFlow, when: { ...runFlow.when, notVisible: text } } }]
  }
  /** Replays the c1 flows and returns each finding's first run, as the device got it. */
  const firstRuns = async (flows: Record<string, { flow: string; oracle: RawFinding['oracle'] }>) => {
    for (const [title, { flow, oracle }] of Object.entries(flows))
      await writeNative(makeNative(title, oracle), flow, c1)
    const ran: { flow: unknown[]; signIn?: unknown[] }[] = []
    const record: RunFlow = async (yaml, _outDir, _run, _session, signIn) => {
      ran.push(signIn === undefined ? { flow: commands(yaml) } : { signIn: commands(signIn), flow: commands(yaml) })
      return { passed: true, layout: [], logs: [] }
    }
    await replay(outDir, fakeRunner({}, []), qaDir, record)
    return ran.filter((_, run) => run % 3 === 0).slice(1)
  }

  test('a c1 flow relying on a later screen ends its sign-in step with the harness past the privacy step', async () => {
    const privacy = '- assertVisible: Privacy Policy\n'
    const flows = {
      // Stops on the welcome screen, for the probe to measure the name field it quotes.
      a: { flow: `${code}${welcome}- waitForAnimationToEnd\n`, oracle: layout },
      // Waits for the name step right after the code.
      b: {
        flow: `${code}- extendedWaitUntil:\n    visible: Enter your name\n- assertVisible: Ada\n`,
        oracle: assertFailed,
      },
      // Asserts a text of the privacy step itself, which the device skips the block for.
      c: { flow: `${code}${welcome}${privacy}`, oracle: assertFailed },
      // Signed in by the harness, then stops on the welcome screen.
      d: { flow: `- launchApp\n${welcome}`, oracle: layout },
    }

    const ran = await firstRuns(flows)

    const [a, b, c, d] = Object.values(flows).map(({ flow }) => asWritten(flow))
    const name = await consentUnless('Enter your name')
    expect(ran).toEqual([
      { signIn: [...a.slice(0, 3), ...name], flow: a.slice(3) },
      // Its last command asserts the bug, so the wait before it joins the first step too.
      { signIn: [...b.slice(0, 2), ...name, b[2]], flow: b.slice(3) },
      { signIn: [...c.slice(0, 3), ...(await consentUnless('Privacy Policy'))], flow: c.slice(3) },
      // A flow left with no command gets a harmless one, since Maestro refuses an empty flow.
      {
        signIn: [...(await readSignIn()), landing('Welcome to Thunderbolt!'), ...d.slice(1), ...name],
        flow: ['waitForAnimationToEnd'],
      },
    ])
  })

  test('a c1 flow that acts on the welcome screen, or relies on no text after it, gets no privacy step', async () => {
    const flows = {
      e: { flow: `${code}${welcome}- tapOn: I agree to the Privacy Policy.*\n`, oracle: layout },
      // Only a layout finding's quote names what the flow is after.
      f: {
        flow: `${code}${welcome}`,
        oracle: { type: 'stuck', evidence: 'Continue stays off after "Enter your name"' },
      },
      g: { flow: `${code}${welcome}`, oracle: { type: 'layout', evidence: '[qa-layout] offscreen button ""' } },
      // A quote the allow list would refuse in the `when`.
      h: { flow: `${code}${welcome}`, oracle: { type: 'layout', evidence: '[qa-layout] offscreen button "${HOME}"' } },
    }

    const ran = await firstRuns(flows)

    const [e, f, g, h] = Object.values(flows).map(({ flow }) => asWritten(flow))
    // f's failure is the bug, so only its last command runs after the rest.
    expect(ran).toEqual([{ flow: e }, { signIn: f.slice(0, 2), flow: f.slice(2) }, { flow: g }, { flow: h }])
  })

  test('a run that fails in the harness way past the privacy step is inconclusive, never the bug', async () => {
    const flow = `${code}- extendedWaitUntil:\n    visible: Enter your name\n- assertVisible: Ada\n`
    await writeNative(makeNative('stuck', assertFailed), flow, c1)
    // The control passes; the finding's runs fail in the block when it is in the sign-in step, in the flow otherwise.
    const failsInConsent: RunFlow = async (_yaml, _outDir, _run, session, signIn) => {
      if (session === 'control') return { passed: true, layout: [], logs: [] }
      const signInFailed = signIn?.includes('Connect Google') === true
      return { passed: false, signInFailed, layout: [], logs: [], error: 'Assertion is false: "Connect Google"' }
    }

    const result = await replay(outDir, fakeRunner({}, []), qaDir, failsInConsent)

    expect(result.confirmed).toEqual([])
    expect(result.flaky.map(({ id, replay }) => [id, replay])).toEqual([
      ['stuck', { failed: 0, runs: 0, inconclusive: 6, reason: 'only 0 of 3 runs reached the screen' }],
    ])
  })

  test("a run whose harness sign-in failed is inconclusive for every oracle, never the bug's proof", async () => {
    const unsigned = (title: string) =>
      `- launchApp\n- extendedWaitUntil:\n    visible: Ask me anything…\n- assertVisible: ${title}\n`
    await writeNative(makeNative('assert', assertFailed), unsigned('assert'))
    await writeNative(makeNative('stalled', assertFailed), unsigned('stalled'))
    const failedSignIn = {
      passed: false,
      signInFailed: true,
      error: 'Assertion is false: "Check your email" is visible',
    }
    const failed = { passed: false, error: 'Assertion is false: "assert" is visible' }

    const result = await nativeReplay({
      assert: [failedSignIn, failed, failed, failed],
      stalled: Array(6).fill(failedSignIn),
    })

    expect(result.confirmed.map(({ id, replay }) => [id, replay])).toEqual([
      ['assert', { failed: 3, runs: 3, inconclusive: 1, error: failed.error }],
    ])
    expect(result.flaky.map(({ id, replay }) => [id, replay])).toEqual([
      ['stalled', { failed: 0, runs: 0, inconclusive: 6, reason: 'only 0 of 3 runs reached the screen' }],
    ])
  })

  test('a native run proves the bug only by failing at its last command, or for a log oracle by the line', async () => {
    // The local validation's iOS finding: the location search never found "Berlin", well before the assertion.
    const flow = (broken: string, last: string) => `- launchApp\n- tapOn: ${broken}\n- assertNotVisible: ${last}\n`
    await writeNative(makeNative('early', assertFailed), flow('Broken search', 'early'))
    await writeNative(makeNative('late', assertFailed), flow('Search', 'Broken late'))
    const quoted = 'CONSOLE ERROR Failed to load chat'
    await writeNative(makeNative('logged', { type: 'console-error', evidence: quoted }), flow('Broken log', 'logged'))
    /** Fails each run at the command holding "Broken", in whichever part of the split that command ran. */
    const device: RunFlow = async (yaml, _outDir, _run, _session, signIn) => {
      const at = signIn?.includes('Broken') ? 'first' : yaml.includes('Broken') ? 'flow' : undefined
      if (at === undefined) return { passed: true, layout: [], logs: [] }
      return { passed: false, signInFailed: at === 'first', error: 'Element not found: Broken', layout: [], logs: [] }
    }

    const result = await replay(outDir, fakeRunner({}, []), qaDir, device)

    expect(result.confirmed.map(({ id, replay }) => [id, replay.failed, replay.runs])).toEqual([['late', 3, 3]])
    expect(result.flaky.map(({ id, replay }) => [id, replay])).toEqual([
      ['early', { failed: 0, runs: 0, inconclusive: 6, reason: 'only 0 of 3 runs reached the screen' }],
      ['logged', { failed: 0, runs: 0, inconclusive: 6, reason: 'only 0 of 3 runs reached the screen' }],
    ])
  })

  test('a leg stops starting runs before its timeout, keeping time for later findings, and says why', async () => {
    // Run 39391108579: 18 inconclusive iOS runs of about 3.5 minutes each ran the leg into its 90-minute timeout.
    // The job started at minute 0 and its setup took 10 minutes, longer on Android than on iOS.
    const minutes = 8
    const clock = { now: 10 * 60_000 }
    const early = { passed: false, error: 'Assertion is false: "What should we call you?" is visible' }
    const seen = { layout: ['[qa-layout] ready', nameLine] }
    const answers = new Map<string, Partial<FlowRun>>([
      ['a-stuck', early],
      ['b-bug', seen],
      ['c-late', seen],
    ])
    for (const title of answers.keys()) await writeNative(makeNative(title, layout))
    const calls: string[] = []
    const slow: RunFlow = async (yaml) => {
      const title = /assertVisible: "?([^"\n]+)/.exec(yaml)?.[1] ?? ''
      calls.push(title)
      clock.now += minutes * 60_000
      return { passed: true, layout: [], logs: [], ...answers.get(title) }
    }

    const result = await replay(outDir, fakeRunner({}, []), qaDir, slow, () => clock.now, 0)

    // Runs end by minute 88, 2 minutes before the job's timeout. a-stuck gets no extra run, since b-bug and c-late are
    // owed theirs. c-late's first run would end at minute 90: counted from the replay step, it would have started.
    expect(calls).toEqual([...Array(3).fill('stack control'), ...Array(3).fill('a-stuck'), ...Array(3).fill('b-bug')])
    expect(clock.now).toBe(82 * 60_000)
    expect(titles(result.confirmed)).toEqual(['b-bug'])
    const outOfTime = "out of time: another run might not end before the leg's 90-minute timeout"
    expect(result.flaky.map(({ id, replay }) => [id, replay])).toEqual([
      ['a-stuck', { failed: 0, runs: 0, inconclusive: 3, reason: outOfTime }],
      ['c-late', { failed: 0, runs: 0, reason: outOfTime }],
    ])
  })

  test('the leg starts when the command does unless the job recorded its start, and a bad start is refused', () => {
    expect(legStartOf(undefined, 5_000)).toBe(5_000)
    expect(legStartOf('', 5_000)).toBe(5_000)
    expect(legStartOf('1792479250', 5_000)).toBe(1_792_479_250_000)
    expect(() => legStartOf('soon', 5_000)).toThrow('QA_LEG_START must be the epoch second the job started')
    expect(() => legStartOf('0', 5_000)).toThrow('QA_LEG_START')
  })

  test('the native replay command runs by hand without the leg start and refuses a malformed one', async () => {
    const env = { ...process.env, QA_WEBVIEW_LOG: join(outDir, 'w.log'), QA_BACKEND_LOG: join(outDir, 'b.log') }
    const args = ['replay', '--out', outDir, '--native', 'ios', '--device', 'd', '--app', 'a', '--app-onboarding', 'b']
    const cli = (legStart: string) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, 'verify.ts'), ...args], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...env, QA_LEG_START: legStart },
      })

    const malformed = cli('soon')
    expect(malformed.exitCode).toBe(1)
    expect(malformed.stderr.toString()).toContain('QA_LEG_START must be the epoch second the job started')
    // No findings, so no device: the command only writes the empty candidates.
    expect(cli('').exitCode).toBe(0)
    expect(cli('1792479250').exitCode).toBe(0)
  })
})

describe('native fix verification', () => {
  const nameLine = '[qa-layout] focused-clipped textbox "Enter your name"'
  const flow = '- launchApp\n- assertVisible: What should we call you?\n'
  const timeout = { passed: false, error: 'iOS driver not ready in time' }
  const failed = { passed: false, error: 'Assertion is false: "Continue" is visible' }

  /** A device answering each run with the next queued result (a clean pass once none is left), recording the runs. */
  const device = (results: Partial<FlowRun>[], runs: number[] = []): RunFlow => {
    const queue = [...results]
    return async (_yaml, _outDir, run) => {
      runs.push(run)
      return { passed: true, layout: ['[qa-layout] ready'], logs: [], ...queue.shift() }
    }
  }
  const base = { fp: 'ab12cd34', platform: 'ios', session: 'c1-first-run-ios', flow, outDir }
  const layout = { type: 'layout', evidence: nameLine }

  test('passes only when no patched run shows the bug: the quoted probe line, or the flow failing', async () => {
    const clean = await verifyNativeFix({ ...base, oracle: layout, patched: device([]) })
    expect(clean).toEqual({ fp: 'ab12cd34', platform: 'ios', runs: 3, failed: 0, passed: true })

    const seen = { layout: ['[qa-layout] ready', nameLine] }
    expect(await verifyNativeFix({ ...base, oracle: layout, patched: device([{}, seen]) })).toMatchObject({
      failed: 1,
      passed: false,
      error: `the layout probe logged ${nameLine}`,
    })
    // A layout flow that failed without the line never reached the screen, which still fails the patch.
    expect(await verifyNativeFix({ ...base, oracle: layout, patched: device([failed]) })).toMatchObject({
      failed: 1,
      passed: false,
      error: failed.error,
    })
  })

  test('a failure-oracle flow failing before its last command fails the patch, but never shows the bug without it', async () => {
    const asserted = { type: 'assert-failed', evidence: 'the name step never shows' }
    const steps = { ...base, flow: '- launchApp\n- tapOn: Continue\n- assertVisible: What should we call you?\n' }
    /** A device whose run fails at the command holding `text`, in whichever part of the split that command ran. */
    const failsAt = (text: string, times = Infinity): RunFlow => {
      const state = { failures: 0 }
      return async (yaml, _outDir, _run, _session, signIn) => {
        const at = signIn?.includes(text) ? 'first' : yaml.includes(text) ? 'flow' : undefined
        if (at === undefined || state.failures++ >= times) return { passed: true, layout: [], logs: [] }
        const error = `Element not found: ${text}`
        return { passed: false, signInFailed: at === 'first', error, layout: [], logs: [] }
      }
    }

    // A fix must leave the whole way to the bug working: one early failure blocks it, and is not run again.
    const broken = await verifyNativeFix({ ...steps, oracle: asserted, patched: failsAt('Continue', 1) })
    expect(broken).toEqual({
      fp: 'ab12cd34',
      platform: 'ios',
      runs: 3,
      failed: 1,
      passed: false,
      error: 'Element not found: Continue',
    })
    const early = await verifyNativeFix({
      ...steps,
      oracle: asserted,
      patched: failsAt('nothing'),
      original: failsAt('Continue'),
    })
    expect(early).toMatchObject({ failsWithout: false, passed: false })
    const shown = await verifyNativeFix({
      ...steps,
      oracle: asserted,
      patched: failsAt('nothing'),
      original: failsAt('What should we call you?'),
    })
    expect(shown).toMatchObject({ failsWithout: true, passesWith: true, passed: true })
    // Without the patch a layout run that never reached the screen is run again rather than counted as clean.
    const seen = { layout: ['[qa-layout] ready', nameLine] }
    const layoutOriginal = device([failed, seen, seen, seen])
    const reran = await verifyNativeFix({ ...base, oracle: layout, patched: device([]), original: layoutOriginal })
    expect(reran).toMatchObject({ failsWithout: true, passed: true })
  })

  test('a driver that never starts fails the run after its one retry, so a dead device never passes a patch', async () => {
    const runs: number[] = []
    const result = await verifyNativeFix({ ...base, oracle: layout, patched: device([timeout, timeout], runs) })
    expect(result).toMatchObject({ runs: 3, failed: 1, passed: false })
    expect(runs).toEqual([1, 2, 3, 4])
  })

  test('a layout verdict needs the probe ready in every patched run: a silent probe proves nothing', async () => {
    const silent = { layout: [] }
    expect(await verifyNativeFix({ ...base, oracle: layout, patched: device([{}, silent]) })).toMatchObject({
      failed: 1,
      passed: false,
      error: 'the layout probe never reported ready',
    })
    // An assertion oracle is proven by the flow itself.
    const asserted = { type: 'assert-failed', evidence: 'never shows' }
    const passed = await verifyNativeFix({ ...base, oracle: asserted, patched: device([silent, silent, silent]) })
    expect(passed).toMatchObject({ failed: 0, passed: true })
  })

  test('a real-AI session must also fail without the patch, since it is checked on the fake AI', async () => {
    const real = { ...base, platform: 'android', session: 'c3-models-providers-android' }
    const asserted = { type: 'assert-failed', evidence: 'the model list never loads' }
    const missing = verifyNativeFix({ ...real, oracle: asserted, patched: device([]) })
    await expect(missing).rejects.toThrow('pass the original app')

    const noBugOnFakeAi = await verifyNativeFix({
      ...real,
      oracle: asserted,
      patched: device([]),
      original: device([]),
    })
    expect(noBugOnFakeAi).toMatchObject({ failsWithout: false, passesWith: true, passed: false })
    const fixed = await verifyNativeFix({
      ...real,
      oracle: asserted,
      patched: device([]),
      original: device([failed, failed, failed]),
    })
    expect(fixed).toMatchObject({ failsWithout: true, passesWith: true, passed: true })
  })

  test('a visual check counts only its own assertions, and must fail every run without the patch', async () => {
    // A probe line is no failure for a check: on c1 iOS the untouched keyboard bug would log one on every run.
    const problem = { layout: ['[qa-layout] ready', '[qa-layout] covered button "Continue"'] }
    expect(
      await verifyNativeFix({ ...base, patched: device([problem]), original: device([failed, problem, failed]) }),
    ).toMatchObject({ failed: 0, failsWithout: false, passesWith: true, passed: false })
    const pass = await verifyNativeFix({
      ...base,
      patched: device([]),
      original: device([failed, failed, failed]),
    })
    expect(pass).toEqual({
      fp: 'ab12cd34',
      platform: 'ios',
      runs: 3,
      failed: 0,
      passed: true,
      failsWithout: true,
      passesWith: true,
    })

    // A driver that did not start shows no defect, so it is no failure without the patch.
    const notFailing = await verifyNativeFix({
      ...base,
      patched: device([]),
      original: device([failed, timeout, timeout]),
    })
    expect(notFailing).toMatchObject({ failsWithout: false, passesWith: true, passed: false })
    const stillFailing = await verifyNativeFix({
      ...base,
      patched: device([{}, failed]),
      original: device([failed, failed, failed]),
    })
    expect(stillFailing).toMatchObject({ failed: 1, failsWithout: true, passesWith: false, passed: false })
  })

  test('a repro flow that skips the sign-in code is signed in by the harness, as replay ran it', async () => {
    const runs: { flow: string; signIn?: string }[] = []
    const record: RunFlow = async (flow, _outDir, _run, _session, signIn) => {
      runs.push({ flow, signIn })
      return { passed: true, layout: ['[qa-layout] ready'], logs: [] }
    }
    const unsigned = '- launchApp\n- tapOn: Continue\n- extendedWaitUntil:\n    visible: Welcome to Thunderbolt!\n'

    await verifyNativeFix({ ...base, flow: unsigned, oracle: layout, patched: record })

    expect(runs).toHaveLength(3)
    expect(runs[0].signIn).toContain('inputText: "12345678"')
    // The flow's partial sign-in is gone, and the harness takes it past the privacy step in the sign-in step.
    expect(runs[0].flow).not.toContain('tapOn')
    expect(runs[0].signIn).toContain('Connect Google')
  })

  test('a fix never passes, and its original never fails, on runs whose harness sign-in failed', async () => {
    const unsigned = '- launchApp\n- extendedWaitUntil:\n    visible: Welcome to Thunderbolt!\n'
    const failedSignIn = {
      passed: false,
      signInFailed: true,
      error: 'Assertion is false: "Check your email" is visible',
    }
    const broken = () => device(Array(6).fill(failedSignIn))
    const asserted = { type: 'assert-failed', evidence: 'never shows' }

    const result = await verifyNativeFix({
      ...base,
      flow: unsigned,
      oracle: asserted,
      patched: broken(),
      original: broken(),
    })

    expect(result).toMatchObject({ runs: 0, failed: 0, passed: false, failsWithout: false, passesWith: false })
    expect(result.error).toBe('only 0 of 3 runs reached the screen')
  })

  test('a flow outside the allow list never reaches the device', async () => {
    const runs: number[] = []
    const evil = verifyNativeFix({
      ...base,
      flow: '- runScript: steal.js\n',
      oracle: layout,
      patched: device([], runs),
    })
    await expect(evil).rejects.toThrow('runScript')
    expect(runs).toEqual([])
  })

  test('the oracle comes from verified.json for a repro flow, and a check elsewhere has none', async () => {
    const session = 'c1-first-run-ios'
    const finding = {
      ...makeFinding('colour', layout),
      viewport: 'ios',
      repro_spec: undefined,
      repro_flow: 'repro/1.yaml',
    }
    const verified = { confirmed: [{ charterDir: session, id: '1', finding, replay: { failed: 3, runs: 3 } }] }
    await Bun.write(join(outDir, 'verified.json'), JSON.stringify(verified))

    expect(await oracleOf(join(outDir, session, 'repro', '1.yaml'), session)).toEqual(layout)
    expect(await oracleOf(join(outDir, 'fix-ab12cd34', 'repro', 'check.yaml'), session)).toBeUndefined()
    // A flow in the session dir that no confirmed finding names never runs against a borrowed oracle.
    await expect(oracleOf(join(outDir, session, 'repro', '2.yaml'), session)).rejects.toThrow('not the repro flow')
    await expect(oracleOf(join(outDir, session, 'repro', '1.yaml'), 'c2-chat-power-user-ios')).resolves.toBeUndefined()
  })
})

describe('judge', () => {
  const candidate = (title: string) => ({
    charterDir: 'c2-chat-desktop',
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
      const { repro_spec, screenshot, title } = file.finding
      if (repro_spec) await Bun.write(join(outDir, file.charterDir, repro_spec), validSpec(title))
      if (screenshot) await Bun.write(join(outDir, file.charterDir, screenshot), pngBytes)
    }
  }

  const visualCandidate = (finding: RawFinding) => ({
    charterDir: 'c2-chat-desktop',
    id: finding.title,
    finding,
    replay: { failed: 0, runs: 0 },
    artifacts: { screenshot: `qa-out/c2-chat-desktop/${finding.screenshot}` },
  })

  const recordingCreate =
    (calls: Anthropic.MessageCreateParamsNonStreaming[]): CreateMessage =>
    async (params) => {
      calls.push(params)
      return {
        content: [{ type: 'text', text: '{"keep":true,"reason":"The button is hidden."}', citations: null }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2000, output_tokens: 100 },
      }
    }

  test('the judge sees a visual finding without a spec, and its screenshot typed by its bytes', async () => {
    const png = makeVisual('png')
    // A JPEG saved under a .png name: the bytes decide the media type, not the extension.
    const jpeg = makeVisual('jpeg', 'mcp-b/page-1.png')
    await writeCandidates({ confirmed: [png, jpeg].map(visualCandidate), flaky: [], observations: [], dropped: [] })
    const jpegBytes = jpegOf(390, 844)
    await Bun.write(join(outDir, 'c2-chat-desktop/mcp-b/page-1.png'), jpegBytes)
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, recordingCreate(calls), qaDir)

    expect(titles(result.confirmed)).toEqual(['png', 'jpeg'])
    const image = (mediaType: 'image/png' | 'image/jpeg', bytes: Buffer): Anthropic.ImageBlockParam => ({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
    })
    expect(calls.map((call) => call.messages[0].content)).toEqual([
      [image('image/png', pngBytes), { type: 'text', text: `<finding>\n${JSON.stringify(png, null, 2)}\n</finding>` }],
      [
        image('image/jpeg', jpegBytes),
        { type: 'text', text: `<finding>\n${JSON.stringify(jpeg, null, 2)}\n</finding>` },
      ],
    ])
  })

  test('the judge never reads a screenshot path that leaves the session dir', async () => {
    // A candidates.json written by anything but replay. Both files exist, one level above the session dir.
    await Bun.write(join(outDir, 'secret.png'), pngBytes)
    await Bun.write(join(outDir, 'mcp/page-1.png'), pngBytes)
    const outside = [
      { ...visualCandidate(makeVisual('escape')), finding: makeVisual('escape', '../secret.png') },
      { ...visualCandidate(makeVisual('root')), charterDir: '.', finding: makeVisual('root', 'mcp/page-1.png') },
    ]
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    for (const candidate of outside) {
      await Bun.write(
        join(outDir, 'candidates.json'),
        JSON.stringify({ confirmed: [candidate], flaky: [], observations: [], dropped: [] }),
      )
      await expect(judge(outDir, recordingCreate(calls), qaDir)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  test('an image counts toward the judge spend ceiling', async () => {
    expect(worstJudgeCost('s', 'u', 1) - worstJudgeCost('s', 'u', 0)).toBeCloseTo((1_600 * 4) / 1_000_000)
    // Text that fits under the $2 ceiling with 800 input tokens to spare, so only the image's 1,600 push it over.
    const base = makeVisual('tight')
    const room = (2 - (4096 * 20) / 1_000_000) / (4 / 1_000_000) - 1_000 - 26 - 800
    const pad = room - JSON.stringify(base, null, 2).length - '<finding>\n\n</finding>'.length
    const tight = { ...base, actual: 'x'.repeat(Math.floor(pad)) }
    await writeCandidates({ confirmed: [visualCandidate(tight)], flaky: [], observations: [], dropped: [] })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, recordingCreate(calls), qaDir)

    expect(calls).toEqual([])
    expect(result.deferred).toEqual([
      { file: visualCandidate(tight), step: 'judge', reason: "over the judge's spend ceiling of $2" },
    ])
  })

  test('keeps what the judge keeps and drops the rest, defaulting to drop on a malformed reply', async () => {
    const observation = { charterDir: 'c2-chat-desktop', id: 'obs', finding: makeFinding('obs', pageError) }
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

  const nativeCandidate = (repro_flow: string, charterDir = 'c1-first-run-ios') => ({
    ...candidate('native'),
    charterDir,
    finding: { ...makeFinding('native', pageError), viewport: 'ios', repro_spec: undefined, repro_flow },
  })

  test('the judge reads the flow replay ran, never the comments the model wrote around it', async () => {
    await writeCandidates({ confirmed: [nativeCandidate('repro/1.yaml')], flaky: [], observations: [], dropped: [] })
    const flow = '# This reaches the name step and shows the bug\n- launchApp\n- tapOn: Continue # the real button\n'
    await Bun.write(join(outDir, 'c1-first-run-ios/repro/1.yaml'), flow)
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    await judge(outDir, fakeCreate({ native: '{"keep":true,"reason":"ok"}' }, calls), qaDir)

    const prompt = String(calls[0].messages[0].content)
    const ran = 'appId: net.thunderbird.thunderbolt.dev\n---\n- launchApp\n- tapOn: Continue'
    expect(prompt).toContain(`<repro_flow>\n${ran}\n</repro_flow>`)
    expect(prompt).not.toContain('name step')
    expect(prompt).not.toContain('<repro_spec>')
  })

  test('the judge never reads a flow path that leaves the session dir', async () => {
    await Bun.write(join(outDir, 'secret.yaml'), '- launchApp\n')
    await Bun.write(join(outDir, 'repro/1.yaml'), '- launchApp\n')
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    for (const native of [nativeCandidate('../secret.yaml'), nativeCandidate('repro/1.yaml', '.')]) {
      await Bun.write(
        join(outDir, 'candidates.json'),
        JSON.stringify({ confirmed: [native], flaky: [], observations: [], dropped: [] }),
      )
      await expect(judge(outDir, recordingCreate(calls), qaDir)).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  test('judges at most 15 candidates and defers the rest, keeping the replay leg deferrals', async () => {
    const ids = Array.from({ length: 16 }, (_, n) => `j${String(n).padStart(2, '0')}`)
    const replayDeferred = { file: candidate('late'), step: 'replay' as const, reason: 'over the cap' }
    await writeCandidates({
      confirmed: ids.map(candidate),
      flaky: [],
      observations: [],
      dropped: [],
      deferred: [replayDeferred],
    })
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, fakeCreate({}, calls), qaDir)

    expect(calls).toHaveLength(15)
    expect(result.deferred).toEqual([
      replayDeferred,
      { file: candidate('j15'), step: 'judge', reason: 'over the cap of 15 judged findings' },
    ])
    expect(result.dropped.map((entry) => entry.file.id)).not.toContain('j15')
  })

  test('defers a candidate whose worst-case cost would pass the spend ceiling, and judges the next one', async () => {
    await writeCandidates({
      confirmed: [candidate('huge'), candidate('small')],
      flaky: [],
      observations: [],
      dropped: [],
    })
    // 600,000 bytes may be up to 600,000 input tokens: $2.40 at $4 per million, over the $2 ceiling.
    await Bun.write(join(outDir, 'c2-chat-desktop/repro/huge.spec.ts'), 'x'.repeat(600_000))
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []

    const result = await judge(outDir, fakeCreate({ small: '{"keep":true,"reason":"ok"}' }, calls), qaDir)

    expect(calls).toHaveLength(1)
    expect(result.confirmed.map((file) => file.id)).toEqual(['small'])
    expect(result.deferred).toEqual([
      { file: candidate('huge'), step: 'judge', reason: "over the judge's spend ceiling of $2" },
    ])
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
