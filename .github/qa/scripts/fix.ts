#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { linear } from '../../../scripts/notify-on-failure'
import { type Action, addComment, type Filed, type LinearAuth, priority, qaLabels, ticketView } from './file-findings'
import { sanitize, secretPattern } from './sanitize'
import {
  type Finding,
  findingSchema,
  lintReproSpec,
  nativePlatformIds,
  parseSession,
  platformOf,
  realAiCharters,
} from './findings'
import { onboardingSession, syncSession } from './legs'
import { checkMaestroFlow, flowVars } from './maestro-flow'
import type { Verified } from './verify'

const ticketActions = new Set<Action | undefined>(['created', 'regression', 'commented'])
const maxFixes = 3

/**
 * Dependency manifests and lockfiles, in any folder, with the build-tool and toolchain files that pick a registry,
 * a download or a binary every build runs (Gradle wrapper, `bunfig.toml`, `.cargo/config`, `rust-toolchain`).
 */
const dependencyFiles = new RegExp(
  `(^|/)(${[
    String.raw`package\.json|bun\.lockb?|Cargo\.(toml|lock)|[^/]+\.gradle(\.kts)?|Podfile[^/]*|Package\.(resolved|swift)`,
    String.raw`requirements[^/]*\.txt|go\.(mod|sum)|Gemfile[^/]*|gradle-wrapper\.(jar|properties)|bunfig\.toml`,
    String.raw`\.cargo/config(\.toml)?|rust-toolchain(\.toml)?|\.npmrc|\.nvmrc|\.tool-versions`,
    String.raw`package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml`,
    // Git hooks and lint-staged run code on a developer's machine at their next commit.
    String.raw`\.husky/.*|\.lintstagedrc[^/]*|lint-staged\.config\.[^/]+`,
    // Tool configs the dev servers, the build and the checks execute or obey, outside the app code a person reviews.
    String.raw`vite\.config\.[^/]+|playwright\.config\.[^/]+|tsconfig[^/]*\.json`,
  ].join('|')})$`,
)
/**
 * True when a fix PR must not touch `path` (repo-relative). Only the supply chain and the verification are closed:
 * `.github/` (workflows and this pipeline), dependency manifests, lockfiles, git hooks and lint-staged config, the
 * Vite, Playwright and TypeScript configs, and `e2e/`, whose helpers every repro spec and visual check imports (`publish` adds the regression spec there itself).
 * App code of any kind is open, because a person reviews every draft PR.
 */
export const isDenied = (path: string) => /^(\.github|e2e)\//.test(path) || dependencyFiles.test(path)

type Ticket = Pick<Filed, 'fp' | 'severity' | 'issueId' | 'identifier' | 'url'>
/**
 * What the fix agent must make pass. A `spec` task has the confirmed repro spec, or on iOS and Android the repro
 * `flow`. A `visual` task has neither: the agent writes its own check, which the workflow runs without and with the
 * patch. On the web the check is `qa-out/fix-<fp>/repro/check.spec.ts`; on iOS and Android it is the Maestro flow
 * `qa-out/fix-<fp>/repro/check.yaml`, which the task names as its `flow`.
 */
type Proof = { kind: 'spec'; spec: string } | { kind: 'spec' | 'visual'; flow: string } | { kind: 'visual' }
/**
 * One fix-job matrix entry. `finding` holds the only ticket fields the fix agent sees, `screenshot` the finding's
 * screenshot when it has one. `real` marks a session on the real AI providers, where the workflow verifies the fix on
 * the real providers too.
 */
export type FixTask = Ticket &
  Proof & {
    charterDir: string
    platform: string
    real: boolean
    screenshot?: string
    finding: Pick<Finding, 'title' | 'area' | 'viewport' | 'oracle' | 'steps' | 'expected' | 'actual'>
  }
/**
 * A flow the native verification runs on its platform with the patched app (`native.sh verify-build`, then
 * `verify-run`): a native task's flow, or the repro flow of the same bug found on another platform. `session` picks
 * the build. `unpatched` asks for a run on the build without the patch too, where the flow must fail: a visual check,
 * and a real-AI session, which the keyless verification can only check on the fake AI.
 */
export type NativeCheck = { fp: string; platform: string; session: string; flow: string; unpatched: boolean }
/** `qa-out/fix-plan.json`. The workflow's fix matrix is `fixes`, its native verification matrix `verifyNative`. */
export type FixPlan = { fixes: FixTask[]; verifyNative: NativeCheck[] }

/** Runs a command without a shell and returns its stdout. */
export type Run = (
  cmd: string[],
  opts?: { env?: Record<string, string>; stdin?: string; cwd?: string },
) => Promise<string>

/** The error names only the command, never its arguments. */
export const runCommand: Run = async (cmd, { env, stdin, cwd } = {}) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? 'ignore' : new Response(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd.slice(0, 2).join(' ')} exited ${code}: ${stderr.trim()}`)
  return stdout
}

/** Label tickets the filer created `Human Required`, looking the label up once. */
const markHumanRequired = async ({ fetchFn, key }: LinearAuth, issueIds: string[]) => {
  if (issueIds.length === 0) return
  const { issueLabels } = await linear<{ issueLabels: { nodes: { id: string; team: { name: string } | null }[] } }>(
    fetchFn,
    key,
    'query Label($name: String!) { issueLabels(first: 50, filter: { name: { eq: $name } }) { nodes { id team { name } } } }',
    { name: qaLabels.humanRequired },
  )
  const label = issueLabels.nodes.find((l) => !l.team || l.team.name === 'Thunderbolt')
  if (!label) throw new Error(`Missing Linear label: ${qaLabels.humanRequired}`)
  for (const id of issueIds) {
    const { issueAddLabel } = await linear<{ issueAddLabel: { success: boolean } }>(
      fetchFn,
      key,
      'mutation AddLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }',
      { id, labelId: label.id },
    )
    if (!issueAddLabel.success) throw new Error('Linear did not add the label')
  }
}

type RouteOptions = { outDir: string; live: boolean; run?: Run; log?: (line: string) => void }

/**
 * Which finding of one bug becomes its fix task, lowest first: a sync session's, so the sync refusal still holds, then
 * a real-AI web session's, so `verify-real` checks the fix on the real providers with that session's own repro.
 */
const leadRank = (session: string) => {
  if (syncSession(session)) return 0
  return realAiCharters.has(session) && !nativePlatformIds.includes(parseSession(session).platform) ? 1 : 2
}

/** The proof the fix agent works against, or undefined when the finding's repro is not on disk. */
const proofOf = async (
  outDir: string,
  charterDir: string,
  fp: string,
  finding: Finding,
): Promise<Proof | undefined> => {
  if (finding.oracle.type === 'visual') {
    return nativePlatformIds.includes(finding.viewport)
      ? { kind: 'visual', flow: join(outDir, `fix-${fp}`, 'repro', 'check.yaml') }
      : { kind: 'visual' }
  }
  // c7 on Android proves a finding of its browser with a spec, so the field decides, not the platform.
  const repro = finding.repro_flow ?? finding.repro_spec
  if (!repro) return undefined
  const path = join(outDir, charterDir, repro)
  if (!(await Bun.file(path).exists())) return undefined
  return finding.repro_flow ? { kind: 'spec', flow: path } : { kind: 'spec', spec: path }
}

/**
 * Decide in code which filed tickets the fix agent attempts, and write `fix-plan.json`.
 * Every ticket (created, regression or commented) whose finding was confirmed qualifies, whatever its area or oracle,
 * security and real-AI findings included, because a person reviews every draft PR. It is left out this week when an
 * earlier `qa-fix/<fp>` branch still exists (its draft PR is open) or the cap is reached: at most three, highest
 * severity first, and one per fingerprint however many platforms found the bug.
 * A task with a Maestro flow (an iOS or Android finding) goes into `verifyNative` too, and so does the repro flow of
 * the same bug confirmed on another native platform: the patch must pass on each of them.
 * With `live` only tickets that exist count, so a filing forced into a dry run starts no fix agent; a dry run
 * plans what a live filing would have created.
 */
export const route = async ({ outDir, live, run = runCommand, log = console.log }: RouteOptions) => {
  const filed: Filed[] = await Bun.file(join(outDir, 'filed.json')).json()
  const { confirmed }: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const branches = await run(['git', 'ls-remote', '--heads', 'origin', 'qa-fix/*'])
  const pending = new Set(branches.match(/(?<=refs\/heads\/qa-fix\/)\S+/g))
  const plan: FixPlan = { fixes: [], verifyNative: [] }
  const routed = new Set<string>()
  const tickets = filed.filter((f) => ticketActions.has(f.action === 'dry-run' && !live ? f.would : f.action))
  // Bugs keep their filed order under the cap; `leadRank` only orders the findings inside one bug.
  const firstAt = new Map<string, number>()
  for (const [i, { fp }] of tickets.entries()) if (!firstAt.has(fp)) firstAt.set(fp, i)
  const at = (fp: string) => firstAt.get(fp) ?? 0
  tickets.sort(
    (a, b) =>
      priority[a.severity] - priority[b.severity] ||
      at(a.fp) - at(b.fp) ||
      leadRank(a.charterDir) - leadRank(b.charterDir),
  )
  for (const { fp, severity, issueId, identifier, url, charterDir, id } of tickets) {
    const fresh = !routed.has(fp)
    if (fresh && (plan.fixes.length === maxFixes || pending.has(fp))) continue
    const verified = confirmed.find((v) => v.charterDir === charterDir && v.id === id)
    if (!verified) continue
    const finding = findingSchema.parse(verified.finding)
    const proof = await proofOf(outDir, charterDir, fp, finding)
    if (!proof) {
      log(`fix: ${fp} has no repro on disk, so it is not routed`)
      continue
    }
    const platform = finding.viewport
    // One fix job per bug (same fp): a second one would fight over `qa-fix/<fp>`, and `leadRank` picks which finding
    // it gets. Only the other platforms' repro flows join it, since the fix agent writes a visual check for its own
    // task alone.
    const flow = 'flow' in proof && (fresh || proof.kind === 'spec') ? proof.flow : undefined
    if (flow && !plan.verifyNative.some((v) => v.fp === fp && v.platform === platform)) {
      const unpatched = proof.kind === 'visual' || realAiCharters.has(charterDir)
      plan.verifyNative.push({ fp, platform, session: charterDir, flow, unpatched })
    }
    if (!fresh) continue
    routed.add(fp)
    plan.fixes.push({
      fp,
      severity,
      issueId,
      identifier,
      url,
      ...proof,
      charterDir,
      platform,
      real: realAiCharters.has(charterDir),
      screenshot: finding.screenshot ? join(outDir, charterDir, finding.screenshot) : undefined,
      finding: ticketView(finding),
    })
  }
  await writeFile(join(outDir, 'fix-plan.json'), JSON.stringify(plan, null, 2))
  log(`fix: ${plan.fixes.map((t) => t.fp).join(', ') || 'none'}`)
  return plan
}

/** Named exports of `e2e/test.ts`; a spec importing only these can switch to the repo fixture. */
const e2eTestExports = new Set(['test', 'expect', 'Page', 'Request', 'Route'])

/**
 * The repro spec as a permanent regression test. The name matches a Playwright project so
 * `scripts/check-e2e-specs-collected.ts` accepts it: `sync-qa-` for the two-device charter (the only one on
 * Postgres + PowerSync), `consumer-qa-` for the rest, which replay against the consumer pair. Imports move from
 * `qa-out/<charter>/repro/` to `e2e/` (the layout and ports helpers stay in `.github/qa/`), and `@playwright/test`
 * becomes `./test` like every other spec (it adds WebKit's persistent profile and the attestation stub) unless the
 * spec imports something `./test` lacks.
 */
export const regressionSpec = (charterDir: string, fp: string, source: string) => ({
  path: `e2e/${charterDir.startsWith('c7-') ? 'sync' : 'consumer'}-qa-${fp}.spec.ts`,
  source: source
    .replace(/(from\s*)(['"])\.\.\/\.\.\/\.\.\/e2e\/helpers\2/g, '$1$2./helpers$2')
    .replace(/(from\s*)(['"])\.\.\/\.\.\/\.\.\/(\.github\/qa\/(?:layout|ports))\2/g, '$1$2../$3$2')
    .replace(
      /(import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*)(['"])@playwright\/test\3/g,
      (whole: string, head: string, names: string, quote: string) =>
        names
          .split(',')
          .map(
            (name) =>
              name
                .trim()
                .replace(/^type\s+/, '')
                .split(/\s+as\s+/)[0],
          )
          .filter(Boolean)
          .every((name) => e2eTestExports.has(name))
          ? `${head}${quote}./test${quote}`
          : whole,
    ),
})

/**
 * Files a patch touches with their old and new git modes, rename sources included, read through a scratch index so
 * the checkout stays as is.
 */
const patchedFiles = async (run: Run, patch: string) => {
  const env = { GIT_INDEX_FILE: `${patch}.index` }
  try {
    await run(['git', 'read-tree', 'HEAD'], { env })
    await run(['git', 'apply', '--cached', patch], { env })
    // Per file: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
    const fields = (await run(['git', 'diff', '--cached', '--raw', '--no-renames', '-z', 'HEAD'], { env })).split('\0')
    return fields.flatMap((field, i) =>
      field.startsWith(':') ? [{ path: fields[i + 1], modes: field.slice(1).split(' ').slice(0, 2) }] : [],
    )
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true })
  }
}

/** Git modes of a symlink and a submodule: either can point a reviewed path at anything. */
const linkModes = new Set(['120000', '160000'])

/**
 * The check the fix agent wrote for a visual task: three levels under the repo root in a `repro/` dir, like a repro
 * spec, so it has the same import paths and the same Playwright project.
 */
const checkPath = (outDir: string, fp: string) => join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts')
/** `fix/<fp>.verify.json`: whether the visual check failed on the tree without the patch and passed with it. */
const checkResult = z.object({ failsWithout: z.boolean(), passesWith: z.boolean() })

/** Parses `verify.json` text; undefined when it is not JSON or misses a boolean field. */
const readCheckResult = (text: string): z.infer<typeof checkResult> | undefined => {
  try {
    return checkResult.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Why a visual check's `verify.json` text does not prove the fix, or undefined when it does. */
const checkResultProblem = (text: string) => {
  const result = readCheckResult(text)
  if (!result) return 'the visual check result is unreadable'
  return result.failsWithout && result.passesWith
    ? undefined
    : 'the visual check did not fail without the patch and pass with it'
}

/**
 * What the Maestro allow list finds wrong with a native task's flow: the replay's own check, with `${EMAIL}` as the
 * only variable.
 */
const flowProblems = (platform: string, flow: string) => {
  const check = checkMaestroFlow(flow, { appId: platformOf(platform).appId ?? '', vars: flowVars })
  return check.ok ? [] : check.problems
}

/**
 * Problems with what the patch must make pass: the repro spec or flow unedited (`fix/<fp>.spec.ts` or `fix/<fp>.yaml`
 * equal to the original), or a visual task's verified check.
 */
const proofProblems = async (outDir: string, task: FixTask) => {
  if (task.kind === 'spec') {
    const [original, copy, lint, name] =
      'flow' in task
        ? [task.flow, `${task.fp}.yaml`, (text: string) => flowProblems(task.platform, text), 'repro flow']
        : [task.spec, `${task.fp}.spec.ts`, lintReproSpec, 'repro spec']
    const text = await readFile(original, 'utf8')
    const reasons = lint(text).map((problem) => `${name}: ${problem}`)
    return (await readFile(join(outDir, 'fix', copy), 'utf8')) === text
      ? reasons
      : [...reasons, `the ${name} was edited`]
  }
  const check = Bun.file('flow' in task ? task.flow : checkPath(outDir, task.fp))
  if (!(await check.exists())) return ['the visual check is missing']
  const text = await check.text()
  const problems = 'flow' in task ? flowProblems(task.platform, text) : lintReproSpec(text)
  const reasons = problems.map((problem) => `visual check: ${problem}`)
  // Written by the workflow after it ran the check on the tree without and with the patch.
  const verify = Bun.file(join(outDir, 'fix', `${task.fp}.verify.json`))
  if (!(await verify.exists())) return [...reasons, 'the visual check did not fail without the patch and pass with it']
  const problem = checkResultProblem(await verify.text())
  return problem ? [...reasons, problem] : reasons
}

/**
 * Why the agent's output must not become a PR (empty = it may), and the files its patch touches. `verifyNative` is
 * the trusted plan's, never anything the fix agent wrote.
 */
export const checkPatch = async (run: Run, outDir: string, task: FixTask, verifyNative: NativeCheck[]) => {
  const patch = resolve(outDir, 'fix', `${task.fp}.patch`)
  const reasons = await proofProblems(outDir, task)
  // verify-real replays only a repro spec, so nothing checks a web visual fix of a real-AI finding on the real AI.
  if (task.real && task.kind === 'visual' && !('flow' in task)) {
    reasons.push('a real-AI web fix without a repro spec cannot be checked on the real AI providers')
  }
  // shortcut: the fix job and verify-native-run start no Postgres or PowerSync, so they cannot verify a sync fix;
  // publish these once those jobs start the sync services.
  if (syncSession(task.charterDir)) {
    reasons.push('a fix found in a session that needs Postgres and PowerSync is not verified with them')
  }
  const text = await readFile(patch, 'utf8')
  if (!text.trim()) return { reasons: ['empty patch', ...reasons], files: [] }
  // The patch becomes a public PR.
  if (secretPattern.test(text)) reasons.push('the patch matches a secret pattern')
  const files = await patchedFiles(run, patch)
  // verify-native-run and verify-real start the backend from the checkout without the patch; only the fix job runs
  // it patched, and only for a fake-AI web spec.
  const baseBackend = task.real || 'flow' in task || verifyNative.some((v) => v.fp === task.fp)
  return {
    reasons: [
      ...reasons,
      ...files.filter((f) => isDenied(f.path)).map((f) => `touches ${f.path}`),
      ...files
        .filter((f) => baseBackend && /^(backend|shared)\//.test(f.path))
        .map((f) => `touches ${f.path}, but the verification ran on the backend from before the patch`),
      ...files
        .filter((f) => f.modes.some((m) => linkModes.has(m)))
        .map((f) => `adds or changes a symlink or submodule: ${f.path}`),
    ],
    files: files.map((f) => f.path),
  }
}

const oneLine = (text: string) => text.replace(/[\p{Cc}\s]+/gu, ' ').trim()

type PublishOptions = {
  outDir: string
  fp: string
  live: boolean
  key?: string
  token?: string
  repoDir?: string
  run?: Run
  fetchFn?: typeof fetch
  log?: (line: string) => void
}
type PublishResult =
  | { outcome: 'pr'; branch: string; files: string[]; spec?: string; commit: string; prUrl?: string }
  | { outcome: 'human-required'; reasons: string[] }

const reviewNotice =
  'An AI agent wrote this change. Review it like an outside contribution: the QA pipeline never merges, approves or marks PRs ready.'

/**
 * The commit and draft PR a passing fix becomes, and the regression spec it adds: the repro spec, or for a visual
 * task the check the fix agent wrote. A native task adds none, neither does a task from the onboarding session,
 * since `e2e/` does not serve that build, nor a real-AI task, since its repro needs providers `e2e/` does not run.
 * The repo is public and a security fix's PR shows up before the fix ships, so that PR names only the ticket, never
 * says "security", and adds no spec: a person adds the spec in a separate commit after the merge.
 */
const draftOf = async (outDir: string, task: FixTask) => {
  const ticket = task.identifier ?? 'its Linear ticket'
  if (task.finding.area === 'security') {
    const title = `fix: QA finding ${task.identifier ?? task.fp}`
    // Linear's URL ends in a slug of the ticket's title.
    const link = task.url?.replace(/(\/issue\/[^/]+)\/.*$/, '$1') ?? 'filed in a dry run'
    const body = [
      `Draft fix by the weekly QA agent for ${ticket} (${link}).`,
      'The finding and its regression spec stay out of this PR. A person adds the spec in a separate commit after the fix merges.',
      reviewNotice,
    ].join('\n\n')
    return { title, commit: title, body, spec: undefined }
  }
  const title = `fix: ${oneLine(task.finding.title)}`.slice(0, 100).trimEnd()
  // A code span, so a model-written title cannot @mention anyone.
  const findingLine = `**Finding:** \`${oneLine(task.finding.title).replaceAll('`', "'")}\` · ${task.finding.area} · ${task.severity}`
  const intro = `Draft fix by the weekly QA agent for ${ticket} (${task.url ?? 'filed in a dry run'}).`
  if ('flow' in task) {
    // A Maestro flow needs the QA stack and a fresh address per run, so it does not become a regression spec.
    const checked = `Checked on ${task.platform} with ${task.kind === 'spec' ? "the finding's Maestro flow" : "the fix agent's Maestro check"}`
    const body = [intro, findingLine, `${checked}. The PR adds no regression spec.`, reviewNotice].join('\n\n')
    return { title, commit: `${title}\n\n${checked}.`, body, spec: undefined }
  }
  if (onboardingSession(task.charterDir)) {
    const why =
      'The repro runs on the onboarding build, which the Playwright config of e2e/ does not serve, so the PR adds no regression spec.'
    const body = [intro, findingLine, why, reviewNotice].join('\n\n')
    return { title, commit: `${title}\n\n${why}`, body, spec: undefined }
  }
  if (task.real) {
    const why =
      'The repro passed on the real AI providers, and the consumer project of e2e/ runs on the fake provider, so the PR adds no regression spec.'
    const body = [intro, findingLine, why, reviewNotice].join('\n\n')
    return { title, commit: `${title}\n\n${why}`, body, spec: undefined }
  }
  const source = task.kind === 'spec' ? task.spec : checkPath(outDir, task.fp)
  const spec = regressionSpec(task.charterDir, task.fp, await readFile(source, 'utf8'))
  const [origin, proof] =
    task.kind === 'spec'
      ? ["the QA agent's repro", 'The repro spec, which the replay confirmed, is added with its assertions unchanged']
      : [
          "the fix agent's visual check",
          "The fix agent's check, which failed without this patch and passes with it, is added",
        ]
  const body = [intro, findingLine, `${proof} as \`${spec.path}\`.`, reviewNotice].join('\n\n')
  return { title, commit: `${title}\n\nKeeps ${origin} as the regression test ${spec.path}.`, body, spec }
}

/**
 * Turn the fix agent's output for one routed ticket into a draft PR, or hand the ticket to a person.
 * Deterministic, no LLM. Dry unless `live`: a dry run validates and returns the plan without touching the
 * checkout, GitHub or Linear.
 *
 * The publish job downloads the file job's `qa-out` artifact and only `qa-out/fix/` (plus `qa-out/fix-<fp>/repro/`
 * for a visual task) from the fix job:
 * - `fix/<fp>.patch`: `git add -A && git diff --cached --binary HEAD`, taken by the workflow after the agent ran;
 * - `fix/<fp>.spec.ts`: the repro spec as the agent left it, compared with the original (`fix/<fp>.yaml` for a native
 *   task's repro flow);
 * - for a visual task, `fix-<fp>/repro/check.spec.ts` (`check.yaml` on iOS and Android), the check the agent wrote,
 *   and `fix/<fp>.verify.json`, the workflow's record of running it without and with the patch;
 * - `fix/<fp>.diagnosis.md`: written when the agent gave up; any patch is then ignored.
 * A diagnosis or a rejected patch (empty, a denied path, an edited spec, an unverified check) means no PR: the
 * ticket gets a comment and the `Human Required` label. Otherwise branch `qa-fix/<fp>` gets one commit (the patch
 * plus the regression spec `draftOf` picks) under the git identity the workflow configured, is pushed with `token` (a GitHub App
 * token; check out with `persist-credentials: false` so no second auth header competes), and becomes a draft PR
 * linking the ticket, which gets the PR link as a comment.
 *
 * Guardrail: this never merges, approves, marks ready or enables auto-merge. No `gh pr merge`, `gh pr ready`,
 * `gh pr review`, and no merge or review API call. A person reviews the draft and decides.
 */
export const publish = async ({
  outDir,
  fp,
  live,
  key,
  token,
  repoDir = '.',
  run = runCommand,
  fetchFn = fetch,
  log = console.log,
}: PublishOptions): Promise<PublishResult> => {
  if (live && (!key || !token)) throw new Error('--live needs LINEAR_API_KEY and GH_TOKEN')
  const { fixes, verifyNative }: FixPlan = await Bun.file(join(outDir, 'fix-plan.json')).json()
  const task = fixes.find((t) => t.fp === fp)
  if (!task) throw new Error(`${fp} is not in fix-plan.json`)
  const issueId = task.issueId ?? ''
  if (live && !issueId) throw new Error(`${fp} has no Linear ticket: the findings were filed in a dry run`)
  const auth = { fetchFn, key: key ?? '' }

  const handOff = async (reasons: string[], body: string): Promise<PublishResult> => {
    if (!live)
      log(`[dry run] would comment on ${task.identifier ?? fp} and label it "${qaLabels.humanRequired}":\n${body}`)
    else {
      await addComment(auth, issueId, body)
      await markHumanRequired(auth, [issueId])
    }
    return { outcome: 'human-required', reasons }
  }

  const diagnosis = Bun.file(join(outDir, 'fix', `${fp}.diagnosis.md`))
  if (await diagnosis.exists()) {
    const text = await diagnosis.text()
    return handOff(
      ['the fix agent wrote a diagnosis'],
      secretPattern.test(text)
        ? 'The fix agent could not fix this. Its diagnosis matched a secret pattern, so it stays in the run artifacts.'
        : `The fix agent could not fix this and wrote a diagnosis:\n\n${sanitize(text, 6000)}`,
    )
  }
  const { reasons, files } = await checkPatch(run, outDir, task, verifyNative)
  if (reasons.length) {
    return handOff(
      reasons,
      `The fix agent's patch was rejected, so there is no PR:\n\n${reasons.map((r) => `- ${sanitize(r, 300)}`).join('\n')}`,
    )
  }

  const branch = `qa-fix/${fp}`
  const { title, commit, body, spec } = await draftOf(outDir, task)
  if (!live) {
    log(`[dry run] would push ${branch} with:\n${commit}\n\nand open a draft PR:\n${body}`)
    return { outcome: 'pr', branch, files, spec: spec?.path, commit }
  }

  const patch = resolve(outDir, 'fix', `${fp}.patch`)
  // No git hooks: they would run code from the patched tree while this job holds the write token.
  const git = (args: string[], opts?: Parameters<Run>[1]) =>
    run(['git', '-c', 'core.hooksPath=/dev/null', ...args], opts)
  await git(['switch', '--create', branch])
  await git(['apply', '--index', patch])
  if (spec) {
    await writeFile(join(repoDir, spec.path), spec.source)
    await git(['add', spec.path])
  }
  await git(['commit', '--no-verify', '--quiet', '--message', commit])
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  await git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`], {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
  })
  const created = await run(
    ['gh', 'pr', 'create', '--draft', '--base', 'main', '--head', branch, '--title', title, '--body-file', '-'],
    { env: { GH_TOKEN: token ?? '' }, stdin: body },
  )
  const prUrl = created.trim()
  await addComment(auth, issueId, `Draft fix PR: ${prUrl}`)
  return { outcome: 'pr', branch, files, spec: spec?.path, commit, prUrl }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'qa-out' },
      fp: { type: 'string' },
      live: { type: 'boolean', default: false },
    },
  })
  const key = Bun.env.LINEAR_API_KEY
  if (positionals[0] === 'route') {
    await route({ outDir: values.out, live: values.live })
  } else if (positionals[0] === 'publish' && values.fp) {
    const result = await publish({ outDir: values.out, fp: values.fp, live: values.live, key, token: Bun.env.GH_TOKEN })
    console.log(JSON.stringify(result, null, 2))
  } else {
    throw new Error('usage: fix.ts route --out DIR [--live] | fix.ts publish --out DIR --fp FP [--live]')
  }
}
