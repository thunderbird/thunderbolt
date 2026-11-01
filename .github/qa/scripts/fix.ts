#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { format, resolveConfig } from 'prettier'
import ts from 'typescript'
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

/** Manifests, lockfiles and the build-tool files that pick a registry, download or binary every build runs. */
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
 * `.github/`, dependency and hook files, the tool configs, `e2e/`, whose helpers every repro spec and visual check
 * imports (`publish` adds the regression spec there itself), and `deploy/pulumi/`, which the preview deploy runs from
 * the PR's tree with AWS deploy credentials. App code is open, because a person reviews every draft PR.
 */
export const isDenied = (path: string) => /^(\.github|e2e|deploy\/pulumi)\//.test(path) || dependencyFiles.test(path)

type Ticket = Pick<Filed, 'fp' | 'severity' | 'issueId' | 'identifier'>
/**
 * What the fix agent must make pass. A `visual` task has no repro, so the agent writes its own check, which the
 * workflow runs without and with the patch: `check.spec.ts` on the web, `check.yaml` (named as the task's `flow`) on
 * iOS and Android.
 */
type Proof = { kind: 'spec'; spec: string } | { kind: 'spec' | 'visual'; flow: string } | { kind: 'visual' }
/**
 * One fix-job matrix entry. `finding` holds the only ticket fields the fix agent sees. `real` marks a session on the
 * real AI providers, where the workflow verifies the fix on them too. `branch` is the branch route checked, which
 * publish pushes to.
 */
export type FixTask = Ticket &
  Proof & {
    branch: string
    charterDir: string
    platform: string
    real: boolean
    screenshot?: string
    finding: Pick<Finding, 'title' | 'area' | 'viewport' | 'oracle' | 'steps' | 'expected' | 'actual'>
  }
/**
 * A flow the native verification runs on its platform with the patched app: a native task's flow, or the repro flow of
 * the same bug found on another platform. `unpatched` asks for a run without the patch too, where the flow must fail:
 * a visual check, and a real-AI session, which the keyless verification can only check on the fake AI.
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

type RouteOptions = {
  outDir: string
  live: boolean
  key?: string
  fetchFn?: typeof fetch
  run?: Run
  log?: (line: string) => void
}

type LinearTicket = { id: string; branchName: string; state: { type: string } }

/** Each ticket's suggested branch name and workflow state, in one read. Without a key there is nothing to read. */
const linearTickets = async ({ fetchFn, key }: LinearAuth, issueIds: string[]) => {
  if (!key || issueIds.length === 0) return new Map<string, LinearTicket>()
  // shortcut: one page of 250 tickets; page through if a run ever files more.
  const { issues } = await linear<{ issues: { nodes: LinearTicket[] } }>(
    fetchFn,
    key,
    'query Tickets($ids: [ID!]!) { issues(first: 250, includeArchived: true, filter: { id: { in: $ids } }) { nodes { id branchName state { type } } } }',
    { ids: issueIds },
  )
  return new Map(issues.nodes.map((n) => [n.id, n]))
}

const closedStates = new Set(['completed', 'canceled'])

/**
 * True when Linear's suggested branch name is safe to push to: `<prefix>/<identifier>` with an optional `-<slug>`, in
 * lowercase letters, digits, `-` and `_`, at most 100 characters. The name comes from a model-written title, and the
 * identifier in it is what links the PR to the ticket.
 */
const isSafeLinearBranch = (name: string, identifier: string) => {
  const id = identifier.toLowerCase()
  const slug = name.split('/')[1] ?? ''
  return (
    name.length <= 100 && /^[a-z0-9][a-z0-9_-]*\/[a-z0-9_-]+$/.test(name) && (slug === id || slug.startsWith(`${id}-`))
  )
}

/** True when `ref` names the ticket the way Linear links a branch: the identifier as a whole `-` or `/` token. */
const namesTicket = (ref: string, identifier: string) =>
  new RegExp(`(^|[/-])${identifier.toLowerCase()}($|[/-])`).test(ref.toLowerCase())

/**
 * The branch a ticket's fix goes on: Linear's suggested name when it has a safe shape and git accepts it, so the merge
 * closes the ticket, else `qa-fix/<identifier>`. A security ticket always gets the identifier-only name, because the
 * slug of its title would announce the hole in a public branch. A ticket filed in a dry run has no identifier and keeps
 * `qa-fix/<fp>`.
 */
const branchFor = async (
  run: Run,
  fp: string,
  identifier: string | undefined,
  security: boolean,
  suggested?: string,
) => {
  if (!identifier) return `qa-fix/${fp}`
  const fallback = `qa-fix/${identifier.toLowerCase()}`
  if (security || !suggested || !isSafeLinearBranch(suggested, identifier)) return fallback
  try {
    await run(['git', 'check-ref-format', '--branch', suggested])
    return suggested
  } catch {
    return fallback
  }
}

/**
 * Which finding of one bug becomes its fix task, lowest first: a sync session's, so the sync refusal still holds, then
 * a real-AI web session's, so `verify-real` checks the fix on the real providers with that session's own repro.
 */
const leadRank = (session: string) => {
  if (syncSession(session)) return 0
  return realAiCharters.has(session) && !nativePlatformIds.includes(parseSession(session).platform) ? 1 : 2
}

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
 * Decides in code which filed tickets the fix agent attempts, and writes `fix-plan.json`.
 * Every ticket whose finding was confirmed qualifies, whatever its area or oracle, security and real-AI findings
 * included, because a person reviews every draft PR. Each ticket gets one task, however many platforms found the bug,
 * and the tasks run most severe first. Each task carries the branch its fix goes on (see `branchFor`). A ticket is
 * left out, with a log line, when Linear has it completed or canceled, when an open PR of this repository sits on its
 * branch or on the older `qa-fix/<fp>` one, or when its branch exists without one: a person may be working there. A
 * task with a Maestro flow goes into `verifyNative` too, and so
 * does the repro flow of the same bug confirmed on another native platform: the patch must pass on each of them.
 * With `live` only tickets that exist count, so a filing forced into a dry run starts no fix agent.
 */
export const route = async ({
  outDir,
  live,
  key,
  fetchFn = fetch,
  run = runCommand,
  log = console.log,
}: RouteOptions) => {
  const filed: Filed[] = await Bun.file(join(outDir, 'filed.json')).json()
  const { confirmed }: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const plan: FixPlan = { fixes: [], verifyNative: [] }
  const routed = new Set<string>()
  const tickets = filed.filter((f) => ticketActions.has(f.action === 'dry-run' && !live ? f.would : f.action))
  // Every finding of one bug files with the bug's severity, so `leadRank` decides which of them leads its fix task.
  tickets.sort((a, b) => priority[a.severity] - priority[b.severity] || leadRank(a.charterDir) - leadRank(b.charterDir))
  const issueIds = [...new Set(tickets.flatMap((t) => (t.issueId ? [t.issueId] : [])))]
  const [linearById, heads, openPrs] = await Promise.all([
    linearTickets({ fetchFn, key: key ?? '' }, issueIds),
    run(['git', 'ls-remote', '--heads', 'origin']),
    // A fork's PR is left out: anyone can name a fork branch after a ticket's.
    run([
      'gh',
      'pr',
      'list',
      '--base',
      'main',
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'headRefName,isCrossRepository',
      '--jq',
      '.[] | select(.isCrossRepository | not) | .headRefName',
    ]),
  ])
  const existing = new Set(heads.match(/(?<=refs\/heads\/)\S+/g))
  const prBranches = new Set(openPrs.split('\n').filter(Boolean))

  const routableBranch = async (
    fp: string,
    issueId: string | undefined,
    identifier: string | undefined,
    security: boolean,
  ) => {
    const ticket = identifier ?? fp
    const linearTicket = issueId ? linearById.get(issueId) : undefined
    if (key && issueId && !linearTicket) {
      log(`fix: Linear did not return ${ticket}, so its state is not checked and it gets the identifier-only branch`)
    }
    if (linearTicket && closedStates.has(linearTicket.state.type)) {
      log(`fix: ${ticket} is ${linearTicket.state.type} in Linear, so it is not routed`)
      return undefined
    }
    const branch = await branchFor(run, fp, identifier, security, linearTicket?.branchName)
    // A teammate's PR on their own branch for the ticket counts too, and both of the bot's names carry the identifier.
    const ticketPr = identifier !== undefined && [...prBranches].some((ref) => namesTicket(ref, identifier))
    if (ticketPr || prBranches.has(`qa-fix/${fp}`)) {
      log(`fix: ${ticket} already has an open PR, so it is not routed`)
      return undefined
    }
    if (existing.has(branch)) {
      log(`fix: ${ticket}'s branch ${branch} exists without an open PR, so it is not routed`)
      return undefined
    }
    return branch
  }

  // Every finding of one bug shares its ticket and area, so the first one decides the bug's branch.
  const branches = new Map<string, string | undefined>()
  for (const { fp, severity, issueId, identifier, charterDir, id } of tickets) {
    const fresh = !routed.has(fp)
    const verified = confirmed.find((v) => v.charterDir === charterDir && v.id === id)
    if (!verified) continue
    const finding = findingSchema.parse(verified.finding)
    if (!branches.has(fp)) branches.set(fp, await routableBranch(fp, issueId, identifier, finding.area === 'security'))
    const branch = branches.get(fp)
    if (!branch) continue
    const proof = await proofOf(outDir, charterDir, fp, finding)
    if (!proof) {
      log(`fix: ${fp} has no repro on disk, so it is not routed`)
      continue
    }
    const platform = finding.viewport
    // One fix job per bug (same fp): a second one would fight over its branch, and `leadRank` picks which finding
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
      ...proof,
      branch,
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

/**
 * Why a fix PR adds no regression spec to `e2e/`, or undefined when it adds the repro spec (the agent's check in a
 * visual task). The unit test every web fix carries is the default guard, so a spec is added only for a bug a unit
 * test cannot show: happy-dom computes no layout, so a visual finding or a layout one qualifies, except an
 * `unnamed-control` (a missing accessible name shows in a unit test), and data lost on a reload qualifies, since the
 * repo's testing guide sends browser storage to `e2e/`. A security fix, a native one, one from the onboarding build
 * and a real-AI one never add a spec.
 */
export const whyNoSpec = (task: FixTask) => {
  if (task.finding.area === 'security') return 'security'
  if ('flow' in task) return 'native'
  if (onboardingSession(task.charterDir)) return 'onboarding'
  if (task.real) return 'real'
  const { type, evidence } = task.finding.oracle
  const needsBrowser =
    type === 'visual' ||
    type === 'lost-on-reload' ||
    (type === 'layout' && !evidence.includes('[qa-layout] unnamed-control'))
  return needsBrowser ? undefined : 'unit'
}

/** Named exports of `e2e/test.ts`; a spec importing only these can switch to the repo fixture. */
const e2eTestExports = new Set(['test', 'expect', 'Page', 'Request', 'Route'])

const mplHeader = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
`

const repoRoot = resolve(import.meta.dir, '../../..')

/** `source` without the imports it never uses, as TypeScript's organize-imports removes them, without sorting. */
const withoutUnusedImports = (fileName: string, source: string) => {
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({}),
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => (name === fileName ? ts.ScriptSnapshot.fromString(source) : undefined),
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  }
  const scope = { type: 'file' as const, fileName, mode: ts.OrganizeImportsMode.RemoveUnused }
  const [change] = ts.createLanguageService(host).organizeImports(scope, {}, undefined)
  return (change?.textChanges ?? []).reduceRight(
    (text, { span, newText }) => text.slice(0, span.start) + newText + text.slice(span.start + span.length),
    source,
  )
}

/**
 * The repro spec as a permanent regression test. The name matches a Playwright project so
 * `scripts/check-e2e-specs-collected.ts` accepts it: `sync-qa-` for the two-device charter (the only one on
 * Postgres + PowerSync), `consumer-qa-` for the rest, which replay against the consumer pair. Imports move from
 * `qa-out/<charter>/repro/` to `e2e/` (the layout and ports helpers stay in `.github/qa/`), and `@playwright/test`
 * becomes `./test` like every other spec (it adds WebKit's persistent profile and the attestation stub) unless the
 * spec imports something `./test` lacks. Then it comes out clean for the repo's checks: unused imports go, the MPL
 * header goes on top when it is missing, and prettier formats it with the config of the checkout this script runs from.
 */
export const regressionSpec = async (charterDir: string, fp: string, source: string) => {
  const path = `e2e/${charterDir.startsWith('c7-') ? 'sync' : 'consumer'}-qa-${fp}.spec.ts`
  const moved = source
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
    )
  const used = withoutUnusedImports(path, moved)
  // The license check's own test for a header.
  const headed = /Mozilla Public License|mozilla\.org\/MPL/.test(used) ? used : `${mplHeader}\n${used}`
  const config = await resolveConfig(join(repoRoot, path))
  return { path, source: await format(headed, { ...config, filepath: path }) }
}

/** The regression spec a task's PR adds (see `whyNoSpec`), or undefined. */
const promotedSpec = async (outDir: string, task: FixTask) => {
  if (whyNoSpec(task)) return undefined
  const source = 'spec' in task ? task.spec : checkPath(outDir, task.fp)
  return regressionSpec(task.charterDir, task.fp, await readFile(source, 'utf8'))
}

/** git with no hooks: they would run code from the patched tree. */
const noHooksGit = (run: Run) => (args: string[], opts?: Parameters<Run>[1]) =>
  run(['git', '-c', 'core.hooksPath=/dev/null', ...args], opts)

/**
 * Puts the tree a fix PR holds into the index and working tree of the checkout `run` works in (`repoDir` for the
 * spec): the patch, and the regression spec when the task adds one. publish commits it, and the PR checks gate checks
 * it first, so both see the same tree. Returns the spec.
 */
const stage = async (run: Run, outDir: string, task: FixTask, repoDir: string) => {
  // Before the patch lands, so prettier never reads a config the patch wrote.
  const spec = await promotedSpec(outDir, task)
  const git = noHooksGit(run)
  await git(['apply', '--index', resolve(outDir, 'fix', `${task.fp}.patch`)])
  if (spec) {
    await writeFile(join(repoDir, spec.path), spec.source)
    await git(['add', spec.path])
  }
  return spec
}

/** One file a patch touches, with git's status letter for it (`A`, `M`, `D`, ...). */
type PatchedFile = { path: string; status: string; modes: string[] }

/**
 * Files a patch touches with their old and new git modes, rename sources included, read through a scratch index so
 * the checkout stays as is.
 */
const patchedFiles = async (run: Run, patch: string): Promise<PatchedFile[]> => {
  const env = { GIT_INDEX_FILE: `${patch}.index` }
  try {
    await run(['git', 'read-tree', 'HEAD'], { env })
    await run(['git', 'apply', '--cached', patch], { env })
    // Per file: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
    const fields = (await run(['git', 'diff', '--cached', '--raw', '--no-renames', '-z', 'HEAD'], { env })).split('\0')
    return fields.flatMap((field, i) => {
      if (!field.startsWith(':')) return []
      const [oldMode, newMode, , , status] = field.slice(1).split(' ')
      return [{ path: fields[i + 1], status, modes: [oldMode, newMode] }]
    })
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true })
  }
}

/**
 * The trees whose unit tests a patch's own tests may live in, each run from where the repo's test scripts run it, so
 * its `bunfig.toml` preload applies. `shared/agent-core/` has its own runner; the rest of `shared/` runs from the root.
 */
const testTrees = [
  { prefix: 'shared/agent-core/', cwd: 'shared/agent-core' },
  { prefix: 'shared/', cwd: '.' },
  { prefix: 'src/', cwd: 'src' },
  { prefix: 'backend/', cwd: 'backend' },
  { prefix: 'cli/', cwd: 'cli' },
]

/** The first tree of `testTrees` that holds `path`, so `shared/agent-core/` wins over `shared/`. */
const treeOf = (path: string) => testTrees.find((tree) => path.startsWith(tree.prefix))
/** True for a `*.test.ts` or `*.test.tsx` file in one of `testTrees`. */
const isUnitTest = (path: string) => /\.test\.tsx?$/.test(path) && treeOf(path) !== undefined

/** A `bun test` command over some of a patch's test files, and the repo-relative directory it runs from. */
export type TestRun = { cwd: string; cmd: string[] }

/**
 * The unit test files a patch adds or changes (`*.test.ts`, `*.test.tsx` in a tree of `testTrees`; a deleted one is
 * left out, and a renamed one counts under its new path), as one `bun test` per tree.
 */
export const testRuns = (files: Pick<PatchedFile, 'path' | 'status'>[]): TestRun[] => {
  const tests = files.filter((f) => f.status !== 'D' && isUnitTest(f.path)).map((f) => f.path)
  return testTrees.flatMap((tree) => {
    const paths = tests.filter((path) => treeOf(path) === tree)
    if (!paths.length) return []
    return [
      { cwd: tree.cwd, cmd: ['bun', 'test', '--timeout', '5000', ...paths.map((p) => `./${relative(tree.cwd, p)}`)] },
    ]
  })
}

const noTestReason =
  'the patch adds or changes no unit test file (`*.test.ts` or `*.test.tsx` under `src/`, `shared/`, `backend/` or `cli/`)'

/** Runs a command with its output in the job log and returns its exit code. */
const runTests = (cmd: string[], cwd: string) =>
  Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }).exited

/**
 * `cmd` run as the OS user `user` through sudo, which resets the environment: the command gets `path` as its PATH and
 * that user's home, nothing else of the caller's environment.
 */
export const asUser = (user: string, path: string, cmd: string[]) => [
  'sudo',
  '-n',
  '--user',
  user,
  '--set-home',
  '--',
  'env',
  `PATH=${path}`,
  ...cmd,
]

type CheckTestsOptions = {
  outDir: string
  fp: string
  /** Runs the tests as this OS user (see `asUser`), while git runs as the caller. */
  user?: string
  repoDir?: string
  run?: Run
  exec?: (cmd: string[], cwd: string) => Promise<number>
  log?: (line: string) => void
}

/**
 * Whether a web patch's own unit tests prove its fix, on a checkout without the patch: they must fail with only the
 * patch's hunks for its test files and its added files applied (`failsWithout`), and pass with the whole patch
 * (`passesWith`). Both are false for a patch with no test file. One process runs both halves, so code a test leaves
 * behind cannot swap the verdict code between them. Each half takes its hunks out again, which leaves the checkout as
 * it was. With `user` the tests run as that user, so they cannot read the environment of this user's processes, and
 * only the snapshot files are opened to it. A patch that adds or changes a symlink or submodule runs no test.
 */
export const checkTests = async ({
  outDir,
  fp,
  user,
  repoDir = '.',
  run = runCommand,
  exec = runTests,
  log = console.log,
}: CheckTestsOptions) => {
  const patch = resolve(outDir, 'fix', `${fp}.patch`)
  // git apply refuses an empty patch, which holds no test either.
  const files = (await readFile(patch, 'utf8')).trim() ? await patchedFiles(run, patch) : []
  if (files.some(isLink)) {
    log(`fix: the tests did not run: ${noLinks}`)
    return { failsWithout: false, passesWith: false }
  }
  const runs = testRuns(files)
  if (!runs.length) {
    log(`fix: ${noTestReason}`)
    return { failsWithout: false, passesWith: false }
  }
  const exitCodes = async (include: string[]) => {
    await run(['git', 'apply', ...include, patch])
    try {
      if (user) await openSnapshots(run, repoDir)
      const codes: number[] = []
      for (const { cwd, cmd: bunTest } of runs) {
        // As in CI, where Bun fails on a missing snapshot instead of writing it. sudo drops the variable.
        const cmd = ['env', 'CI=true', ...bunTest]
        codes.push(await exec(user ? asUser(user, process.env.PATH ?? '', cmd) : cmd, join(repoDir, cwd)))
      }
      return codes
    } finally {
      await run(['git', 'apply', '--reverse', ...include, patch])
    }
  }
  // Every test file the patch touches, deleted ones too: the reverse apply matches a rename by its old name. Every
  // added file too, so a test cannot fail only because a helper, fixture or snapshot it imports is missing. And
  // `--include` takes a glob, so a bracket in a path must not widen or empty the match.
  const baseline = files
    .filter((f) => isUnitTest(f.path) || f.status === 'A')
    .map((f) => `--include=${f.path.replace(/[[\]*?\\]/g, '\\$&')}`)
  const failsWithout = (await exitCodes(baseline)).some((code) => code !== 0)
  const passesWith = (await exitCodes([])).every((code) => code === 0)
  return { failsWithout, passesWith }
}

/** A PR check: a shell command run from the repo root, only for a tree that touches one of `paths` when given. */
export type PrCheck = { name: string; run: string; paths?: string[] }

const cliPaths = [
  'cli/',
  'shared/agent-core/',
  'shared/cli-device-id.ts',
  'shared/defaults/models.ts',
  'shared/inference-usage.ts',
]
const backendPaths = ['backend/', 'shared/']

/**
 * The PR checks a fix can fail, cheapest first. A `<job>: <step>` name is that step of `ci.yml` (`e2e.yml` for the
 * collected-spec check) with its exact command. `bun run check` runs ci.yml's type check and lint of the typescript
 * job plus the e2e type check, the format check and the license check. `paths` follow ci.yml's path filters, leaving
 * out the paths a fix may not touch. The backend job has no filter, but only `backend/` and `shared/` reach its code.
 */
export const prChecks: PrCheck[] = [
  { name: 'bun run check', run: 'bun run check' },
  { name: 'e2e: Fail on spec files no project collects', run: 'bun run e2e:check-collected' },
  {
    name: 'localization: Lingui extraction check',
    run: 'bun run i18n:check',
    paths: [
      'src/',
      'shared/',
      'index.html',
      'lingui.config.ts',
      'backend/src/emails/',
      'backend/src/lib/security-notifications.tsx',
      'backend/lingui.config.ts',
    ],
  },
  { name: 'typescript: Run tests', run: 'bun run test:5x', paths: ['src/', 'shared/', 'scripts/'] },
  {
    name: 'agent-core: Run agent-core tests (5x)',
    run: 'bun run test:agent-core:5x',
    paths: ['shared/agent-core/'],
  },
  { name: 'backend: Type check backend', run: 'cd backend\nbun run type-check\n', paths: backendPaths },
  { name: 'backend: Lint backend', run: 'cd backend\nbun run lint\n', paths: backendPaths },
  {
    name: 'backend: Test backend (5x, excludes same-process WS event-delivery flakes)',
    run: "cd backend && bun test --timeout 3600000 --randomize --rerun-each 5 $(find src \\( -name '*.test.ts' -o -name '*.test.tsx' \\) -not -path '*proxy/ws-e2e.test.ts' -not -path '*haystack/routes.test.ts')",
    paths: backendPaths,
  },
  { name: 'cli: Type check cli', run: 'cd cli && bun run typecheck', paths: cliPaths },
  { name: 'cli: Run cli tests (5x)', run: 'cd cli && bun run test:5x', paths: cliPaths },
]

type PrChecksOptions = {
  /** The ticket the run summary names. */
  ticket: string
  /** Runs the checks as this OS user (see `asUser`). */
  user?: string
  repoDir?: string
  run?: Run
  exec?: (cmd: string[], cwd: string) => Promise<number>
  /** `GITHUB_STEP_SUMMARY`, which gets a line naming the ticket and the failed check. */
  summary?: string
  checks?: PrCheck[]
  log?: (line: string) => void
}

/**
 * Runs the PR checks that apply to the files the last commit changed, in order, as GitHub Actions runs a step (bash,
 * `-eo pipefail`, `CI=true`), and returns the name of the first that fails, or undefined when all pass. A failure is
 * the pipeline's, not the agent's, so the summary line names only the check, never anything the agent wrote.
 */
const runPrChecks = async ({
  ticket,
  user,
  repoDir = '.',
  run = runCommand,
  exec = runTests,
  summary,
  checks = prChecks,
  log = console.log,
}: PrChecksOptions) => {
  const files = (await run(['git', 'diff', '--name-only', '-z', 'HEAD~1', 'HEAD'], { cwd: repoDir }))
    .split('\0')
    .filter(Boolean)
  for (const { name, run: script, paths } of checks) {
    if (paths && !files.some((file) => paths.some((path) => file.startsWith(path)))) continue
    const cmd = ['env', 'CI=true', 'bash', '-eo', 'pipefail', '-c', script]
    log(`fix: running ${name}`)
    if ((await exec(user ? asUser(user, process.env.PATH ?? '', cmd) : cmd, repoDir)) === 0) continue
    const line = `${ticket}: the tree publish would push fails \`${name}\`, so it opens no PR and leaves the ticket for a later run.`
    log(`fix: ${line}`)
    if (summary) await appendFile(summary, `- ${line}\n`)
    return name
  }
  return undefined
}

type GateOptions = Omit<PrChecksOptions, 'ticket'> & { outDir: string; fp: string }

/** The gate's failed check for a patch that adds or changes a symlink or submodule; no check runs on it. */
export const noLinks = 'no symlink or submodule in the patch'

/**
 * The PR checks gate. It stages the tree publish would push (`stage`) and commits it as publish does, so the checks
 * see a committed tree, as in CI, and `i18n:check`'s `git status` test sees no staged catalog. Then `runPrChecks`.
 * Run it in a process that started before the patch landed, after the job's user lost root: the patch's code then
 * runs only inside the checks, as `user`.
 */
export const runGate = async ({ outDir, fp, user, repoDir = '.', run = runCommand, ...rest }: GateOptions) => {
  const { task } = await planTask(outDir, fp)
  // The chmod and the spec write below would follow a link the patch adds, as the job's user. publish refuses such a
  // patch and hands its ticket to a person.
  const files = await patchedFiles(run, resolve(outDir, 'fix', `${fp}.patch`))
  if (files.some(isLink)) return noLinks
  await stage(run, outDir, task, repoDir)
  const identity = ['-c', 'user.name=QA gate', '-c', 'user.email=qa-gate@localhost']
  await noHooksGit(run)([...identity, 'commit', '--no-verify', '--quiet', '--message', 'The tree publish would push'])
  if (user) {
    // i18n:check rewrites the catalogs as `user`, and git apply wrote them with this user's umask.
    await run(['chmod', '-R', 'o+w', 'src/locales', 'backend/src/emails/locales'], { cwd: repoDir })
    await openSnapshots(run, repoDir)
  }
  return runPrChecks({ ticket: task.identifier ?? task.fp, user, repoDir, run, ...rest })
}

/** Git modes of a symlink and a submodule: either can point a reviewed path at anything. */
const linkModes = new Set(['120000', '160000'])

/** Whether a patch makes `file` a symlink or submodule, or changes one. */
const isLink = (file: PatchedFile) => file.modes.some((m) => linkModes.has(m))

/**
 * Lets other users write the snapshot files in the checkout, which git wrote with this user's umask. Bun opens a test
 * file's `.snap` for writing even when every snapshot in it matches, and fails the test when it cannot. Their folders
 * stay closed: with `CI=true` Bun never adds a snapshot, so a missing one fails as it does in CI, and a user who could
 * swap a `.snap` for a symlink would point verify-tests' second chmod at any file of this user.
 */
const openSnapshots = async (run: Run, repoDir: string) => {
  const pathspec = '*/__snapshots__/*.snap'
  const listed = await run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', pathspec], {
    cwd: repoDir,
  })
  // A snapshot the patch deletes stays in the index of a checkout that git apply changed.
  const files = listed.split('\0').filter((file) => file && existsSync(join(repoDir, file)))
  if (files.length) await run(['chmod', '--', 'o+w', ...files], { cwd: repoDir })
}

/** Three levels under the repo root, like a repro spec, so imports and the Playwright project match. */
const checkPath = (outDir: string, fp: string) => join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts')

/** The replay's own allow-list check, with `${EMAIL}` as the only variable. */
const flowProblems = (platform: string, flow: string) => {
  const check = checkMaestroFlow(flow, { appId: platformOf(platform).appId ?? '', vars: flowVars })
  return check.ok ? [] : check.problems
}

/**
 * Problems with what the patch must make pass: an edited repro spec or flow, or a visual check that is missing or
 * fails the lint. Whether the checks passed comes from `missingPasses`.
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
  return problems.map((problem) => `visual check: ${problem}`)
}

type PassesOptions = {
  task: FixTask
  verifyNative: NativeCheck[]
  unitTests: boolean
  artifacts: Set<string>
  attempt: string
  /** The platforms whose native check was inconclusive, which only leave the ticket for later. */
  inconclusive: string[]
}

/**
 * The reason for each check the task needs whose pass is missing. The workflow uploads
 * `qa-pass-<fp>-<check>-<run attempt>` only under an `if:` on the step outcomes the runner keeps, and `artifacts` lists
 * the run's artifact names, so no file that code the agent wrote could rewrite carries a verdict. Only passes of
 * `attempt`, the one whose patch publish read, count: artifacts of every attempt of the run share one list.
 */
const missingPasses = ({ task, verifyNative, unitTests, artifacts, attempt, inconclusive }: PassesOptions) => {
  const web = !('flow' in task)
  const checks = [
    { check: 'session', needed: true, reason: 'the fix session did not finish' },
    {
      check: 'replay',
      needed: 'spec' in task && !task.real,
      reason: 'the repro spec did not pass three times on the patched code',
    },
    {
      check: 'visual',
      needed: web && task.kind === 'visual',
      reason: 'the visual check did not fail three times without the patch and pass three times with it',
    },
    {
      check: 'tests',
      needed: web,
      reason: unitTests
        ? "the patch's unit tests did not fail without the fix and pass with it"
        : `${noTestReason}, and every web fix needs one that fails without the fix`,
    },
    {
      check: 'real',
      needed: task.real && 'spec' in task,
      reason:
        'the repro spec still fails on the real AI providers. That run used the patched frontend and the backend from before the patch',
    },
    ...verifyNative
      .filter((v) => v.fp === task.fp)
      .map((v) => ({
        check: v.platform,
        needed: !inconclusive.includes(v.platform),
        reason: `the flow still fails on the native platform (${v.platform}). That run used the patched app and the backend from before the patch`,
      })),
  ]
  return checks
    .filter(({ check, needed }) => needed && !artifacts.has(`qa-pass-${task.fp}-${check}-${attempt}`))
    .map(({ reason }) => reason)
}

/**
 * Why the agent's output must not become a PR (empty = it may), the files its patch touches, and whether it adds or
 * changes a unit test file. `verifyNative` is the trusted plan's, never anything the fix agent wrote.
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
  if (!text.trim()) return { reasons: ['empty patch', ...reasons], files: [], unitTests: false }
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
      ...files.filter(isLink).map((f) => `adds or changes a symlink or submodule: ${f.path}`),
    ],
    files: files.map((f) => f.path),
    unitTests: testRuns(files).length > 0,
  }
}

/** The task of `fp` in `fix-plan.json`, and the plan's native checks. */
const planTask = async (outDir: string, fp: string) => {
  const { fixes, verifyNative }: FixPlan = await Bun.file(join(outDir, 'fix-plan.json')).json()
  const task = fixes.find((t) => t.fp === fp)
  if (!task) throw new Error(`${fp} is not in fix-plan.json`)
  return { task, verifyNative }
}

const oneLine = (text: string) => text.replace(/[\p{Cc}\s]+/gu, ' ').trim()

type PublishOptions = {
  outDir: string
  fp: string
  live: boolean
  key?: string
  token?: string
  /** The run attempt (`GITHUB_RUN_ATTEMPT`) whose fix output and passes publish reads. */
  attempt?: string
  /** `GITHUB_STEP_SUMMARY`, which names a ticket left for a later run. */
  summary?: string
  repoDir?: string
  run?: Run
  fetchFn?: typeof fetch
  log?: (line: string) => void
}
type PublishResult =
  | { outcome: 'pr'; branch: string; files: string[]; spec?: string; commit: string; prUrl?: string }
  | { outcome: 'human-required'; reasons: string[] }
  | { outcome: 'infrastructure'; reason: string }
  | { outcome: 'already-fixed'; commit: string }

/** What the fix job wrote to `status/<fp>.json`; publish refuses a file that does not match. */
const stopReason = z.enum(['setup-failed', 'no-model-answer', 'already-passes'])
const fixStatus = z.object({ stoppedBeforeSession: stopReason.nullable() })
const stoppedReasons = {
  'setup-failed': 'The fix job failed before the fix step ran.',
  'no-model-answer':
    'The fix step failed before the model first answered: setup, the CLI install or a refused request.',
} satisfies Record<Exclude<z.infer<typeof stopReason>, 'already-passes'>, string>

const reviewNotice =
  'An AI agent wrote this change. Review it like an outside contribution: the QA pipeline never merges, approves or marks PRs ready.'

const intro = 'Draft fix by the weekly QA agent.'

/** Why the PR adds no regression spec, for each reason of `whyNoSpec` but security and native. */
const noSpecText = {
  onboarding:
    'The repro runs on the onboarding build, which the Playwright config of e2e/ does not serve, so the PR adds no regression spec.',
  real: 'The repro passed on the real AI providers, and the consumer project of e2e/ runs on the fake provider, so the PR adds no regression spec.',
  unit: 'The unit test in this patch guards the fix. The bug shows without a real browser, so the PR adds no end-to-end spec.',
}

/**
 * The commit and draft PR a passing fix becomes, given the regression spec `stage` adds, if any (see `whyNoSpec`).
 * The description leaves the ticket out: the branch name links the PR to it. The repo is public and a security fix's
 * PR shows up before the fix ships, so that PR's title names only the ticket and nothing says "security".
 */
const draftOf = (task: FixTask, spec: { path: string } | undefined) => {
  const why = whyNoSpec(task)
  if (why === 'security') {
    const title = `fix: QA finding ${task.identifier ?? task.fp}`
    const body = [intro, 'The finding stays out of this PR, and so does any regression spec.', reviewNotice].join(
      '\n\n',
    )
    return { title, commit: title, body }
  }
  const title = `fix: ${oneLine(task.finding.title)}`.slice(0, 100).trimEnd()
  // A code span, so a model-written title cannot @mention anyone.
  const findingLine = `**Finding:** \`${oneLine(task.finding.title).replaceAll('`', "'")}\` · ${task.finding.area} · ${task.severity}`
  if (why === 'native') {
    // A Maestro flow needs the QA stack and a fresh address per run, so it does not become a regression spec.
    const checked = `Checked on ${task.platform} with ${task.kind === 'spec' ? "the finding's Maestro flow" : "the fix agent's Maestro check"}`
    const body = [intro, findingLine, `${checked}. The PR adds no regression spec.`, reviewNotice].join('\n\n')
    return { title, commit: `${title}\n\n${checked}.`, body }
  }
  if (why || !spec) {
    const text = noSpecText[why ?? 'unit']
    const body = [intro, findingLine, text, reviewNotice].join('\n\n')
    return { title, commit: `${title}\n\n${text}`, body }
  }
  const [origin, proof] =
    task.kind === 'spec'
      ? ["the QA agent's repro", 'The repro spec, which the replay confirmed, is added with its assertions unchanged']
      : [
          "the fix agent's visual check",
          "The fix agent's check, which failed without this patch and passes with it, is added",
        ]
  const body = [intro, findingLine, `${proof} as \`${spec.path}\`.`, reviewNotice].join('\n\n')
  return { title, commit: `${title}\n\nKeeps ${origin} as the regression test ${spec.path}.`, body }
}

/**
 * Turns the fix agent's output for one routed ticket into a draft PR, or hands the ticket to a person. Deterministic,
 * no LLM. Dry unless `live`: a dry run validates and returns the plan without touching the checkout, GitHub or Linear.
 *
 * The publish job downloads the file job's `qa-out` artifact and only `qa-out/fix/` (plus `qa-out/fix-<fp>/repro/`
 * for a visual task) from the fix job:
 * - `fix/<fp>.patch`: `git add -A && git diff --cached --binary HEAD`, taken by the workflow after the agent ran;
 * - `fix/<fp>.spec.ts` (`fix/<fp>.yaml` for a native flow): the repro as the agent left it, compared with the original;
 * - for a visual task, the agent's check in `fix-<fp>/repro/`;
 * - `fix/<fp>.diagnosis.md`: written when the agent gave up, or by the workflow when a check failed; any patch is then
 *   ignored;
 * - `status/<fp>.json`, from the `qa-fix-status-<fp>` artifact the fix job uploads with every outcome: whether the
 *   job stopped before the fix session began. If so nothing was diagnosed, so the ticket is left untouched for a
 *   later run, and the result and the run summary say why. When `artifacts.txt` lists no status of `attempt`, the
 *   job died before it recorded anything (a lost runner), its key scan failed, or it did not run in that attempt,
 *   and the ticket is left untouched the same way. A malformed file, or a listed status whose file is missing, fails publish. One reason,
 *   `already-passes`, means the repro passed three times on the commit before any agent code ran: with the
 *   `qa-pass-<fp>-unpatched-<attempt>` pass the ticket gets a comment saying so, and no PR and no label.
 * Both artifacts carry the run attempt in their name, and the workflow downloads those of `attempt`. Publish also
 * reads `artifacts.txt`, the names of the run's artifacts, and needs a `qa-pass-<fp>-<check>-<attempt>` for every
 * check the task needs (`missingPasses`). A missing `artifacts.txt` fails publish.
 * A missing patch, a diagnosis, a rejected patch or a missing pass means no PR: the ticket gets a comment and the
 * `Human Required` label. A native check whose pass is missing but whose `qa-inconclusive-<fp>-<platform>-<attempt>`
 * marker is listed reached the screen in too few runs to tell: with no other reason, the ticket is left untouched
 * for a later run. A patch that passed all that but lacks the `checks` pass, which the PR checks gate uploads
 * when the tree `stage` builds passes `prChecks`, leaves the ticket untouched for a later run, like a fix job that
 * stopped before its session. Otherwise
 * the task's branch gets one commit under the git identity the workflow configured, is pushed with `token` (a
 * GitHub App token; check out with `persist-credentials: false` so no second auth header competes), and becomes a
 * draft PR, whose link goes on the ticket as a comment. The push fails if the branch appeared on origin after route
 * checked it, so a person's branch is never extended or overwritten.
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
  attempt = '1',
  summary,
  repoDir = '.',
  run = runCommand,
  fetchFn = fetch,
  log = console.log,
}: PublishOptions): Promise<PublishResult> => {
  if (live && (!key || !token)) throw new Error('--live needs LINEAR_API_KEY and GH_TOKEN')
  const { task, verifyNative } = await planTask(outDir, fp)
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
  // The pipeline's failure: no write anywhere, so a later run tries the ticket again.
  const leaveForLater = async (reason: string): Promise<PublishResult> => {
    const line = `${task.identifier ?? fp} is left untouched for a later run: ${reason}`
    log(line)
    if (summary) await appendFile(summary, `- ${line}\n`)
    return { outcome: 'infrastructure', reason }
  }

  const artifacts = new Set((await readFile(join(outDir, 'artifacts.txt'), 'utf8')).split('\n').filter(Boolean))
  if (!artifacts.has(`qa-fix-status-${fp}-${attempt}`)) {
    return leaveForLater(
      `the run has no fix status from attempt ${attempt}: the fix job died before it recorded anything, ` +
        'or it did not run in this attempt',
    )
  }
  // The fix job records and uploads this before any code the agent wrote runs outside its sandbox. A process the
  // sandbox let outlive the session could still rewrite the execution file or this record before the upload (whether
  // the sandbox blocks writes to $RUNNER_TEMP is unconfirmed). At worst its own ticket is left untouched: this file
  // can only stop publish.
  const { stoppedBeforeSession } = fixStatus.parse(await Bun.file(join(outDir, 'status', `${fp}.json`)).json())
  if (stoppedBeforeSession === 'already-passes') {
    // The pass, uploaded before the fix step, is the proof. Without it the record may be a rewrite, so it only stops.
    if (!artifacts.has(`qa-pass-${fp}-unpatched-${attempt}`)) {
      return leaveForLater('the fix status says the repro already passes, but the run has no pass of that replay')
    }
    const commit = (await run(['git', 'rev-parse', 'HEAD'], { cwd: repoDir })).trim()
    const body =
      `The repro spec passes on main at commit ${commit}, three runs out of three, so no fix PR was opened. ` +
      'Another change probably fixed this bug. A person can check and close this ticket.'
    if (!live) log(`[dry run] would comment on ${task.identifier ?? fp}:\n${body}`)
    else await addComment(auth, issueId, body)
    const line = `${task.identifier ?? fp} already passes its repro on main at ${commit}, so no fix PR was opened`
    if (summary) await appendFile(summary, `- ${line}\n`)
    return { outcome: 'already-fixed', commit }
  }
  if (stoppedBeforeSession) return leaveForLater(stoppedReasons[stoppedBeforeSession])
  if (!(await Bun.file(join(outDir, 'fix', `${fp}.patch`)).exists())) {
    const reason = `the fix job uploaded no output in run attempt ${attempt}`
    return handOff(
      [reason],
      `There is no PR: ${reason}. Its secret scan failed, or the job stopped after it recorded its status.`,
    )
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
  const checked = await checkPatch(run, outDir, task, verifyNative)
  const { files } = checked
  const inconclusive = verifyNative
    .filter((v) => v.fp === fp && artifacts.has(`qa-inconclusive-${fp}-${v.platform}-${attempt}`))
    .map((v) => v.platform)
  const passes = { task, verifyNative, unitTests: checked.unitTests, artifacts, attempt, inconclusive }
  const reasons = [...checked.reasons, ...missingPasses(passes)]
  if (reasons.length) {
    return handOff(
      reasons,
      `The fix agent's patch was rejected, so there is no PR:\n\n${reasons.map((r) => `- ${sanitize(r, 300)}`).join('\n')}`,
    )
  }
  if (inconclusive.length) {
    return leaveForLater(
      `the native check on ${inconclusive.join(' and ')} reached the screen in too few runs to tell whether the patch works`,
    )
  }

  // Last, so a patch that also fails a check above goes to a person.
  if (!artifacts.has(`qa-pass-${fp}-checks-${attempt}`)) {
    return leaveForLater('the PR checks gate did not pass')
  }

  const { branch } = task
  if (!live) {
    const spec = await promotedSpec(outDir, task)
    const { commit, body } = draftOf(task, spec)
    log(`[dry run] would push ${branch} with:\n${commit}\n\nand open a draft PR:\n${body}`)
    return { outcome: 'pr', branch, files, spec: spec?.path, commit }
  }

  // No git hooks: they would run code from the patched tree while this job holds the write token.
  const git = noHooksGit(run)
  await git(['switch', '--create', branch])
  const spec = await stage(run, outDir, task, repoDir)
  const { title, commit, body } = draftOf(task, spec)
  await git(['commit', '--no-verify', '--quiet', '--message', commit])
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  // An empty expected value in the lease means the remote branch must not exist yet.
  await git(
    ['push', '--no-verify', `--force-with-lease=refs/heads/${branch}:`, 'origin', `HEAD:refs/heads/${branch}`],
    {
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      },
    },
  )
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
    await route({ outDir: values.out, live: values.live, key })
  } else if (positionals[0] === 'publish' && values.fp) {
    const result = await publish({
      outDir: values.out,
      fp: values.fp,
      live: values.live,
      key,
      token: Bun.env.GH_TOKEN,
      attempt: Bun.env.GITHUB_RUN_ATTEMPT,
      summary: Bun.env.GITHUB_STEP_SUMMARY,
    })
    console.log(JSON.stringify(result, null, 2))
  } else if (positionals[0] === 'tests' && values.fp) {
    const result = await checkTests({ outDir: values.out, fp: values.fp, user: Bun.env.QA_TEST_USER })
    console.log(JSON.stringify(result))
    // The workflow uploads the pass on this exit code, never on anything the tests could write.
    process.exitCode = result.failsWithout && result.passesWith ? 0 : 1
  } else if (positionals[0] === 'gate' && values.fp) {
    const failed = await runGate({
      outDir: values.out,
      fp: values.fp,
      user: Bun.env.QA_TEST_USER,
      summary: Bun.env.GITHUB_STEP_SUMMARY,
    })
    // As for the tests: the pass rests on this exit code alone.
    process.exitCode = failed ? 1 : 0
  } else {
    throw new Error(
      'usage: fix.ts route --out DIR [--live] | fix.ts publish --out DIR --fp FP [--live] | ' +
        'fix.ts tests|gate --out DIR --fp FP',
    )
  }
}
