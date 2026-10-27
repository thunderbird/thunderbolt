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
  bugStep,
  bugStepProblems,
  hasOracle,
  lintReproSpec,
  loadFindings,
  normalize,
  parseSession,
  platformOf,
  realAiCharters,
  reproFlowFile,
  screenshotFile,
  sessionProblem,
  signature,
  type FindingFile,
  type RejectedFile,
} from './findings'
import { checkMaestroFlow, flowVars, maestroEnv } from './maestro-flow'
import { createRunFlow } from './replay-native'
import { cleanLogLine } from './sanitize'
import type { TranscriptMessage } from './report'

export type VerifiedFinding = FindingFile & {
  /**
   * `error`: the first failed run's error message, shown to the judge. A visual finding never replays: 0/0.
   * `inconclusive`: runs that never reached the bug, which `runs` leaves out: a web run that failed outside the spec's
   * `bug check` step, or a native run whose first part (sign-in, and the steps before the bug's assertion) failed, or
   * whose layout or log-oracle flow failed without the quoted line.
   * `reason`: why too few runs counted to decide, which makes the finding flaky.
   */
  replay: { failed: number; runs: number; error?: string; inconclusive?: number; reason?: string }
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
/** A `test.step`. `duration` is -1 when the test ended (a timeout) while the step still ran. */
type ReplayStep = { title: string; duration: number; error?: unknown; steps?: ReplayStep[] }
type ReplaySuite = {
  specs: {
    file: string
    tests: {
      results: {
        status?: string
        errors: { message: string }[]
        attachments: { name: string; path?: string }[]
        steps?: ReplayStep[]
      }[]
    }[]
  }[]
  suites?: ReplaySuite[]
}
/** Runs the given specs (absolute paths) three times each in one Playwright run, or with `list` only loads them. */
export type RunReplay = (specs: string[], outDir: string, opts?: { list?: boolean }) => Promise<ReplayReport>

/**
 * One run of a Maestro flow on a device. `layout`: the probe's `[qa-layout]` lines in the WebView log during the run,
 * each from `[qa-layout]` on. `logs`: every other new line of the WebView and backend logs, as `webview: <line>` or
 * `backend: <line>`. `video`: the run's recording. `signInFailed`: the steps run first (`NativeFlow`'s `signIn`)
 * failed, so the flow never ran.
 */
export type FlowRun = {
  passed: boolean
  error?: string
  video?: string
  layout: string[]
  logs: string[]
  signInFailed?: boolean
}
/**
 * Runs a checked flow on a freshly installed app. `run` is unique within one replay; `session` is the finding's
 * session dir, which picks the build (onboarding on for c1). `signIn`, a checked flow too, runs first in the same
 * launch, and the flow runs only when it passed.
 */
export type RunFlow = (
  flowYaml: string,
  outDir: string,
  run: number,
  session: string,
  signIn?: string,
) => Promise<FlowRun>

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
/** replay-native's `timeout-minutes`: a native leg starts no run that might end after it. */
export const nativeJobMinutes = 130
/**
 * Run 40534656266 on iOS: 4.04 minutes on average for the 14 runs after the leg's cold first one, and 6 min 21 s
 * before the replay step. Only the cap's sizing uses these; `legClock` times the real runs from `QA_LEG_START`.
 */
export const nativeRunMinutes = 4.1
export const nativeSetupMinutes = 6.5
/** Kept for the steps after the replay: the sanitize and the 220 MB upload took 56 s in run 40534656266. */
export const nativeWrapUpMinutes = 2
/** Kept free at the end of a leg's time: on iOS a run whose driver did not start waits this long, then runs again. */
export const nativeDriverStartupMinutes = Number(maestroEnv().MAESTRO_DRIVER_STARTUP_TIMEOUT) / 60_000
// (3 control + 4 × 6 runs) × 4.1 min + 6.5 setup + 2 wrap-up + 3 driver = 122 min, and the cold first run's extra
// 5 minutes, inside nativeJobMinutes.
export const nativeReplayCap = 4
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
export const replayEnv = (outDir: string, env: Record<string, string | undefined> = Bun.env) => ({
  PATH: Bun.env.PATH,
  HOME: Bun.env.HOME,
  CI: Bun.env.CI,
  PLAYWRIGHT_BROWSERS_PATH: Bun.env.PLAYWRIGHT_BROWSERS_PATH,
  // A failed replay would otherwise write the page's aria snapshot (it can hold typed field values) into error-context.md.
  PLAYWRIGHT_NO_COPY_PROMPT: '1',
  QA_OUT: outDir,
  // The Playwright config and the c1 specs read the stack's frontends from these.
  QA_FRONTEND_PORT: env.QA_FRONTEND_PORT,
  QA_ONBOARDING_PORT: env.QA_ONBOARDING_PORT,
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

/** Whether the run failed inside the `bugStep` step: the step holds an error, or the test timed out while it ran. */
const failedInBugStep = (steps: ReplayStep[]): boolean =>
  steps.some(
    (step) =>
      (step.title === bugStep && (step.error !== undefined || step.duration === -1)) ||
      failedInBugStep(step.steps ?? []),
  )

/**
 * Failed and total runs per spec file (absolute path), with the error, video and trace of the first failed run that
 * reached the bug step, or of the first failed run when none did.
 * Every test in the file counts, so a file is confirmed only if all of its runs failed. A run that failed outside the
 * `bugStep` step never reached the bug: it is `inconclusive` and left out of `runs` (`withUnreachedReason` decides).
 */
const outcomesBySpec = (report: ReplayReport) => {
  const outcomes = new Map<string, Pick<VerifiedFinding, 'replay' | 'artifacts'>>()
  for (const spec of allSpecs(report.suites)) {
    const file = resolve(report.config.rootDir, spec.file)
    const outcome = outcomes.get(file) ?? { replay: { failed: 0, runs: 0 }, artifacts: {} }
    for (const result of spec.tests.flatMap((test) => test.results)) {
      if (result.status === 'skipped') continue
      const failed = result.status === 'failed' || result.status === 'timedOut'
      const reached = !failed || failedInBugStep(result.steps ?? [])
      if (reached) outcome.replay.runs++
      else outcome.replay.inconclusive = (outcome.replay.inconclusive ?? 0) + 1
      if (!failed) continue
      if (reached) outcome.replay.failed++
      // The judge reads a stuck sign-in as a bad locator, so a run that reached the bug replaces an unreached one's.
      if (reached && outcome.replay.failed === 1) {
        outcome.replay.error = undefined
        outcome.artifacts = {}
      }
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

/**
 * A web finding's outcome with a `reason`, which makes it flaky, when runs that never reached the bug step leave too
 * few failures to confirm it. Playwright runs no replacement, so the bar is the one for three runs: a real-AI
 * finding with two failures in the step and one sign-in flake is still confirmed.
 */
const withUnreachedReason = (file: FindingFile, outcome: Outcome): Outcome => {
  const { failed, runs, inconclusive } = outcome.replay
  if (!inconclusive || failed >= confirmingFailures(file, runs + inconclusive)) return outcome
  const reason = `${inconclusive} of ${inconclusive + runs} runs failed before the ${bugStep} step`
  return { ...outcome, replay: { ...outcome.replay, reason } }
}

const specPath = (file: FindingFile) => `${file.charterDir}/${file.finding.repro_spec}`

/** The app a native finding's flow drives. `sessionProblem` keeps flows to native platforms, which all name one. */
const appIdOf = (file: FindingFile) => {
  const { appId } = platformOf(file.finding.viewport)
  if (!appId) throw new Error(`platforms.json has no app for ${file.finding.viewport}`)
  return appId
}

const signInFile = join(import.meta.dir, '../control/sign-in.yaml')
const typesSignInCode = /"inputText":(\{"text":)?"12345678"/
const commandList = z.array(z.unknown())
const shownText = z.union([z.string(), z.object({ text: z.string() }).transform(({ text }) => text)])
/** The text a command waits for or asserts, as `extendedWaitUntil.visible` or `assertVisible`. */
const awaitedText = z.union([
  z.object({ extendedWaitUntil: z.object({ visible: shownText }) }).transform((c) => c.extendedWaitUntil.visible),
  z.object({ assertVisible: shownText }).transform((c) => c.assertVisible),
])

/** The first screen after sign-in: onboarding's welcome on the c1 build, the chat on the plain one. */
const landingOf = (session: string) =>
  session.startsWith('c1-first-run-') ? 'Welcome to Thunderbolt!' : 'Ask me anything…'

/** The commands of a flow `checkMaestroFlow` serialized, after its header. */
const commandsOf = (yaml: string) => commandList.parse(Bun.YAML.parse(yaml.slice(yaml.indexOf('\n---\n') + 5)))

const selector = z.union([z.string(), z.record(z.string(), z.unknown())])
const assertion = z.union([z.object({ assertVisible: selector }), z.object({ assertNotVisible: selector })])
/**
 * Whether a checked flow's last top-level command is `assertVisible` or `assertNotVisible`. A `layout` flow must stop
 * on the screen (drivers/maestro.md); a trailing wait for the screen's text is how it gets there, so it passes.
 */
const endsOnAssertion = (yaml: string) => assertion.safeParse(commandsOf(yaml).at(-1)).success

/**
 * Whether a failed flow is the oracle's bug: every oracle but `layout` and the log oracles, and the fix agent's visual
 * check (no oracle), whose own final assertion is the bug.
 */
const failureIsBug = (oracle: Oracle | undefined) =>
  oracle === undefined || (oracle.type !== 'layout' && !logOracles.has(oracle.type))

const waitsFor = z.object({ extendedWaitUntil: z.unknown() })
const settle = z.union([z.literal('waitForAnimationToEnd'), z.object({ waitForAnimationToEnd: z.unknown() })])
/**
 * Whether a failure-oracle flow's last command after its settles is a plain `assertVisible` or `assertNotVisible`, or
 * for `stuck` an `extendedWaitUntil`. Replay splits there, so a block (`runFlow`, `retry`) would put the whole way to
 * the bug back in the part whose failure confirms it.
 */
const endsOnBugAssertion = (yaml: string, oracle: Oracle | undefined) => {
  const last = commandsOf(yaml).findLast((command) => !settle.safeParse(command).success)
  return assertion.safeParse(last).success || (oracle?.type === 'stuck' && waitsFor.safeParse(last).success)
}

/**
 * A native flow as a device runs it. `signIn`, when set, runs first in the same launch: the harness's sign-in, and for
 * an oracle whose bug is a failed flow, every step before the bug's assertion. A failure there is never the bug.
 */
type NativeFlow = { yaml: string; signIn?: string }

/** Our own serialization of commands that passed the allow list once already, or of the harness's own file. */
const serialize = (commands: unknown[], appId: string) => {
  const check = checkMaestroFlow(Bun.YAML.stringify(commands), { appId, vars: flowVars })
  if (!check.ok) throw new Error(`the signed-in flow fails the allow list: ${check.problems.join('; ')}`)
  return check.yaml
}

const consentFile = join(import.meta.dir, '../control/consent.yaml')

/** Where a flow waits for the first screen after sign-in, three dots matching the chat's ellipsis; -1 if it never does. */
const landingIndex = (commands: unknown[], session: string) =>
  commands.findIndex((command) => awaitedText.safeParse(command).data?.replaceAll('...', '…') === landingOf(session))

const gated = z.object({ runFlow: z.looseObject({ when: z.looseObject({}) }) })

/**
 * The text a flow relies on after command `at`: what its next command waits for or asserts, or, when it stops there,
 * the element a layout finding quotes. Undefined when the next command acts instead, or there is no usable text. An
 * unnamed control's quote says which control it is, which is not text on the screen.
 */
const reliedOnText = (commands: unknown[], at: number, oracle: Oracle | undefined) => {
  const next = commands.slice(at + 1).find((command) => !settle.safeParse(command).success)
  const text =
    next === undefined
      ? oracle?.type === 'layout' && !/\] unnamed-control /.test(oracle.evidence)
        ? /"(.+)"\s*$/.exec(oracle.evidence.trim())?.[1]
        : undefined
      : awaitedText.safeParse(next).data
  return text?.includes('${') ? undefined : text
}

/**
 * Splits a c1 flow after its wait for the welcome screen (or after the code) so the sign-in step ends with
 * `control/consent.yaml`, which runs only while the privacy checkbox shows and the text the flow relies on next
 * does not. Undefined when nothing needs splitting.
 */
const consentSplit = async (flow: unknown[], session: string, oracle: Oracle | undefined) => {
  if (!session.startsWith('c1-first-run-')) return undefined
  const landed = landingIndex(flow, session)
  const at = landed >= 0 ? landed : flow.findIndex((command) => typesSignInCode.test(JSON.stringify(command)))
  const text = at < 0 ? undefined : reliedOnText(flow, at, oracle)
  if (text === undefined) return undefined
  const consent = commandList.parse(Bun.YAML.parse(await Bun.file(consentFile).text())).map((step) => {
    const block = gated.safeParse(step).data?.runFlow
    return block ? { runFlow: { ...block, when: { ...block.when, notVisible: text } } } : step
  })
  // Maestro refuses a flow without commands, and the flow may end at the split.
  const rest = flow.slice(at + 1)
  return { signIn: [...flow.slice(0, at + 1), ...consent], flow: rest.length > 0 ? rest : ['waitForAnimationToEnd'] }
}

/**
 * A checked native flow, signed in by the harness when it waits for the first screen after sign-in without ever
 * typing the code, as every iOS flow of run 39391108579 did. `signIn` is then `control/sign-in.yaml` and a wait for
 * that screen, and the flow goes on from its own wait, its partial sign-in before it left out. The two run one after
 * the other in one app launch, so a failed sign-in is the harness's and never the finding's. Any other flow, a bug on
 * the sign-in screen among them, runs as written. A c1 flow that expects onboarding past the privacy step has the
 * harness's way through it added to the sign-in step (`consentSplit`), so a failure there never proves a bug either.
 * When the oracle makes a failed flow the bug, the flow's own steps up to its last command that is not a settle join
 * that first step too, so only a failure of that command, the bug's assertion, can prove the bug. `apart: false`
 * keeps them in the flow, for a patched run, where a failure anywhere in the flow fails the patch.
 */
const withSignIn = async (
  yaml: string,
  session: string,
  appId: string,
  oracle: Oracle | undefined,
  apart = true,
): Promise<NativeFlow> => {
  const commands = commandsOf(yaml)
  const from = landingIndex(commands, session)
  const harness = from >= 0 && !typesSignInCode.test(JSON.stringify(commands))
  const wait = { extendedWaitUntil: { visible: landingOf(session), timeout: 120000 } }
  const signIn = harness ? [...commandList.parse(Bun.YAML.parse(await Bun.file(signInFile).text())), wait] : []
  const flow = harness ? commands.slice(from) : commands
  const split = await consentSplit(flow, session, oracle)
  const rest = split?.flow ?? flow
  // Where a failure is the bug, only the last command that is not a settle asserts it; everything before only reaches it.
  const assertAt =
    apart && failureIsBug(oracle) ? rest.findLastIndex((command) => !settle.safeParse(command).success) : -1
  const before = [...signIn, ...(split?.signIn ?? []), ...rest.slice(0, Math.max(assertAt, 0))]
  if (before.length === 0) return { yaml }
  return { signIn: serialize(before, appId), yaml: serialize(rest.slice(Math.max(assertAt, 0)), appId) }
}

/**
 * The flow replay ran for a native finding: the allow list's own serialization, never the model's text, after the
 * steps replay ran first when it split them off.
 */
const ranFlow = async (outDir: string, file: FindingFile) => {
  const check = checkMaestroFlow(await Bun.file(flowPath(outDir, file)).text(), {
    appId: appIdOf(file),
    vars: flowVars,
  })
  // Replay already dropped anything else, so this only fails on a flow changed after replay.
  if (!check.ok) throw new Error(`repro flow no longer passes the allow list: ${check.problems.join('; ')}`)
  const { signIn, yaml } = await withSignIn(check.yaml, file.charterDir, appIdOf(file), file.finding.oracle)
  return signIn
    ? `# Run first; a failure here never counts as the bug:\n${signIn}\n# Then, in the same launch:\n${yaml}`
    : yaml
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
 * to the quoted one, never the ready line, whether or not the flow passed; replay sets aside a failed flow
 * without the line as inconclusive (`unreached`). The log oracles: a new log line
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

/**
 * A native leg's time: `fits(n)` says whether n more runs end `nativeWrapUpMinutes` before the job's
 * `nativeJobMinutes` run out, counted from `legStart` (the job's first step, so the setup is counted as it ran),
 * taking a run to last as long as the longest one `time` has seen after the leg's first, and at least
 * `nativeRunMinutes`. The first run is a control run, and the control's other runs are timed before any finding's.
 * It also keeps `nativeDriverStartupMinutes` free, so one run that waits for its driver and runs again still ends
 * in time. Only iOS retries, but an Android leg keeps the same margin rather than the clock knowing the platform.
 */
const legClock = (now: () => number, legStart: number) => {
  const minute = 60_000
  const end = legStart + (nativeJobMinutes - nativeWrapUpMinutes - nativeDriverStartupMinutes) * minute
  const state = { longest: nativeRunMinutes * minute, warm: false }
  return {
    fits: (runs: number) => now() + state.longest * runs <= end,
    time: async <T>(run: () => Promise<T>) => {
      const start = now()
      const result = await run()
      // The first run starts Maestro's driver and the app on a cold device: about 8.5 minutes on iOS in run
      // 40534656266, against 3 to 6 for each of the 14 after it, and sized on it the leg refused a confirming run.
      if (state.warm) state.longest = Math.max(state.longest, now() - start)
      state.warm = true
      return result
    },
  }
}
type LegClock = ReturnType<typeof legClock>

/**
 * A native leg's start in epoch ms from `QA_LEG_START` (epoch seconds), which the job's first step writes so the
 * clock counts the setup the job already spent. Unset, as in a run by hand, the leg starts now; a value that is not a
 * positive number throws.
 */
export const legStartOf = (seconds: string | undefined, now = Date.now()) => {
  if (!seconds) return now
  const ms = Number(seconds) * 1000
  if (!(ms > 0)) throw new Error(`QA_LEG_START must be the epoch second the job started, not ${seconds}`)
  return ms
}

/**
 * A device to run flows on, the number of its next run, so no run's video overwrites another's, and the leg's clock,
 * which times every run.
 */
type Device = { runFlow: RunFlow; outDir: string; next: () => number; clock?: LegClock }

/** Runs past the three that replace inconclusive ones, per finding. */
export const extraRuns = 3

/**
 * A native `layout` or log-oracle run whose flow failed without showing the quoted line: it never reached the screen,
 * so it says nothing about the bug (run 39380764343, where a point tap landed before the screen was ready). For the
 * other oracles `withSignIn` splits off the steps before the bug's assertion instead.
 */
const unreached = (oracle: FindingFile['finding']['oracle']) =>
  oracle.type === 'layout' || logOracles.has(oracle.type)
    ? (run: FlowRun) => !run.passed && flowFailure(oracle, run) === undefined
    : undefined

/**
 * Runs a checked flow three times. A run whose driver did not start is run once more and only the second try counts.
 * `failure` says what in a run counts as failed. A run `inconclusive` marks does not count and is replaced, up to
 * `extraRuns` times, so fewer than three runs may count. With `owed` (the base runs the leg's later findings still
 * need) a run starts only when the clock fits it, and an extra run only when it also fits those, so a slow leg never
 * runs into its timeout and an early finding's reruns never take a later finding's runs. A run whose harness sign-in
 * failed is inconclusive too, whatever the oracle. `reason` then says why fewer than three runs counted.
 */
const threeRuns = async (
  { runFlow, outDir, next, clock }: Device,
  { yaml, signIn }: NativeFlow,
  session: string,
  failure: (run: FlowRun) => string | undefined,
  inconclusive?: (run: FlowRun) => boolean,
  owed?: number,
) => {
  const runOnce = async () => {
    const first = await runFlow(yaml, outDir, next(), session, signIn)
    return first.error?.includes(driverTimeout) ? runFlow(yaml, outDir, next(), session, signIn) : first
  }
  const outcome: Outcome = { replay: { failed: 0, runs: 0 }, artifacts: {} }
  for (let tries = 0; outcome.replay.runs < 3 && tries < 3 + extraRuns; tries++) {
    if (clock && owed !== undefined && !clock.fits(1 + (tries < 3 ? 0 : owed))) {
      outcome.replay.reason = `out of time: another run might not end before the leg's ${nativeJobMinutes}-minute timeout`
      break
    }
    const run = await (clock ? clock.time(runOnce) : runOnce())
    if (run.signInFailed || inconclusive?.(run)) {
      outcome.replay.inconclusive = (outcome.replay.inconclusive ?? 0) + 1
      continue
    }
    outcome.replay.runs++
    const problem = failure(run)
    if (problem === undefined) continue
    outcome.replay.failed++
    outcome.replay.error ??= problem.slice(0, 1_500)
    outcome.artifacts.video ??= run.video
  }
  if (outcome.replay.runs < 3) outcome.replay.reason ??= `only ${outcome.replay.runs} of 3 runs reached the screen`
  return outcome
}

/** Counts runs from 1. */
const counter = () => {
  const state = { n: 0 }
  return () => ++state.n
}

/**
 * Runs `control/stack.yaml` three times, then each finding's checked flow three times, on fresh installs. A failed
 * control run stops the replay: the findings never run and `stackProblem` says why. The findings' runs keep to the
 * leg's `clock`.
 */
const replayFlows = async (
  outDir: string,
  qaDir: string,
  flows: Map<FindingFile, NativeFlow>,
  runFlow: RunFlow,
  clock: LegClock,
) => {
  const device: Device = { runFlow, outDir, next: counter(), clock }
  const control = await Bun.file(join(qaDir, 'control/stack.yaml')).text()
  for (const appId of new Set([...flows.keys()].map(appIdOf))) {
    const check = checkMaestroFlow(control, { appId, vars: flowVars })
    if (!check.ok) throw new Error(`control/stack.yaml: ${check.problems.join('; ')}`)
    const { replay } = await threeRuns(device, { yaml: check.yaml }, 'control', (run) =>
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
  for (const [index, [file, flow]] of [...flows].entries()) {
    const { oracle } = file.finding
    const owed = 3 * (flows.size - 1 - index)
    outcomes.set(
      file,
      await threeRuns(device, flow, file.charterDir, (run) => flowFailure(oracle, run), unreached(oracle), owed),
    )
  }
  return { stackProblem: undefined, outcomes }
}

/** `native.sh verify-run`'s result for one patch on one platform, as `qa-out/fix/<fp>.verify.json` reads. */
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
 * The native half of a fix's verification, run with no key on the platform's runner. The flow passes the
 * allow list, then runs three times on the patched app, where a run fails when the flow fails or shows the bug: the
 * finding's `oracle` by the replay's rule, or for the fix agent's visual check (no oracle) its own assertions. A run
 * whose driver never started counts as failed, and so does a run without the probe's ready line when the oracle reads
 * the WebView log (a dead stream or a silenced probe shows no bug either). A failure anywhere in the flow fails the
 * patched run, before the bug's assertion too: a fix must leave the whole way there working. Only a run whose
 * harness sign-in failed is replaced, as in replay. `passed` needs three counted runs, every one clean.
 * With `original` the flow also runs three times on the app without the patch, where every run must show the bug
 * (`failsWithout`, a driver that did not start never counting); `passed` then needs both. There a run that never
 * reached the bug, by the replay's rules, is replaced and never counts as showing it: for a visual check, which must
 * end on an assertion, a run that failed before that assertion. A visual check needs it, and so does a real-AI
 * session: verified here on the fake AI, its flow must fail there without the patch to prove anything.
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
  const appId = platformOf(platform).appId ?? ''
  const check = checkMaestroFlow(opts.flow, { appId, vars: flowVars })
  if (!check.ok) throw new Error(`the flow fails the Maestro allow list: ${check.problems.join('; ')}`)
  // Its last command is the only one whose failure shows the defect, so it must be an assertion.
  if (!oracle && !endsOnBugAssertion(check.yaml, oracle))
    throw new Error('a visual check must end on assertVisible or assertNotVisible')
  const next = counter()
  const bug = oracle ? (run: FlowRun) => flowFailure(oracle, run) : checkFailure
  const silent = (run: FlowRun) =>
    oracle && webviewOracles.has(oracle.type) && !run.layout.some((line) => /\[qa-layout\] ready\b/.test(line))
      ? 'the layout probe never reported ready'
      : undefined
  const patched = await threeRuns(
    { runFlow: opts.patched, outDir, next },
    await withSignIn(check.yaml, session, appId, oracle, false),
    session,
    (run) => bug(run) ?? silent(run) ?? (run.passed ? undefined : (run.error ?? 'the flow failed')),
  )
  const { failed, runs, error, reason } = patched.replay
  // A run whose harness sign-in failed does not count, so a patch that breaks sign-in cannot pass on no runs.
  const result = { fp, platform, runs, failed, passed: failed === 0 && runs === 3, error: error ?? reason }
  if (!original) return result
  const unpatched = await threeRuns(
    { runFlow: original, outDir, next },
    await withSignIn(check.yaml, session, appId, oracle),
    session,
    bug,
    oracle && unreached(oracle),
  )
  const failsWithout = unpatched.replay.runs === 3 && unpatched.replay.failed === 3
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

/**
 * Why the control spec says the stack is broken, or undefined when it passed every run. It has no `bugStep`, so its
 * failures all count as inconclusive.
 */
const stackProblem = ({ failed, runs, inconclusive = 0, error }: VerifiedFinding['replay'], report: ReplayReport) =>
  runs > 0 && failed + inconclusive === 0
    ? undefined
    : `control spec failed ${failed + inconclusive}/${runs + inconclusive} runs: ${error ?? report.errors[0]?.message ?? 'it did not run'}`

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
 * up to `replayCap` findings, `nativeReplayCap` on a native leg (the rest are `deferred`). A finding that does not
 * fit its session dir (`sessionProblem`: the dir, not the model's fields, picks spec or flow) is dropped at gate
 * `schema`; every other finding takes the dir's platform as its `viewport`.
 * A spec asserts the expected behaviour in its `bugStep` step, which the lint requires, and a run counts as failed only
 * when it failed inside that step. A run that failed before it is inconclusive, and since Playwright runs no
 * replacement, the finding is then flaky unless the other runs confirm it anyway (2 failures for a real-AI charter).
 * Otherwise failed 3/3 = confirmed, 1–2 = flaky, 0 = dropped. A real-AI charter's
 * findings replay against the real providers, so 2/3 confirms them and only 1/3 is flaky. The same run replays
 * `.github/qa/control/stack.spec.ts`; if any of its runs fails, the stack is broken, no replayed finding is confirmed
 * and `stack_unhealthy` says why. A spec that fails to load stops the whole Playwright run, so such specs are dropped
 * at gate `lint` and the rest replay again without them. A `visual` finding has no spec and takes no place under the
 * cap: it is confirmed when `screenshotProblem` finds nothing wrong with its screenshot, and dropped at gate `lint`
 * otherwise, whatever the stack's health. A native finding's `repro_flow` passes the Maestro allow list instead
 * (`checkMaestroFlow`, with `${EMAIL}` as its only variable), is signed in by the harness when it skips the code
 * (`withSignIn`), and runs three times through `runFlow`, after `control/stack.yaml` passed three times;
 * `flowFailure` says what counts as the bug in a run. A `layout` or log-oracle run whose flow failed before the line
 * showed, and for the other oracles a run that failed before the flow's last command, is inconclusive and replaced, at
 * most `extraRuns` times, and no run starts that might end after the leg's timeout,
 * read from `now` against `legStart` (epoch ms, `QA_LEG_START` in CI); with fewer than three conclusive runs the
 * finding is flaky, with the reason in `replay.reason`. A `layout` flow that ends on an assertion is dropped at gate
 * `lint`: it would fail on every run without the line, and each such run would be rerun as inconclusive.
 * Both share the cap and the confirmation rule, and any failed control marks the stack unhealthy. Writes and returns
 * `<outDir>/candidates.json`.
 * Needs NO secrets and must run without any: the specs and flows were written by a model that read untrusted pages,
 * and the lints are defence in depth, not the boundary.
 */
export const replay = async (
  outDir: string,
  runReplay: RunReplay = runPlaywright,
  qaDir = '.github/qa',
  runFlow?: RunFlow,
  now: () => number = Date.now,
  legStart = now(),
) => {
  const clock = legClock(now, legStart)
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
  const flows = new Map<FindingFile, NativeFlow>()
  for (const written of valid) {
    const misfit = sessionProblem(written)
    if (misfit) {
      result.dropped.push({ file: written, gate: 'schema', reason: misfit })
      continue
    }
    // The dir names the platform; in run 39373388149 both native sessions wrote "phone".
    const viewport = parseSession(written.charterDir).platform
    const file = { ...written, finding: { ...written.finding, viewport } }
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
      else if (oracle.type === 'layout' && endsOnAssertion(check.yaml)) {
        result.dropped.push({ file, gate: 'lint', reason: 'a layout flow ends on the screen, with no assertion' })
      } else if (failureIsBug(oracle) && !endsOnBugAssertion(check.yaml, oracle)) {
        const reason = 'the flow does not end on a plain assertVisible or assertNotVisible (a wait, for stuck)'
        result.dropped.push({ file, gate: 'lint', reason })
      } else {
        flows.set(file, await withSignIn(check.yaml, file.charterDir, appIdOf(file), oracle))
        lintClean.push(file)
      }
      continue
    }
    const spec = Bun.file(join(outDir, specPath(file)))
    const source = (await spec.exists()) ? await spec.text() : undefined
    const problems =
      source === undefined ? ['repro spec not found'] : [...lintReproSpec(source), ...bugStepProblems(source)]
    if (problems.length > 0) result.dropped.push({ file, gate: 'lint', reason: problems.join('; ') })
    else lintClean.push(file)
  }
  // ponytail: the first findings in path order fill the cap; rank by severity if a capped run ever loses a bad one.
  const cap = runFlow ? nativeReplayCap : replayCap
  const replayable = lintClean.slice(0, cap)
  result.deferred = lintClean
    .slice(cap)
    .map((file) => ({ file, step: 'replay' as const, reason: `over the cap of ${cap} replayed findings` }))

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
      else outcomes.set(file, withUnreachedReason(file, bySpec.get(specOf(file)) ?? noRuns))
    }
  }
  if (replayedFlows.size > 0 && runFlow) {
    const native = await replayFlows(outDir, qaDir, replayedFlows, runFlow, clock)
    if (native.stackProblem) stackProblems.push(native.stackProblem)
    for (const file of replayedFlows.keys()) outcomes.set(file, native.outcomes.get(file) ?? noRuns)
  }
  result.stack_unhealthy = stackProblems.length > 0 ? stackProblems.join('; ') : undefined
  for (const file of replayable) {
    const outcome = outcomes.get(file)
    if (!outcome) continue
    const replayed = { ...file, ...outcome }
    const { failed, runs, reason } = replayed.replay
    if (result.stack_unhealthy) result.dropped.push({ file: replayed, gate: 'replay', reason: 'stack unhealthy' })
    // Too few runs counted to say either way.
    else if (reason) result.flaky.push(replayed)
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
      : values.native === undefined
        ? await replay(values.out)
        : await replay(values.out, undefined, undefined, nativeFlows(), Date.now, legStartOf(Bun.env.QA_LEG_START))
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
