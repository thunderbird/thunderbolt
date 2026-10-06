#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { linear } from '../../../scripts/notify-on-failure'
import {
  type Action,
  addComment,
  type Filed,
  type LinearAuth,
  priority,
  sanitize,
  secretPattern,
  ticketView,
} from './file-findings'
import { type Area, type Finding, findingSchema, lintReproSpec, realAiCharters } from './findings'
import type { Verified } from './verify'

const fixableAreas = new Set<Area>(['chat', 'settings', 'skills', 'projects', 'widgets', 'layout', 'i18n'])
const ticketActions = new Set<Action | undefined>(['created', 'regression', 'commented'])
const maxFixes = 3
const humanRequired = 'human required'

/** A fix may change only app code, as `.github/qa/fix.md` says; `publish` adds the regression spec itself. */
const allowedPaths = /^(src|shared|backend\/src)\//
/** Sensitive app code: database schema, migrations, sync, and any path naming sign-in, sessions, devices or keys. */
const sensitivePaths =
  /^(src|backend\/src)\/db\/|auth|sso|session|device|sign-?in|log-?(in|out)|otp|approv|recovery|secret|credential|crypto|encrypt|powersync|drizzle|migration/i
/** True when `path` (repo-relative) is sensitive app code that no automated change may touch. */
export const isSensitive = (path: string) => sensitivePaths.test(path)
/** True when a fix PR must not touch `path` (repo-relative): anything outside app code, or sensitive app code. */
export const isDenied = (path: string) => !allowedPaths.test(path) || isSensitive(path)

type Ticket = Pick<Filed, 'fp' | 'severity' | 'issueId' | 'identifier' | 'url'>
/** One fix-job matrix entry. `finding` holds the only ticket fields the fix agent sees. */
export type FixTask = Ticket & {
  charterDir: string
  spec: string
  finding: Pick<Finding, 'title' | 'area' | 'viewport' | 'oracle' | 'steps' | 'expected' | 'actual'>
}
/** `qa-out/fix-plan.json`. The workflow's fix matrix is `fixes`. */
export type FixPlan = { fixes: FixTask[]; humanRequired: (Ticket & { area: Area })[] }

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

/** Label tickets the filer created `human required`, looking the label up once. */
const markHumanRequired = async ({ fetchFn, key }: LinearAuth, issueIds: string[]) => {
  if (issueIds.length === 0) return
  const { issueLabels } = await linear<{ issueLabels: { nodes: { id: string; team: { name: string } | null }[] } }>(
    fetchFn,
    key,
    'query Label($name: String!) { issueLabels(first: 50, filter: { name: { eq: $name } }) { nodes { id team { name } } } }',
    { name: humanRequired },
  )
  const label = issueLabels.nodes.find((l) => !l.team || l.team.name === 'Thunderbolt')
  if (!label) throw new Error(`Missing Linear label: ${humanRequired}`)
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
  run?: Run
  fetchFn?: typeof fetch
  log?: (line: string) => void
}

/**
 * Decide in code which filed tickets the fix agent may attempt, and write `fix-plan.json`.
 * A ticket (created, regression or commented) qualifies when its finding was confirmed 3/3, its repro spec is
 * on disk, its area is fixable, and no `qa-fix/<fp>` branch exists yet (an earlier draft PR is still open).
 * At most three, highest severity first. Security findings are never routed. Every other area (sync, auth,
 * models, data, onboarding, …) needs a person, and so does every real-AI finding, because the fix job checks a fix
 * on the fake AI: with `live` those tickets get the `human required` label.
 * With `live` only tickets that exist count, so a filing forced into a dry run starts no fix agent; a dry run
 * plans what a live filing would have created.
 */
export const route = async ({
  outDir,
  live,
  key,
  run = runCommand,
  fetchFn = fetch,
  log = console.log,
}: RouteOptions) => {
  if (live && !key) throw new Error('--live needs LINEAR_API_KEY')
  const filed: Filed[] = await Bun.file(join(outDir, 'filed.json')).json()
  const { confirmed }: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const branches = await run(['git', 'ls-remote', '--heads', 'origin', 'qa-fix/*'])
  const pending = new Set(branches.match(/(?<=refs\/heads\/qa-fix\/)\S+/g))
  const plan: FixPlan = { fixes: [], humanRequired: [] }
  const tickets = filed
    .filter((f) => ticketActions.has(f.action === 'dry-run' && !live ? f.would : f.action))
    .sort((a, b) => priority[a.severity] - priority[b.severity])
  for (const { fp, severity, issueId, identifier, url, charterDir, id } of tickets) {
    const verified = confirmed.find((v) => v.charterDir === charterDir && v.id === id)
    if (!verified) continue
    const finding = findingSchema.parse(verified.finding)
    const ticket = { fp, severity, issueId, identifier, url }
    if (finding.area === 'security') continue
    if (!fixableAreas.has(finding.area) || realAiCharters.has(charterDir)) {
      plan.humanRequired.push({ ...ticket, area: finding.area })
      continue
    }
    const spec = join(outDir, charterDir, finding.repro_spec)
    if (plan.fixes.length === maxFixes || pending.has(fp) || !(await Bun.file(spec).exists())) continue
    // Two charters can confirm one bug (same fp) in a run; a second fix job would fight over `qa-fix/<fp>`.
    pending.add(fp)
    plan.fixes.push({ ...ticket, charterDir, spec, finding: ticketView(finding) })
  }
  await writeFile(join(outDir, 'fix-plan.json'), JSON.stringify(plan, null, 2))
  log(`fix: ${plan.fixes.map((t) => t.fp).join(', ') || 'none'}`)
  log(`${humanRequired}: ${plan.humanRequired.map((t) => t.fp).join(', ') || 'none'}`)
  if (!live || !key) return plan
  await markHumanRequired(
    { fetchFn, key },
    plan.humanRequired.flatMap((t) => (t.issueId ? [t.issueId] : [])),
  )
  return plan
}

/** Named exports of `e2e/test.ts`; a spec importing only these can switch to the repo fixture. */
const e2eTestExports = new Set(['test', 'expect', 'Page', 'Request', 'Route'])

/**
 * The repro spec as a permanent regression test. The name matches a Playwright project so
 * `scripts/check-e2e-specs-collected.ts` accepts it: `sync-qa-` for the two-device charter (the only one on
 * Postgres + PowerSync), `consumer-qa-` for the rest, which replay against the consumer pair. Imports move from
 * `qa-out/<charter>/repro/` to `e2e/`, and `@playwright/test` becomes `./test` like every other spec (it adds
 * WebKit's persistent profile and the attestation stub) unless the spec imports something `./test` lacks.
 */
export const regressionSpec = (charterDir: string, fp: string, source: string) => ({
  path: `e2e/${charterDir.startsWith('c7-') ? 'sync' : 'consumer'}-qa-${fp}.spec.ts`,
  source: source
    .replace(/(from\s*)(['"])\.\.\/\.\.\/\.\.\/e2e\/helpers\2/g, '$1$2./helpers$2')
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

/** Why the agent's output must not become a PR (empty = it may), and the files its patch touches. */
export const checkPatch = async (run: Run, outDir: string, task: FixTask) => {
  const patch = resolve(outDir, 'fix', `${task.fp}.patch`)
  const original = await readFile(task.spec, 'utf8')
  const reasons = lintReproSpec(original).map((problem) => `repro spec: ${problem}`)
  if ((await readFile(join(outDir, 'fix', `${task.fp}.spec.ts`), 'utf8')) !== original) {
    reasons.push('the repro spec was edited')
  }
  const text = await readFile(patch, 'utf8')
  if (!text.trim()) return { reasons: ['empty patch', ...reasons], files: [] }
  // The patch becomes a public PR.
  if (secretPattern.test(text)) reasons.push('the patch matches a secret pattern')
  const files = await patchedFiles(run, patch)
  return {
    reasons: [
      ...reasons,
      ...files.filter((f) => isDenied(f.path)).map((f) => `touches ${f.path}`),
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
  | { outcome: 'pr'; branch: string; files: string[]; spec: string; commit: string; prUrl?: string }
  | { outcome: 'human-required'; reasons: string[] }

/**
 * Turn the fix agent's output for one routed ticket into a draft PR, or hand the ticket to a person.
 * Deterministic, no LLM. Dry unless `live`: a dry run validates and returns the plan without touching the
 * checkout, GitHub or Linear.
 *
 * The publish job downloads the file job's `qa-out` artifact and ONLY `qa-out/fix/` from the fix job:
 * - `fix/<fp>.patch`: `git add -A && git diff --cached --binary HEAD`, taken by the workflow after the agent ran;
 * - `fix/<fp>.spec.ts`: the repro spec as the agent left it, compared with the original;
 * - `fix/<fp>.diagnosis.md`: written when the agent gave up; any patch is then ignored.
 * A diagnosis or a rejected patch (empty, a denied path, an edited spec) means no PR: the ticket gets a comment
 * and the `human required` label. Otherwise branch `qa-fix/<fp>` gets one commit (the patch plus the repro spec
 * as a regression test) under the git identity the workflow configured, is pushed with `token` (a GitHub App
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
  const { fixes }: FixPlan = await Bun.file(join(outDir, 'fix-plan.json')).json()
  const task = fixes.find((t) => t.fp === fp)
  if (!task) throw new Error(`${fp} is not in fix-plan.json`)
  const issueId = task.issueId ?? ''
  if (live && !issueId) throw new Error(`${fp} has no Linear ticket: the findings were filed in a dry run`)
  const auth = { fetchFn, key: key ?? '' }

  const handOff = async (reasons: string[], body: string): Promise<PublishResult> => {
    if (!live) log(`[dry run] would comment on ${task.identifier ?? fp} and label it "${humanRequired}":\n${body}`)
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
  const { reasons, files } = await checkPatch(run, outDir, task)
  if (reasons.length) {
    return handOff(
      reasons,
      `The fix agent's patch was rejected, so there is no PR:\n\n${reasons.map((r) => `- ${sanitize(r, 300)}`).join('\n')}`,
    )
  }

  const branch = `qa-fix/${fp}`
  const spec = regressionSpec(task.charterDir, fp, await readFile(task.spec, 'utf8'))
  const title = `fix: ${oneLine(task.finding.title)}`.slice(0, 100).trimEnd()
  const commit = `${title}\n\nKeeps the QA agent's repro as the regression test ${spec.path}.`
  const body = [
    `Draft fix by the weekly QA agent for ${task.identifier ?? 'its Linear ticket'} (${task.url ?? 'filed in a dry run'}).`,
    // A code span, so a model-written title cannot @mention anyone.
    `**Finding:** \`${oneLine(task.finding.title).replaceAll('`', "'")}\` · ${task.finding.area} · ${task.severity}`,
    `The repro spec, which failed 3 of 3 replays, is added with its assertions unchanged as \`${spec.path}\`.`,
    'An AI agent wrote this change. Review it like an outside contribution: the QA pipeline never merges, approves or marks PRs ready.',
  ].join('\n\n')
  if (!live) {
    log(`[dry run] would push ${branch} with:\n${commit}\n\nand open a draft PR:\n${body}`)
    return { outcome: 'pr', branch, files, spec: spec.path, commit }
  }

  const patch = resolve(outDir, 'fix', `${fp}.patch`)
  // No git hooks: they would run code from the patched tree while this job holds the write token.
  const git = (args: string[], opts?: Parameters<Run>[1]) =>
    run(['git', '-c', 'core.hooksPath=/dev/null', ...args], opts)
  await git(['switch', '--create', branch])
  await git(['apply', '--index', patch])
  await writeFile(join(repoDir, spec.path), spec.source)
  await git(['add', spec.path])
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
  return { outcome: 'pr', branch, files, spec: spec.path, commit, prUrl }
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
    const result = await publish({ outDir: values.out, fp: values.fp, live: values.live, key, token: Bun.env.GH_TOKEN })
    console.log(JSON.stringify(result, null, 2))
  } else {
    throw new Error('usage: fix.ts route --out DIR [--live] | fix.ts publish --out DIR --fp FP [--live]')
  }
}
