#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import { hasOracle, lintReproSpec, loadFindings, type FindingFile, type RejectedFile } from './findings'

export type VerifiedFinding = FindingFile & {
  /** `error`: the first failed run's error message, shown to the judge. */
  replay: { failed: number; runs: number; error?: string }
  judge?: { keep: boolean; reason: string }
  artifacts: { video?: string; trace?: string }
}

/** `qa-out/verified.json`; `candidates.json` has the same shape, with `confirmed` not yet judged. */
export type Verified = {
  confirmed: VerifiedFinding[]
  flaky: VerifiedFinding[]
  observations: FindingFile[]
  dropped: {
    /** A `VerifiedFinding` from gate `replay` on, carrying its replay counts. */
    file: FindingFile | VerifiedFinding | RejectedFile
    gate: 'schema' | 'lint' | 'replay' | 'judge'
    reason: string
  }[]
  judge_usage?: { input_tokens: number; output_tokens: number; cost_usd: number }
  /** Set when the control spec failed: nothing is confirmed and every replayed finding is dropped. */
  stack_unhealthy?: string
}

/** The part of Playwright's JSON report that replay reads. `errors` lists files that failed to load. */
export type ReplayReport = { config: { rootDir: string }; suites: ReplaySuite[]; errors: { message: string }[] }
type ReplaySuite = {
  specs: {
    file: string
    tests: {
      results: { status?: string; errors: { message: string }[]; attachments: { name: string; path?: string }[] }[]
    }[]
  }[]
  suites?: ReplaySuite[]
}
/** Runs the given specs (absolute paths) three times each in one Playwright run, or with `list` only loads them. */
export type RunReplay = (specs: string[], outDir: string, opts?: { list?: boolean }) => Promise<ReplayReport>

/** One Messages API call, injected so tests never reach the network. */
export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<
  Pick<Anthropic.Message, 'content' | 'stop_reason'> & {
    usage: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'>
  }
>

const judgeModel = 'claude-opus-5-5'
// USD per million tokens for judgeModel, from https://platform.claude.com/docs/en/about-claude/pricing.
const judgePrice = { input: 4, output: 20 }

/**
 * The specs are untrusted, so Playwright gets only what it needs to run and never the caller's secrets:
 * a dev shell with provider keys exported stays safe too.
 */
export const replayEnv = (outDir: string) => ({
  PATH: Bun.env.PATH,
  HOME: Bun.env.HOME,
  CI: Bun.env.CI,
  PLAYWRIGHT_BROWSERS_PATH: Bun.env.PLAYWRIGHT_BROWSERS_PATH,
  QA_OUT: outDir,
})

const runPlaywright: RunReplay = async (specs, outDir, { list = false } = {}) => {
  // `/…/` filters are case-sensitive and anchored, so no spec that failed the lint can match.
  const filters = specs.map((spec) => `/^${RegExp.escape(spec)}$/`)
  const mode = list ? ['--list'] : ['--repeat-each=3', '--retries=0']
  // A file, not stdout: a spec that logs at module scope would corrupt a report on stdout.
  const reportFile = resolve(outDir, 'replay-report.json')
  await rm(reportFile, { force: true })
  const result = await Bun.$`bunx playwright test --config playwright.qa.config.ts ${mode} --reporter=json ${filters}`
    .env({ ...replayEnv(outDir), PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile })
    .nothrow()
    .quiet()
  const report = Bun.file(reportFile)
  if (!(await report.exists())) throw new Error(`Playwright wrote no report:\n${result.stderr}`)
  return report.json()
}

const readList = async (path: string) =>
  (await Bun.file(path).text())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

const allSpecs = (suites: ReplaySuite[]): ReplaySuite['specs'] =>
  suites.flatMap((suite) => [...suite.specs, ...allSpecs(suite.suites ?? [])])

/**
 * Failed and total runs per spec file (absolute path), with the error, video and trace of the first failed run.
 * Every test in the file counts, so a file is confirmed only if all of its runs failed.
 */
const outcomesBySpec = (report: ReplayReport) => {
  const outcomes = new Map<string, Pick<VerifiedFinding, 'replay' | 'artifacts'>>()
  for (const spec of allSpecs(report.suites)) {
    const file = resolve(report.config.rootDir, spec.file)
    const outcome = outcomes.get(file) ?? { replay: { failed: 0, runs: 0 }, artifacts: {} }
    for (const result of spec.tests.flatMap((test) => test.results)) {
      if (result.status === 'skipped') continue
      outcome.replay.runs++
      if (result.status !== 'failed' && result.status !== 'timedOut') continue
      outcome.replay.failed++
      // All of the run's errors (a timeout names the pending step only in the second one), without ANSI colors
      // and capped: enough for the judge to tell a bad locator from the asserted bug.
      outcome.replay.error ??= stripVTControlCharacters(result.errors.map((e) => e.message).join('\n')).slice(0, 1_500)
      const artifact = (name: string) => {
        const path = result.attachments.find((a) => a.name === name)?.path
        return path && relative(process.cwd(), path)
      }
      outcome.artifacts.video ??= artifact('video')
      outcome.artifacts.trace ??= artifact('trace')
    }
    outcomes.set(file, outcome)
  }
  return outcomes
}

const specPath = (file: FindingFile) => `${file.charterDir}/${file.finding.repro_spec}`

/** Why the control spec says the stack is broken, or undefined when it passed every run. */
const stackProblem = (control: VerifiedFinding['replay'], report: ReplayReport) =>
  control.runs > 0 && control.failed === 0
    ? undefined
    : `control spec failed ${control.failed}/${control.runs} runs: ${control.error ?? report.errors[0]?.message ?? 'it did not run'}`

/** The specs that fail to load, each with its first error line. Loaded one at a time: the error may name no file. */
const loadErrors = async (specs: string[], outDir: string, runReplay: RunReplay) => {
  const broken = new Map<string, string>()
  for (const spec of specs) {
    const { errors } = await runReplay([spec], outDir, { list: true })
    if (errors.length > 0) broken.set(spec, stripVTControlCharacters(errors[0].message).split('\n')[0])
  }
  return broken
}

/**
 * Verify step 1: schema, oracle, spec lint, then one Playwright run replaying every surviving spec three times.
 * A spec asserts the expected behaviour, so failed 3/3 = confirmed, 1–2 = flaky, 0 = dropped. The same run replays
 * `qa/control/repro/stack.spec.ts`; if any of its runs fails, the stack is broken, nothing is confirmed and
 * `stack_unhealthy` says why. A spec that fails to load stops the whole Playwright run, so such specs are dropped at
 * gate `lint` and the rest replay again without them. Writes and returns `<outDir>/candidates.json`. Needs NO
 * secrets and must run without any: the specs were written by a model that read untrusted pages, and the spec lint
 * is defence in depth, not the boundary.
 */
export const replay = async (outDir: string, runReplay: RunReplay = runPlaywright, qaDir = 'qa') => {
  const { valid, rejected } = await loadFindings(outDir)
  const noise = await readList(join(qaDir, 'noise.txt'))
  const result: Verified = {
    confirmed: [],
    flaky: [],
    observations: [],
    dropped: rejected.map((file) => ({ file, gate: 'schema', reason: file.reason })),
  }
  const replayable: FindingFile[] = []
  for (const file of valid) {
    const { oracle } = file.finding
    const isNoise = oracle.type === 'console-error' && noise.some((line) => oracle.evidence.includes(line))
    if (!hasOracle(file.finding) || isNoise) {
      result.observations.push(file)
      continue
    }
    const spec = Bun.file(join(outDir, specPath(file)))
    const problems = (await spec.exists()) ? lintReproSpec(await spec.text()) : ['repro spec not found']
    if (problems.length > 0) result.dropped.push({ file, gate: 'lint', reason: problems.join('; ') })
    else replayable.push(file)
  }

  // Never start Playwright without a filter: it would run every spec, including the ones the lint rejected.
  if (replayable.length > 0) {
    const control = resolve(qaDir, 'control/repro/stack.spec.ts')
    const specOf = (file: FindingFile) => resolve(outDir, specPath(file))
    const specs = [...new Set(replayable.map(specOf))]
    const first = await runReplay([control, ...specs], outDir)
    const broken = first.errors.length > 0 ? await loadErrors(specs, outDir, runReplay) : new Map<string, string>()
    const report =
      broken.size > 0 ? await runReplay([control, ...specs.filter((spec) => !broken.has(spec))], outDir) : first
    const outcomes = outcomesBySpec(report)
    const noRuns = { replay: { failed: 0, runs: 0 }, artifacts: {} }
    result.stack_unhealthy = stackProblem((outcomes.get(control) ?? noRuns).replay, report)
    for (const file of replayable) {
      const loadError = broken.get(specOf(file))
      if (loadError) {
        result.dropped.push({ file, gate: 'lint', reason: `failed to load: ${loadError}` })
        continue
      }
      const replayed = { ...file, ...(outcomes.get(specOf(file)) ?? noRuns) }
      const { failed, runs } = replayed.replay
      if (result.stack_unhealthy) result.dropped.push({ file: replayed, gate: 'replay', reason: 'stack unhealthy' })
      else if (failed === 0) result.dropped.push({ file: replayed, gate: 'replay', reason: `failed 0/${runs} replays` })
      else if (failed === runs) result.confirmed.push(replayed)
      else result.flaky.push(replayed)
    }
  }
  await Bun.write(join(outDir, 'candidates.json'), JSON.stringify(result, null, 2))
  return result
}

const verdictSchema = z.object({ keep: z.boolean(), reason: z.string().min(1) })

/** The judge's verdict, or a drop when the reply is not the requested JSON (refusal, truncation, anything else). */
const readVerdict = (response: Awaited<ReturnType<CreateMessage>>) => {
  const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  try {
    return verdictSchema.parse(JSON.parse(text))
  } catch {
    return { keep: false, reason: `malformed judge reply (stop_reason: ${response.stop_reason})` }
  }
}

const createMessage: CreateMessage = (params) => new Anthropic().messages.create(params)

/**
 * Verify step 2: one fresh model call per confirmed candidate, seeing only the finding (with its oracle evidence),
 * its spec, its replay failure and `qa/known-issues.md`. Kept → `confirmed`, otherwise `dropped` at gate `judge`; flaky candidates are
 * never judged. Writes and returns `<outDir>/verified.json`. Needs `ANTHROPIC_API_KEY` and nothing else.
 */
export const judge = async (outDir: string, create: CreateMessage = createMessage, qaDir = 'qa') => {
  const candidates: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
  const system = `${await Bun.file(join(qaDir, 'judge.md')).text()}\n\n${await Bun.file(join(qaDir, 'known-issues.md')).text()}`
  const judged = await Promise.all(
    candidates.confirmed.map(async (candidate) => {
      const spec = await Bun.file(join(outDir, specPath(candidate))).text()
      const response = await create({
        model: judgeModel,
        max_tokens: 4096,
        system,
        output_config: { effort: 'medium', format: zodOutputFormat(verdictSchema) },
        messages: [
          {
            role: 'user',
            content:
              `<finding>\n${JSON.stringify(candidate.finding, null, 2)}\n</finding>\n\n` +
              `<repro_spec>\n${spec}\n</repro_spec>\n\n` +
              `<replay_failure>\n${candidate.replay.error ?? '(no message recorded)'}\n</replay_failure>`,
          },
        ],
      })
      return { finding: { ...candidate, judge: readVerdict(response) }, usage: response.usage }
    }),
  )
  const inputTokens = judged.reduce((sum, { usage }) => sum + usage.input_tokens, 0)
  const outputTokens = judged.reduce((sum, { usage }) => sum + usage.output_tokens, 0)
  const verified: Verified = {
    ...candidates,
    confirmed: judged.flatMap(({ finding }) => (finding.judge.keep ? [finding] : [])),
    dropped: [
      ...candidates.dropped,
      ...judged.flatMap(({ finding }) =>
        finding.judge.keep ? [] : [{ file: finding, gate: 'judge' as const, reason: finding.judge.reason }],
      ),
    ],
    judge_usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: (inputTokens * judgePrice.input + outputTokens * judgePrice.output) / 1_000_000,
    },
  }
  await Bun.write(join(outDir, 'verified.json'), JSON.stringify(verified, null, 2))
  return verified
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { out: { type: 'string', default: 'qa-out' } },
    allowPositionals: true,
  })
  const step = positionals[0]
  if (step !== 'replay' && step !== 'judge')
    throw new Error('usage: bun scripts/qa/verify.ts replay|judge --out qa-out')
  const result = await { replay, judge }[step](values.out)
  console.log(
    `confirmed ${result.confirmed.length}, flaky ${result.flaky.length}, ` +
      `observations ${result.observations.length}, dropped ${result.dropped.length}`,
  )
  if (result.stack_unhealthy) {
    console.error(`Stack unhealthy, nothing confirmed. The ${result.stack_unhealthy}`)
    process.exitCode = 1
  }
}
