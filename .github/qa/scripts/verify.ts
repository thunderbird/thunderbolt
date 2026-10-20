#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { readFile, rm } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import {
  hasOracle,
  lintReproSpec,
  loadFindings,
  normalize,
  platformOf,
  realAiCharters,
  reproFlowFile,
  screenshotFile,
  sessionProblem,
  signature,
  type FindingFile,
  type RejectedFile,
} from './findings'
import { checkMaestroFlow, flowVars } from './maestro-flow'
import { createRunFlow } from './replay-native'
import { cleanLogLine } from './sanitize'
import type { TranscriptMessage } from './report'

export type VerifiedFinding = FindingFile & {
  /** `error`: the first failed run's error message, shown to the judge. A visual finding never replays: 0/0. */
  replay: { failed: number; runs: number; error?: string }
  judge?: { keep: boolean; reason: string }
  /** Paths relative to the cwd. `screenshot`: a visual finding's screenshot. */
  artifacts: { video?: string; trace?: string; screenshot?: string }
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
  /** Over a cap: never replayed (`replay`) or never judged (`judge`), so neither confirmed nor dropped. */
  deferred?: { file: FindingFile; step: 'replay' | 'judge'; reason: string }[]
  judge_usage?: { input_tokens: number; output_tokens: number; cost_usd: number }
  /** Set when the control spec failed: every replayed finding is dropped, and only visual ones can be confirmed. */
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

/**
 * One run of a Maestro flow on a device. `layout`: the probe's `[qa-layout]` lines in the WebView log during the run,
 * each from `[qa-layout]` on. `logs`: every other new line of the WebView and backend logs, as `webview: <line>` or
 * `backend: <line>`. `video`: the run's recording.
 */
export type FlowRun = { passed: boolean; error?: string; video?: string; layout: string[]; logs: string[] }
/**
 * Runs a checked flow on a freshly installed app. `run` is unique within one replay; `session` is the finding's
 * session dir, which picks the build (onboarding on for c1).
 */
export type RunFlow = (flowYaml: string, outDir: string, run: number, session: string) => Promise<FlowRun>

/** One Messages API call, injected so tests never reach the network. */
export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<
  Pick<Anthropic.Message, 'content' | 'stop_reason'> & {
    usage: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'>
  }
>

const judgeModel = 'claude-opus-5-5'
// USD per million tokens for judgeModel, from https://platform.claude.com/docs/en/about-claude/pricing.
const judgePrice = { input: 4, output: 20 }
const judgeMaxTokens = 4096
// The aggregate caps, per replay leg and per judge leg; the README explains how to calibrate them.
const replayCap = 20
const judgeCap = 15
const judgeCeilingUsd = 2
// Message framing and the verdict schema, on top of the prompt text.
const judgeOverheadTokens = 1_000
// The API scales a larger image down to about 1.15 megapixels, about 1,600 tokens.
const judgeImageTokens = 1_600

/**
 * The most a judge call can cost. A token covers at least one byte of UTF-8 text, so the prompt's byte length
 * bounds its input tokens, each image adds `judgeImageTokens`, and `max_tokens` bounds the output.
 */
export const worstJudgeCost = (system: string, user: string, images = 0) =>
  ((Buffer.byteLength(system) + Buffer.byteLength(user) + judgeOverheadTokens + images * judgeImageTokens) *
    judgePrice.input +
    judgeMaxTokens * judgePrice.output) /
  1_000_000

const screenshotTools = new Set([
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright_b__browser_take_screenshot',
  'mcp__maestro__take_screenshot',
])

/**
 * Whether a screenshot result in the session's transcript names `file`, a finding's `screenshot` (`mcp/<name>`,
 * `mcp-b/<name>` or `maestro/shot-<n>.<ext>`). The tool prints the absolute path of the file it saved, so the
 * directory part also ties the file to the device that took it.
 */
export const screenshotTaken = (transcript: TranscriptMessage[], file: string): boolean => {
  const blocks = transcript.flatMap((m) => m.message.content)
  const shots = new Set(blocks.flatMap((b) => (b.type === 'tool_use' && screenshotTools.has(b.name) ? [b.id] : [])))
  return blocks.some((b) => b.type === 'tool_result' && shots.has(b.tool_use_id) && b.content.includes(file))
}

const fileTools = new Set(['Write', 'Edit'])

/** Whether the explorer's own Write or Edit tool wrote `file`: the browser's screenshot may then be gone. */
const fileToolWrote = (transcript: TranscriptMessage[], file: string) =>
  transcript
    .flatMap((m) => m.message.content)
    .some(
      (b) =>
        b.type === 'tool_use' &&
        fileTools.has(b.name) &&
        b.input?.file_path !== undefined &&
        resolve(b.input.file_path).endsWith(`/${file}`),
    )

// The Claude API's image limits (https://platform.claude.com/docs/en/build-with-claude/vision): the size once
// base64-encoded and the pixels per side. Over either, the judge call fails with a 400. The 5 MB limit people
// remember is Bedrock's and Google Cloud's; the judge calls the Claude API directly.
const imageLimit = { base64Bytes: 10_000_000, side: 8_000 }

type ImageInfo = { mediaType: 'image/png' | 'image/jpeg'; width: number; height: number }

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')

/** The size in a JPEG's first frame header: an SOFn marker, C0 to CF except DHT (C4), JPG (C8) and DAC (CC). */
const jpegSize = (bytes: Buffer) => {
  for (let at = 2; at + 9 <= bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    }
  }
  return undefined
}

/** The media type and size an image's own bytes declare, whatever its name says; undefined unless PNG or JPEG. */
export const imageInfo = (bytes: Buffer): ImageInfo | undefined => {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(pngSignature)) {
    return { mediaType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegSize(bytes) : undefined
  return jpeg && { mediaType: 'image/jpeg', ...jpeg }
}

/**
 * A model-written path inside a finding's session dir under `outDir`. The charter dir and the path are checked on every
 * read: no finding, and no edited candidates or verified file, can make replay, the judge or filing read a file
 * outside the session dir.
 */
const inSession = (outDir: string, file: FindingFile, schema: z.ZodString, path: string | undefined) => {
  if (!/^[\w-]+$/.test(file.charterDir)) throw new Error(`not a session dir: ${file.charterDir}`)
  return join(outDir, file.charterDir, schema.parse(path))
}

/** A visual finding's screenshot under `outDir`, checked on every read. */
export const screenshotPath = (outDir: string, file: FindingFile) =>
  inSession(outDir, file, screenshotFile, file.finding.screenshot)

/** A native finding's repro flow under `outDir`, checked on every read. */
const flowPath = (outDir: string, file: FindingFile) => inSession(outDir, file, reproFlowFile, file.finding.repro_flow)

/**
 * Why a visual finding's screenshot does not prove it, or undefined when it does. The file must be one the browser
 * wrote, and one the judge can send: a PNG or JPEG within the API's limits.
 */
const screenshotProblem = async (outDir: string, file: FindingFile) => {
  const path = screenshotPath(outDir, file)
  const screenshot = relative(join(outDir, file.charterDir), path)
  if (!(await Bun.file(path).exists())) return 'screenshot not found'
  // A session cut short can leave no transcript, or a broken one: nothing then proves the screenshot.
  const transcript: TranscriptMessage[] = await Bun.file(join(outDir, file.charterDir, 'transcript.json'))
    .json()
    .catch(() => [])
  if (!screenshotTaken(transcript, screenshot)) return 'screenshot not taken by the browser tool in this session'
  if (fileToolWrote(transcript, screenshot)) return 'screenshot written by a file tool, not the browser'
  const bytes = await readFile(path)
  const image = imageInfo(bytes)
  if (!image) return 'screenshot is not a PNG or JPEG image'
  if (Math.ceil(bytes.length / 3) * 4 > imageLimit.base64Bytes) return "screenshot over the API's 10 MB image limit"
  if (Math.max(image.width, image.height) > imageLimit.side) return "screenshot over the API's 8000 px image limit"
  return undefined
}

/**
 * The specs are untrusted, so Playwright gets only what it needs to run and never the caller's secrets:
 * a dev shell with provider keys exported stays safe too.
 */
export const replayEnv = (outDir: string) => ({
  PATH: Bun.env.PATH,
  HOME: Bun.env.HOME,
  CI: Bun.env.CI,
  PLAYWRIGHT_BROWSERS_PATH: Bun.env.PLAYWRIGHT_BROWSERS_PATH,
  // A failed replay would otherwise write the page's aria snapshot (it can hold typed field values) into error-context.md.
  PLAYWRIGHT_NO_COPY_PROMPT: '1',
  QA_OUT: outDir,
})

const runPlaywright: RunReplay = async (specs, outDir, { list = false } = {}) => {
  // `/…/` filters are case-sensitive and anchored, so no spec that failed the lint can match.
  const filters = specs.map((spec) => `/^${RegExp.escape(spec)}$/`)
  const mode = list ? ['--list'] : ['--repeat-each=3', '--retries=0']
  // A file, not stdout: a spec that logs at module scope would corrupt a report on stdout.
  const reportFile = resolve(outDir, 'replay-report.json')
  await rm(reportFile, { force: true })
  const result =
    await Bun.$`bunx playwright test --config .github/qa/playwright.config.ts ${mode} --reporter=json ${filters}`
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

/** The app a native finding's flow drives. `sessionProblem` keeps flows to native platforms, which all name one. */
const appIdOf = (file: FindingFile) => {
  const { appId } = platformOf(file.finding.viewport)
  if (!appId) throw new Error(`platforms.json has no app for ${file.finding.viewport}`)
  return appId
}

/** The flow replay ran for a native finding: the allow list's own serialization, never the model's text. */
const ranFlow = async (outDir: string, file: FindingFile) => {
  const check = checkMaestroFlow(await Bun.file(flowPath(outDir, file)).text(), {
    appId: appIdOf(file),
    vars: flowVars,
  })
  // Replay already dropped anything else, so this only fails on a flow changed after replay.
  if (!check.ok) throw new Error(`repro flow no longer passes the allow list: ${check.problems.join('; ')}`)
  return check.yaml
}
const driverTimeout = 'iOS driver not ready in time'
const logOracles = new Set(['console-error', 'page-error', 'http-5xx'])

type Outcome = Pick<VerifiedFinding, 'replay' | 'artifacts'>

/**
 * A log line or quoted evidence in the form both sides share: without colors, cleaned as the gate showed it to the
 * explorer, and from its console mark on, since the log stream's time, process and thread change every run.
 */
const fromConsoleMark = (text: string) => {
  const clean = cleanLogLine(stripVTControlCharacters(text))
  const at = clean.search(/CONSOLE |Tauri\/Console/)
  return at < 0 ? clean : clean.slice(at)
}

/**
 * What in a flow run shows the finding's bug, or undefined when the run did not show it. `layout`: a probe line equal
 * to the quoted one, never the ready line, whether or not the flow passed (spec 6.4). The log oracles: a new log line
 * holding the normalized evidence. Both compare lines cleaned as the gate showed them, since the explorer quotes
 * those. The rest: the flow failed, unless only its driver failed to start.
 */
const flowFailure = (oracle: FindingFile['finding']['oracle'], run: FlowRun) => {
  if (oracle.type === 'layout') {
    const quoted = /\[qa-layout\] (?!ready\b).*/.exec(cleanLogLine(oracle.evidence))?.[0].trim()
    const seen = quoted && run.layout.some((line) => cleanLogLine(line) === quoted)
    return seen ? `the layout probe logged ${quoted}` : undefined
  }
  if (logOracles.has(oracle.type)) {
    const quoted = signature(fromConsoleMark(oracle.evidence))
    const line = quoted ? run.logs.find((log) => normalize(fromConsoleMark(log)).includes(quoted)) : undefined
    return line && `logged during the run: ${cleanLogLine(line)}`
  }
  if (run.passed || run.error?.includes(driverTimeout)) return undefined
  return run.error ?? 'the flow failed'
}

/** A device to run flows on, and the number of its next run, so no run's video overwrites another's. */
type Device = { runFlow: RunFlow; outDir: string; next: () => number }

/**
 * Runs a checked flow three times. A run whose driver did not start is run once more and only the second try counts.
 * `failure` says what in a run counts as failed.
 */
const threeRuns = async (
  { runFlow, outDir, next }: Device,
  yaml: string,
  session: string,
  failure: (run: FlowRun) => string | undefined,
) => {
  const runOnce = async () => {
    const first = await runFlow(yaml, outDir, next(), session)
    return first.error?.includes(driverTimeout) ? runFlow(yaml, outDir, next(), session) : first
  }
  const outcome: Outcome = { replay: { failed: 0, runs: 0 }, artifacts: {} }
  for (let n = 0; n < 3; n++) {
    const run = await runOnce()
    outcome.replay.runs++
    const problem = failure(run)
    if (problem === undefined) continue
    outcome.replay.failed++
    outcome.replay.error ??= problem.slice(0, 1_500)
    outcome.artifacts.video ??= run.video
  }
  return outcome
}

/** Counts runs from 1. */
const counter = () => {
  const state = { n: 0 }
  return () => ++state.n
}

/**
 * Runs `control/stack.yaml` three times, then each finding's checked flow three times, on fresh installs. A failed
 * control run stops the replay: the findings never run and `stackProblem` says why.
 */
const replayFlows = async (outDir: string, qaDir: string, flows: Map<FindingFile, string>, runFlow: RunFlow) => {
  const device: Device = { runFlow, outDir, next: counter() }
  const control = await Bun.file(join(qaDir, 'control/stack.yaml')).text()
  for (const appId of new Set([...flows.keys()].map(appIdOf))) {
    const check = checkMaestroFlow(control, { appId, vars: flowVars })
    if (!check.ok) throw new Error(`control/stack.yaml: ${check.problems.join('; ')}`)
    const { replay } = await threeRuns(device, check.yaml, 'control', (run) =>
      run.passed ? undefined : (run.error ?? 'the flow failed'),
    )
    if (replay.failed > 0) {
      return {
        stackProblem: `control flow failed ${replay.failed}/${replay.runs} runs: ${replay.error}`,
        outcomes: new Map<FindingFile, Outcome>(),
      }
    }
  }
  const outcomes = new Map<FindingFile, Outcome>()
  for (const [file, yaml] of flows) {
    outcomes.set(file, await threeRuns(device, yaml, file.charterDir, (run) => flowFailure(file.finding.oracle, run)))
  }
  return { stackProblem: undefined, outcomes }
}

/** `native.sh verify-run`'s result for one patch on one platform (spec 7.2), as `qa-out/fix/<fp>.verify.json` reads. */
export type NativeVerify = {
  fp: string
  platform: string
  runs: number
  failed: number
  passed: boolean
  /** Why the first failed run with the patch failed. */
  error?: string
  failsWithout?: boolean
  passesWith?: boolean
}

/** What fails a run of the fix agent's visual check, which has no finding: only its own Maestro assertions. */
const checkFailure = (run: FlowRun) =>
  run.passed || run.error?.includes(driverTimeout) ? undefined : (run.error ?? 'the flow failed')

/** The oracles whose evidence arrives through the WebView log, with the probe's ready line. */
const webviewOracles = new Set(['layout', 'console-error', 'page-error'])

type Oracle = FindingFile['finding']['oracle']

/**
 * The native half of a fix's verification (spec 7.2), run with no key on the platform's runner. The flow passes the
 * allow list, then runs three times on the patched app, where a run fails when the flow fails or shows the bug: the
 * finding's `oracle` by the replay's rule, or for the fix agent's visual check (no oracle) its own assertions. A run
 * whose driver never started counts as failed, and so does a run without the probe's ready line when the oracle reads
 * the WebView log (a dead stream or a silenced probe shows no bug either). `passed` needs every run clean.
 * With `original` the flow also runs three times on the app without the patch, where every run must show the bug
 * (`failsWithout`, a driver that did not start never counting); `passed` then needs both. A visual check needs it, and
 * so does a real-AI session: verified here on the fake AI, its flow must fail there without the patch to prove
 * anything.
 */
export const verifyNativeFix = async (
  opts: { fp: string; platform: string; session: string; flow: string; outDir: string; patched: RunFlow } & (
    | { oracle: Oracle; original?: RunFlow }
    | { oracle?: undefined; original: RunFlow }
  ),
): Promise<NativeVerify> => {
  const { fp, platform, session, outDir, oracle, original } = opts
  if (!original && realAiCharters.has(session))
    throw new Error(`${session} is a real-AI session: pass the original app`)
  const check = checkMaestroFlow(opts.flow, { appId: platformOf(platform).appId ?? '', vars: flowVars })
  if (!check.ok) throw new Error(`the flow fails the Maestro allow list: ${check.problems.join('; ')}`)
  const next = counter()
  const bug = oracle ? (run: FlowRun) => flowFailure(oracle, run) : checkFailure
  const silent = (run: FlowRun) =>
    oracle && webviewOracles.has(oracle.type) && !run.layout.some((line) => /\[qa-layout\] ready\b/.test(line))
      ? 'the layout probe never reported ready'
      : undefined
  const patched = await threeRuns(
    { runFlow: opts.patched, outDir, next },
    check.yaml,
    session,
    (run) => bug(run) ?? silent(run) ?? (run.passed ? undefined : (run.error ?? 'the flow failed')),
  )
  const { failed, runs, error } = patched.replay
  const result = { fp, platform, runs, failed, passed: failed === 0, error }
  if (!original) return result
  const unpatched = await threeRuns({ runFlow: original, outDir, next }, check.yaml, session, bug)
  const failsWithout = unpatched.replay.failed === unpatched.replay.runs
  return { ...result, failsWithout, passesWith: result.passed, passed: failsWithout && result.passed }
}

/**
 * The oracle a fix's flow is verified against. A flow in `<qa-out>/<session>/repro/` is a confirmed finding's repro
 * flow: its oracle comes from `<qa-out>/verified.json`, the evidence replay confirmed before any cleaning for a ticket,
 * and any other flow there throws. A flow elsewhere (`<qa-out>/fix-<fp>/repro/check.yaml`) is the fix agent's visual
 * check, which has none.
 */
export const oracleOf = async (flow: string, session: string): Promise<Oracle | undefined> => {
  const outDir = resolve(flow, '../../..')
  if (relative(outDir, flow) !== join(session, 'repro', basename(flow))) return undefined
  const { confirmed }: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const found = confirmed.find(
    (v) =>
      v.charterDir === session &&
      v.finding.repro_flow !== undefined &&
      resolve(outDir, session, v.finding.repro_flow) === resolve(flow),
  )
  if (!found) throw new Error(`${flow} is not the repro flow of a confirmed finding of ${session}`)
  return found.finding.oracle
}

/** Failed runs that confirm a finding: all of them, or two in three for a real-AI charter, whose replies vary. */
const confirmingFailures = (file: FindingFile, runs: number) =>
  realAiCharters.has(file.charterDir) ? Math.ceil((runs * 2) / 3) : runs

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
 * Verify step 1: schema, oracle, spec lint, then one Playwright run replaying the surviving specs three times each,
 * up to `replayCap` findings (the rest are `deferred`). A finding that does not fit its session dir (`sessionProblem`:
 * the dir, not the model's fields, picks spec or flow) is dropped at gate `schema`.
 * A spec asserts the expected behaviour, so failed 3/3 = confirmed, 1–2 = flaky, 0 = dropped. A real-AI charter's
 * findings replay against the real providers, so 2/3 confirms them and only 1/3 is flaky. The same run replays
 * `.github/qa/control/stack.spec.ts`; if any of its runs fails, the stack is broken, no replayed finding is confirmed
 * and `stack_unhealthy` says why. A spec that fails to load stops the whole Playwright run, so such specs are dropped
 * at gate `lint` and the rest replay again without them. A `visual` finding has no spec and takes no place under the
 * cap: it is confirmed when `screenshotProblem` finds nothing wrong with its screenshot, and dropped at gate `lint`
 * otherwise, whatever the stack's health. A native finding's `repro_flow` passes the Maestro allow list instead
 * (`checkMaestroFlow`, with `${EMAIL}` as its only variable) and runs three times through `runFlow`, after
 * `control/stack.yaml` passed three times; `flowFailure` says what counts as the bug in a run. Both share the cap and
 * the confirmation rule, and any failed control marks the stack unhealthy. Writes and returns
 * `<outDir>/candidates.json`.
 * Needs NO secrets and must run without any: the specs and flows were written by a model that read untrusted pages,
 * and the lints are defence in depth, not the boundary.
 */
export const replay = async (
  outDir: string,
  runReplay: RunReplay = runPlaywright,
  qaDir = '.github/qa',
  runFlow?: RunFlow,
) => {
  const { valid, rejected } = await loadFindings(outDir)
  const noise = await readList(join(qaDir, 'noise.txt'))
  const result: Verified = {
    confirmed: [],
    flaky: [],
    observations: [],
    dropped: rejected.map((file) => ({ file, gate: 'schema', reason: file.reason })),
  }
  const lintClean: FindingFile[] = []
  // The flow each lint-clean native finding replays: our own serialization of it, never the model's text.
  const flows = new Map<FindingFile, string>()
  for (const file of valid) {
    const misfit = sessionProblem(file)
    if (misfit) {
      result.dropped.push({ file, gate: 'schema', reason: misfit })
      continue
    }
    const { oracle } = file.finding
    const isNoise = oracle.type === 'console-error' && noise.some((line) => oracle.evidence.includes(line))
    if (!hasOracle(file.finding) || isNoise) {
      result.observations.push(file)
      continue
    }
    if (oracle.type === 'visual') {
      const reason = await screenshotProblem(outDir, file)
      if (reason) result.dropped.push({ file, gate: 'lint', reason })
      else {
        const screenshot = relative(process.cwd(), screenshotPath(outDir, file))
        result.confirmed.push({ ...file, replay: { failed: 0, runs: 0 }, artifacts: { screenshot } })
      }
      continue
    }
    if (file.finding.repro_flow) {
      const flow = Bun.file(flowPath(outDir, file))
      const check = (await flow.exists())
        ? checkMaestroFlow(await flow.text(), { appId: appIdOf(file), vars: flowVars })
        : { ok: false as const, problems: ['repro flow not found'] }
      if (!check.ok) result.dropped.push({ file, gate: 'lint', reason: check.problems.join('; ') })
      else {
        flows.set(file, check.yaml)
        lintClean.push(file)
      }
      continue
    }
    const spec = Bun.file(join(outDir, specPath(file)))
    const problems = (await spec.exists()) ? lintReproSpec(await spec.text()) : ['repro spec not found']
    if (problems.length > 0) result.dropped.push({ file, gate: 'lint', reason: problems.join('; ') })
    else lintClean.push(file)
  }
  // ponytail: the first findings in path order fill the cap; rank by severity if a capped run ever loses a bad one.
  const replayable = lintClean.slice(0, replayCap)
  result.deferred = lintClean
    .slice(replayCap)
    .map((file) => ({ file, step: 'replay' as const, reason: `over the cap of ${replayCap} replayed findings` }))

  const specFiles = replayable.filter((file) => !flows.has(file))
  const replayedFlows = new Map([...flows].filter(([file]) => replayable.includes(file)))
  if (replayedFlows.size > 0 && !runFlow) throw new Error('findings with a repro_flow need a device: pass --native')
  const noRuns = { replay: { failed: 0, runs: 0 }, artifacts: {} }
  const outcomes = new Map<FindingFile, Outcome>()
  const stackProblems: string[] = []
  // Never start Playwright without a filter: it would run every spec, including the ones the lint rejected.
  if (specFiles.length > 0) {
    const control = resolve(qaDir, 'control/stack.spec.ts')
    const specOf = (file: FindingFile) => resolve(outDir, specPath(file))
    const specs = [...new Set(specFiles.map(specOf))]
    const first = await runReplay([control, ...specs], outDir)
    const broken = first.errors.length > 0 ? await loadErrors(specs, outDir, runReplay) : new Map<string, string>()
    const report =
      broken.size > 0 ? await runReplay([control, ...specs.filter((spec) => !broken.has(spec))], outDir) : first
    const bySpec = outcomesBySpec(report)
    const problem = stackProblem((bySpec.get(control) ?? noRuns).replay, report)
    if (problem) stackProblems.push(problem)
    for (const file of specFiles) {
      const loadError = broken.get(specOf(file))
      if (loadError) result.dropped.push({ file, gate: 'lint', reason: `failed to load: ${loadError}` })
      else outcomes.set(file, bySpec.get(specOf(file)) ?? noRuns)
    }
  }
  if (replayedFlows.size > 0 && runFlow) {
    const native = await replayFlows(outDir, qaDir, replayedFlows, runFlow)
    if (native.stackProblem) stackProblems.push(native.stackProblem)
    for (const file of replayedFlows.keys()) outcomes.set(file, native.outcomes.get(file) ?? noRuns)
  }
  result.stack_unhealthy = stackProblems.length > 0 ? stackProblems.join('; ') : undefined
  for (const file of replayable) {
    const outcome = outcomes.get(file)
    if (!outcome) continue
    const replayed = { ...file, ...outcome }
    const { failed, runs } = replayed.replay
    if (result.stack_unhealthy) result.dropped.push({ file: replayed, gate: 'replay', reason: 'stack unhealthy' })
    else if (failed === 0) result.dropped.push({ file: replayed, gate: 'replay', reason: `failed 0/${runs} replays` })
    else if (failed >= confirmingFailures(file, runs)) result.confirmed.push(replayed)
    else result.flaky.push(replayed)
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

type Prompt = { candidate: VerifiedFinding; content: Anthropic.MessageParam['content']; cost: number }

/**
 * Verify step 2: one fresh model call per confirmed candidate, seeing only the finding (with its oracle evidence),
 * its spec or flow and its replay failure (a `visual` finding's screenshot instead), and `.github/qa/known-issues.md`.
 * Kept → `confirmed`, otherwise `dropped` at gate `judge`; flaky candidates are never judged. At most `judgeCap`
 * calls, admitted in order only while their worst-case cost fits under `judgeCeilingUsd`; the rest are `deferred`.
 * Writes and returns `<outDir>/verified.json`. Needs `ANTHROPIC_API_KEY` and nothing else.
 */
export const judge = async (outDir: string, create: CreateMessage = createMessage, qaDir = '.github/qa') => {
  const candidates: Verified = await Bun.file(join(outDir, 'candidates.json')).json()
  const system = `${await Bun.file(join(qaDir, 'judge.md')).text()}\n\n${await Bun.file(join(qaDir, 'known-issues.md')).text()}`
  const prompts = await Promise.all(
    candidates.confirmed.map(async (candidate): Promise<Prompt> => {
      const finding = `<finding>\n${JSON.stringify(candidate.finding, null, 2)}\n</finding>`
      if (candidate.finding.oracle.type === 'visual') {
        const path = screenshotPath(outDir, candidate)
        const bytes = await readFile(path)
        // Replay already dropped anything else, so this only fails on a screenshot changed after replay.
        const mediaType = imageInfo(bytes)?.mediaType
        if (!mediaType) throw new Error(`not a PNG or JPEG image: ${path}`)
        const image: Anthropic.ImageBlockParam = {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
        }
        const content = [image, { type: 'text' as const, text: finding }]
        return { candidate, content, cost: worstJudgeCost(system, finding, 1) }
      }
      const [tag, repro] = candidate.finding.repro_flow
        ? ['repro_flow', await ranFlow(outDir, candidate)]
        : ['repro_spec', await Bun.file(join(outDir, specPath(candidate))).text()]
      const user =
        `${finding}\n\n<${tag}>\n${repro}\n</${tag}>\n\n` +
        `<replay_failure>\n${candidate.replay.error ?? '(no message recorded)'}\n</replay_failure>`
      return { candidate, content: user, cost: worstJudgeCost(system, user) }
    }),
  )
  const toJudge: typeof prompts = []
  const deferred = [...(candidates.deferred ?? [])]
  let worstTotal = 0
  for (const prompt of prompts) {
    if (toJudge.length < judgeCap && worstTotal + prompt.cost <= judgeCeilingUsd) {
      toJudge.push(prompt)
      worstTotal += prompt.cost
    } else {
      const reason =
        toJudge.length < judgeCap
          ? `over the judge's spend ceiling of $${judgeCeilingUsd}`
          : `over the cap of ${judgeCap} judged findings`
      deferred.push({ file: prompt.candidate, step: 'judge', reason })
    }
  }
  const judged = await Promise.all(
    toJudge.map(async ({ candidate, content }) => {
      const response = await create({
        model: judgeModel,
        max_tokens: judgeMaxTokens,
        system,
        output_config: { effort: 'medium', format: zodOutputFormat(verdictSchema) },
        messages: [{ role: 'user', content }],
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
    deferred,
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
    options: {
      out: { type: 'string', default: 'qa-out' },
      native: { type: 'string' },
      device: { type: 'string' },
      app: { type: 'string' },
      'app-onboarding': { type: 'string' },
      fp: { type: 'string' },
      flow: { type: 'string' },
      session: { type: 'string' },
      result: { type: 'string' },
      original: { type: 'string' },
      leg: { type: 'string' },
    },
    allowPositionals: true,
  })
  const step = positionals[0]
  const usage =
    'usage: bun .github/qa/scripts/verify.ts replay|judge --out qa-out ' +
    '[--native ios|android --device <id> --app <app> --app-onboarding <app> [--leg <name>]] | ' +
    'fix-native --out <dir> --native ios|android --device <id> --app <patched app> --fp <fp> --flow <flow> ' +
    '--session <session> --result <json> [--original <app>], with QA_WEBVIEW_LOG and QA_BACKEND_LOG set for --native'
  if (step !== 'replay' && step !== 'judge' && step !== 'fix-native') throw new Error(usage)
  const nativeFlows = (app = values.app, onboarding = values['app-onboarding']) => {
    const { native: platform, device } = values
    const { QA_WEBVIEW_LOG: webviewLog, QA_BACKEND_LOG: backendLog } = Bun.env
    if (platform !== 'ios' && platform !== 'android') throw new Error(`--native must be ios or android: ${platform}`)
    if (!device || !app || !onboarding || !webviewLog || !backendLog) {
      throw new Error('--native needs --device, --app, --app-onboarding, QA_WEBVIEW_LOG and QA_BACKEND_LOG')
    }
    return createRunFlow({
      platform,
      deviceId: device,
      apps: { onboarding, plain: app },
      webviewLog,
      backendLog,
      leg: values.leg,
    })
  }
  if (step === 'fix-native') {
    const { fp, flow, session, result: resultFile, original, native: platform, app } = values
    if (!fp || !flow || !session || !resultFile || !platform) throw new Error(usage)
    // One build per check: native.sh builds the patched app in the variant the session needs.
    const unpatched = original ? nativeFlows(original, original) : undefined
    const oracle = await oracleOf(flow, session)
    const proof = oracle ? { oracle, original: unpatched } : unpatched && { original: unpatched }
    if (!proof) throw new Error('a visual check needs --original, the app without the patch')
    const verdict = await verifyNativeFix({
      fp,
      platform,
      session,
      flow: await Bun.file(flow).text(),
      outDir: values.out,
      patched: nativeFlows(app, app),
      ...proof,
    })
    await Bun.write(resultFile, JSON.stringify(verdict, null, 2))
    console.log(JSON.stringify(verdict))
    process.exit()
  }
  const result =
    step === 'judge'
      ? await judge(values.out)
      : await replay(values.out, undefined, undefined, values.native === undefined ? undefined : nativeFlows())
  console.log(
    `confirmed ${result.confirmed.length}, flaky ${result.flaky.length}, ` +
      `observations ${result.observations.length}, dropped ${result.dropped.length}, ` +
      `deferred ${result.deferred?.length ?? 0}`,
  )
  if (result.stack_unhealthy) {
    console.error(`Stack unhealthy, no replayed finding confirmed. The ${result.stack_unhealthy}`)
    process.exitCode = 1
  }
}
