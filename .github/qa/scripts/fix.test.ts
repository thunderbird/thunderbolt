/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as prettier from 'prettier'
import type { Filed } from './file-findings'
import type { Area, RawFinding, Severity } from './findings'
import {
  checkPatch,
  checkTests,
  type FixPlan,
  type FixTask,
  isDenied,
  type NativeCheck,
  type PrCheck,
  publish,
  regressionSpec,
  route,
  type Run,
  noLinks,
  runGate,
  testRuns,
  whyNoSpec,
} from './fix'
import type { Verified, VerifiedFinding } from './verify'

const spec = `import { expect, test } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('rename keeps the title', async ({ page }) => {
  await loginViaEmailCode(page)
  await expect(page.getByText('Renamed')).toBeVisible()
})
`

const finding = (area: Area, extra: Partial<RawFinding> = {}): RawFinding => ({
  title: `${area} breaks`,
  area,
  charter: 'c2-chat',
  viewport: 'desktop',
  oracle: { type: 'page-error', evidence: 'TypeError: x is undefined' },
  steps: ['Open the app'],
  expected: 'It works',
  actual: 'It throws',
  repro_spec: 'repro/1.spec.ts',
  ...extra,
})

/** A function usable as `fetch` (adds the `preconnect` member Bun's type requires). */
const asFetch = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(fn, { preconnect: () => {} })

type Call = { op: string; variables: Record<string, string> }
const fakeLinear = (calls: Call[]) =>
  asFetch(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body))
    const op = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    calls.push({ op, variables })
    const data = {
      Label: {
        issueLabels: {
          nodes: [
            { id: 'label-other', team: { name: 'Other' } },
            { id: 'label-hr', team: null },
          ],
        },
      },
      AddLabel: { issueAddLabel: { success: true } },
      Comment: { commentCreate: { success: true } },
    }[op]
    return Response.json({ data })
  })

type RunCall = { cmd: string[]; env?: Record<string, string>; stdin?: string }
/** `outputs` is keyed by the command's first two words. */
const fakeRun = (calls: RunCall[], outputs: Record<string, string> = {}): Run => {
  return async (cmd, opts = {}) => {
    calls.push({ cmd, ...opts })
    return outputs[cmd.slice(0, 2).join(' ')] ?? ''
  }
}

const runIn =
  (cwd: string): Run =>
  async (cmd, { env } = {}) => {
    const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    return proc.stdout.toString()
  }

let dir: string
let outDir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qa-fix-'))
  outDir = join(dir, 'qa-out')
  await mkdir(join(outDir, 'fix'), { recursive: true })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** A git repo at `repo` whose first commit holds `files`. */
const initRepo = async (repo: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) await put(join(repo, path), text)
  const git = runIn(repo)
  await git(['git', 'init', '--quiet'])
  await git(['git', 'add', '-A'])
  await git(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init'])
}

/** Writes the fix job's patch of `files` in `repo`, the way the workflow collects it, and resets the checkout. */
const writePatch = async (
  repo: string,
  fp: string,
  files: Record<string, string>,
  renames: [string, string][] = [],
) => {
  const git = runIn(repo)
  for (const [from, to] of renames) await git(['git', 'mv', from, to])
  for (const [path, text] of Object.entries(files)) await put(join(repo, path), text)
  await git(['git', 'add', '--all'])
  await put(join(outDir, 'fix', `${fp}.patch`), await git(['git', 'diff', '--cached', '--binary', 'HEAD']))
  await git(['git', 'reset', '--quiet', '--hard'])
}

/** Runs a command with its output thrown away and returns its exit code. */
const quiet = async (cmd: string[], cwd: string) =>
  Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited

describe('route', () => {
  type Row = { id: string; area: Area; severity: Severity; action: Filed['action']; would?: Filed['action'] }
  const rows: Row[] = [
    { id: 'low-chat', area: 'chat', severity: 'Low', action: 'created' },
    { id: 'urgent-settings', area: 'settings', severity: 'Urgent', action: 'regression' },
    { id: 'high-skills', area: 'skills', severity: 'High', action: 'commented' },
    { id: 'medium-widgets', area: 'widgets', severity: 'Medium', action: 'created' },
    { id: 'high-sync', area: 'sync', severity: 'High', action: 'created' },
    { id: 'high-security', area: 'security', severity: 'High', action: 'created' },
    { id: 'suppressed-chat', area: 'chat', severity: 'Urgent', action: 'suppressed' },
    { id: 'pending-layout', area: 'layout', severity: 'Urgent', action: 'dry-run', would: 'created' },
    { id: 'nospec-chat', area: 'chat', severity: 'Urgent', action: 'created' },
    { id: 'flaky-chat', area: 'chat', severity: 'Urgent', action: 'created' },
  ]
  const fp = (id: string) => `fp-${id}`

  const setup = async () => {
    const filed = rows.map(({ id, severity, action, would }) => {
      const entry: Filed = { fp: fp(id), charterDir: 'c2-chat', id, severity, action, would }
      if (action === 'dry-run') return entry
      return { ...entry, issueId: `issue-${id}`, identifier: `THB-${id}`, url: `https://linear.app/${id}` }
    })
    const confirmed: VerifiedFinding[] = rows
      .filter(({ id }) => id !== 'flaky-chat')
      .map(({ id, area }) => ({
        charterDir: 'c2-chat',
        id,
        finding: finding(area, {
          repro_spec: `repro/${id}.spec.ts`,
          oracle: { type: 'page-error', evidence: 'Error at https://evil.example/x' },
        }),
        replay: { failed: 3, runs: 3 },
        artifacts: {},
      }))
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    for (const { id } of rows) {
      if (id !== 'nospec-chat') await put(join(outDir, 'c2-chat', 'repro', `${id}.spec.ts`), spec)
    }
  }
  const branches = { 'gh pr': `qa-fix/${fp('pending-layout')}\n` }

  test('routes every confirmed ticket of any area, highest severity first, skipping tickets with an open PR', async () => {
    await setup()
    const runs: RunCall[] = []
    const lines: string[] = []
    const plan = await route({ outDir, live: false, run: fakeRun(runs, branches), log: (line) => lines.push(line) })

    expect(lines).toContain(`fix: ${fp('nospec-chat')} has no repro on disk, so it is not routed`)
    expect(lines).toContain(`fix: ${fp('pending-layout')} already has an open PR, so it is not routed`)
    const routed = ['urgent-settings', 'high-skills', 'high-sync', 'high-security', 'medium-widgets', 'low-chat']
    expect(plan.fixes.map((t) => t.fp)).toEqual(routed.map(fp))
    // Without a Linear key nothing is looked up, so every branch is the identifier-only one.
    expect(plan.fixes.map((t) => t.branch)).toEqual(routed.map((id) => `qa-fix/thb-${id}`))
    expect(lines.at(-1)).toBe(`fix: ${routed.map(fp).join(', ')}`)
    expect(JSON.parse(await readFile(join(outDir, 'fix-plan.json'), 'utf8'))).toEqual(plan)
    expect(runs.map((r) => r.cmd.slice(0, 3))).toEqual([
      ['git', 'ls-remote', '--heads'],
      ['gh', 'pr', 'list'],
    ])
  })

  test('gives the fix agent the sanitized ticket fields and a runnable spec path, nothing else', async () => {
    await setup()
    const plan = await route({ outDir, live: false, run: fakeRun([], branches), log: () => {} })
    const [first] = plan.fixes
    expect(first).toMatchObject({
      kind: 'spec',
      real: false,
      spec: join(outDir, 'c2-chat', 'repro', 'urgent-settings.spec.ts'),
    })
    expect(first.finding).toEqual({
      title: 'settings breaks',
      area: 'settings',
      viewport: 'desktop',
      oracle: { type: 'page-error', evidence: 'Error at [link removed]' },
      steps: ['Open the app'],
      expected: 'It works',
      actual: 'It throws',
    })
  })

  test('a live run routes nothing when filing was forced into a dry run', async () => {
    await setup()
    const filed: Filed[] = JSON.parse(await readFile(join(outDir, 'filed.json'), 'utf8'))
    const braked = filed.map(({ fp, charterDir, id, severity, action }) => ({
      fp,
      charterDir,
      id,
      severity,
      action: 'dry-run' as const,
      would: action,
    }))
    await put(join(outDir, 'filed.json'), JSON.stringify(braked))

    const plan = await route({ outDir, live: true, run: fakeRun([], {}), log: () => {} })

    expect(plan).toEqual({ fixes: [], verifyNative: [] })
  })

  const fileTickets = async (tickets: { fp: string; charterDir: string; raw: RawFinding }[]) => {
    const filed: Filed[] = tickets.map(({ fp, charterDir }) => ({
      fp,
      charterDir,
      id: '1',
      severity: 'High',
      action: 'created',
    }))
    const confirmed: VerifiedFinding[] = tickets.map(({ charterDir, raw }) => ({
      charterDir,
      id: '1',
      finding: raw,
      replay: { failed: 3, runs: 3 },
      artifacts: {},
    }))
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    for (const { charterDir, raw } of tickets) {
      if (raw.repro_spec) await put(join(outDir, charterDir, raw.repro_spec), spec)
      if (raw.repro_flow) await put(join(outDir, charterDir, raw.repro_flow), '- launchApp\n')
    }
  }
  const routeOne = async (charterDir: string, raw: RawFinding) => {
    await fileTickets([{ fp: 'fp-one', charterDir, raw }])
    return route({ outDir, live: false, run: fakeRun([]), log: () => {} })
  }
  const visual = (area: Area, extra: Partial<RawFinding> = {}) =>
    finding(area, {
      oracle: { type: 'visual', evidence: 'Continue sits under the banner' },
      screenshot: 'mcp/page-1.png',
      element: 'button "Continue"',
      repro_spec: undefined,
      ...extra,
    })

  test.each<Area>(['security', 'auth', 'sync', 'onboarding'])(
    'a confirmed %s finding goes to the fix agent',
    async (area) => {
      const plan = await routeOne('c2-chat-desktop', finding(area))
      expect(plan.fixes.map((t) => [t.fp, t.finding.area, t.kind])).toEqual([['fp-one', area, 'spec']])
    },
  )

  test('a real-AI finding goes to the fix agent marked real, so the workflow checks it on the real providers', async () => {
    const plan = await routeOne('c3-models-providers-desktop', finding('models'))
    expect(plan.fixes.map((t) => [t.fp, t.real])).toEqual([['fp-one', true]])
  })

  test('a visual finding goes to the fix agent with no spec, even when it names one', async () => {
    const [bare] = (await routeOne('c2-chat-desktop', visual('layout'))).fixes
    expect(bare).toMatchObject({ fp: 'fp-one', kind: 'visual', real: false })
    expect('spec' in bare).toBe(false)

    const [named] = (await routeOne('c2-chat-desktop', visual('layout', { repro_spec: 'repro/1.spec.ts' }))).fixes
    expect(named.kind).toBe('visual')
    expect('spec' in named).toBe(false)
  })

  const nativeLayout = (viewport: string) =>
    finding('onboarding', {
      viewport,
      oracle: { type: 'layout', evidence: '[qa-layout] focused-clipped textbox "Enter your name"' },
      repro_spec: undefined,
      repro_flow: 'repro/1.yaml',
    })

  test('a native layout finding goes to the fix agent with its flow, and to the native verification', async () => {
    const plan = await routeOne('c1-first-run-ios', nativeLayout('ios'))
    const flow = join(outDir, 'c1-first-run-ios', 'repro', '1.yaml')
    expect(plan.fixes).toHaveLength(1)
    expect(plan.fixes[0]).toMatchObject({ fp: 'fp-one', kind: 'spec', platform: 'ios', flow, real: false })
    expect('spec' in plan.fixes[0]).toBe(false)
    expect(plan.verifyNative).toEqual([
      { fp: 'fp-one', platform: 'ios', session: 'c1-first-run-ios', flow, unpatched: false },
    ])
  })

  test('a native visual finding asks the fix agent for a Maestro check, which the native verification runs', async () => {
    const plan = await routeOne(
      'c6-settings-data-ios',
      visual('layout', { viewport: 'ios', screenshot: 'maestro/shot-3.jpg' }),
    )
    const check = join(outDir, 'fix-fp-one', 'repro', 'check.yaml')
    expect(plan.fixes[0]).toMatchObject({
      kind: 'visual',
      platform: 'ios',
      flow: check,
      screenshot: join(outDir, 'c6-settings-data-ios', 'maestro', 'shot-3.jpg'),
    })
    expect(plan.verifyNative).toEqual([
      { fp: 'fp-one', platform: 'ios', session: 'c6-settings-data-ios', flow: check, unpatched: true },
    ])
  })

  test('a native finding whose flow is not on disk is not routed', async () => {
    await fileTickets([{ fp: 'fp-one', charterDir: 'c1-first-run-ios', raw: nativeLayout('ios') }])
    await rm(join(outDir, 'c1-first-run-ios', 'repro', '1.yaml'))
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan).toEqual({ fixes: [], verifyNative: [] })
  })

  test('an Android real-AI finding goes to the fix agent marked real, and its flow must fail without the patch', async () => {
    const raw = finding('models', { viewport: 'android', repro_spec: undefined, repro_flow: 'repro/1.yaml' })
    const plan = await routeOne('c3-models-providers-android', raw)
    expect(plan.fixes.map((t) => [t.platform, t.real])).toEqual([['android', true]])
    expect(plan.verifyNative.map((v) => [v.platform, v.unpatched])).toEqual([['android', true]])
  })

  test('one bug on phone and iOS is one fix, and the patch is also verified on iOS', async () => {
    await fileTickets([
      { fp: 'fp-same', charterDir: 'c1-first-run-phone', raw: finding('onboarding', { viewport: 'phone' }) },
      { fp: 'fp-same', charterDir: 'c1-first-run-ios', raw: nativeLayout('ios') },
    ])
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan.fixes.map((t) => [t.fp, t.platform, t.kind])).toEqual([['fp-same', 'phone', 'spec']])
    expect(plan.verifyNative).toEqual([
      {
        fp: 'fp-same',
        platform: 'ios',
        session: 'c1-first-run-ios',
        flow: join(outDir, 'c1-first-run-ios', 'repro', '1.yaml'),
        unpatched: false,
      },
    ])
  })

  const fakeWeb = { fp: 'fp-same', charterDir: 'c2-chat-power-user-desktop', raw: finding('chat') }
  const realWeb = { fp: 'fp-same', charterDir: 'c3-models-providers-desktop', raw: finding('chat') }

  test.each([
    ['fake first', [fakeWeb, realWeb]],
    ['real first', [realWeb, fakeWeb]],
  ])('a bug found on the fake and the real AI on the web is fixed from the real finding (%s)', async (_n, tickets) => {
    await fileTickets(tickets)
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan.fixes).toHaveLength(1)
    expect(plan.fixes[0]).toMatchObject({
      charterDir: 'c3-models-providers-desktop',
      real: true,
      spec: join(outDir, 'c3-models-providers-desktop', 'repro', '1.spec.ts'),
    })
  })

  test('a bug found on the fake AI on the web and the real AI on Android keeps the web task and checks Android', async () => {
    const realAndroid = { viewport: 'android', repro_spec: undefined, repro_flow: 'repro/1.yaml' }
    await fileTickets([
      fakeWeb,
      { fp: 'fp-same', charterDir: 'c3-models-providers-android', raw: finding('chat', realAndroid) },
    ])
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan.fixes.map((t) => [t.charterDir, t.real])).toEqual([['c2-chat-power-user-desktop', false]])
    expect(plan.verifyNative.map((v) => [v.platform, v.session, v.unpatched])).toEqual([
      ['android', 'c3-models-providers-android', true],
    ])
  })

  test('a sync finding of the same bug still leads, so its refusal holds', async () => {
    const sync = { fp: 'fp-same', charterDir: 'c7-two-devices-desktop', raw: finding('chat') }
    await fileTickets([fakeWeb, realWeb, sync])
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan.fixes.map((t) => t.charterDir)).toEqual(['c7-two-devices-desktop'])
  })

  test("a fix-only run routes an earlier run's filed tickets with the current code, never that run's plan", async () => {
    const charterDir = 'c2-chat-power-user-phone'
    const ticket = (fp: string, id: string) => ({
      fp,
      severity: 'High' as const,
      charterDir,
      issueId: `issue-${id}`,
      identifier: `THB-${id}`,
    })
    // A new ticket, a refused finding, and a `rolled-up` entry: older runs listed findings over their ticket cap
    // on one shared ticket, which has no fix task of its own.
    const filed = [
      { ...ticket('fp-filed', '1'), id: '1', action: 'created' },
      { ...ticket('fp-rolled-up', '2'), id: '2', action: 'rolled-up' },
      { fp: 'fp-refused', severity: 'High', charterDir, id: '3', action: 'refused', reason: 'held back' },
    ]
    const confirmed: VerifiedFinding[] = filed.map(({ id }) => ({
      charterDir,
      id,
      finding: finding('chat', { viewport: 'phone', repro_spec: `repro/${id}.spec.ts` }),
      replay: { failed: 3, runs: 3 },
      artifacts: {},
    }))
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    for (const { id } of filed) await put(join(outDir, charterDir, 'repro', `${id}.spec.ts`), spec)
    // The earlier run's plan arrives in the same artifact as its filed.json.
    const stale = { fixes: [{ ...ticket('fp-stale', '9'), kind: 'visual' }], verifyNative: [] }
    await put(join(outDir, 'fix-plan.json'), JSON.stringify(stale))

    const plan = await route({ outDir, live: true, run: fakeRun([]), log: () => {} })

    expect(plan.fixes).toHaveLength(1)
    expect(plan.fixes[0]).toMatchObject({
      ...ticket('fp-filed', '1'),
      kind: 'spec',
      spec: join(outDir, charterDir, 'repro', '1.spec.ts'),
    })
    expect(JSON.parse(await readFile(join(outDir, 'fix-plan.json'), 'utf8'))).toEqual(plan)
  })

  test('routes one fix per fingerprint when the same bugs were filed on desktop and phone', async () => {
    const ids = ['1', '2', '3', '4', '5']
    const filed: Filed[] = ids.flatMap((id) =>
      ['desktop', 'phone'].map((platform) => ({
        fp: `fp-${id}`,
        severity: 'High' as const,
        action: 'created' as const,
        issueId: `i${id}`,
        identifier: `THB-${id}`,
        charterDir: `c2-chat-power-user-${platform}`,
        id,
      })),
    )
    const confirmed: VerifiedFinding[] = filed.map(({ charterDir, id }) => ({
      charterDir,
      id,
      finding: finding('chat', { repro_spec: `repro/${id}.spec.ts` }),
      replay: { failed: 3, runs: 3 },
      artifacts: {},
    }))
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    for (const { charterDir, id } of filed) await put(join(outDir, charterDir, 'repro', `${id}.spec.ts`), spec)

    const plan = await route({ outDir, live: true, run: fakeRun([]), log: () => {} })

    expect(plan.fixes.map((t) => [t.fp, t.charterDir])).toEqual(
      ids.map((id) => [`fp-${id}`, 'c2-chat-power-user-desktop']),
    )
  })

  describe("the ticket's branch and state in Linear", () => {
    const linearName = 'jane/thb-42-code-entry-textbox-on-sign-in-has-no-accessible-name'
    const fallback = 'qa-fix/thb-42'
    type Options = {
      area?: Area
      branchName?: string
      state?: string
      /** Filed in a dry run: no Linear ticket, so no identifier and no lookup. */
      dryRun?: boolean
      /** False when Linear's answer leaves the ticket out, as for a deleted one. */
      returned?: boolean
      outputs?: Record<string, string>
      run?: Run
    }
    const routeTicket = async ({
      area = 'chat',
      branchName = linearName,
      state = 'backlog',
      dryRun = false,
      returned = true,
      outputs = {},
      run,
    }: Options = {}) => {
      const ticket = { issueId: 'issue-1', identifier: 'THB-42' }
      const entry: Filed = { fp: 'fp-one', charterDir: 'c2-chat', id: '1', severity: 'High', action: 'created' }
      const filed = [dryRun ? { ...entry, action: 'dry-run', would: 'created' } : { ...entry, ...ticket }]
      const confirmed: VerifiedFinding[] = [
        { charterDir: 'c2-chat', id: '1', finding: finding(area), replay: { failed: 3, runs: 3 }, artifacts: {} },
      ]
      const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
      await put(join(outDir, 'filed.json'), JSON.stringify(filed))
      await put(join(outDir, 'verified.json'), JSON.stringify(verified))
      await put(join(outDir, 'c2-chat', 'repro', '1.spec.ts'), spec)
      const calls: { op: string; variables: { ids: string[] } }[] = []
      const fetchFn = asFetch(async (_url, init) => {
        const { query, variables } = JSON.parse(String(init?.body))
        calls.push({ op: /^query (\w+)/.exec(query)?.[1] ?? '', variables })
        const nodes = returned ? [{ id: 'issue-1', branchName, state: { type: state } }] : []
        return Response.json({ data: { issues: { nodes } } })
      })
      const runs: RunCall[] = []
      const lines: string[] = []
      const plan = await route({
        outDir,
        live: !dryRun,
        key: 'lin',
        fetchFn,
        run: run ?? fakeRun(runs, outputs),
        log: (line) => lines.push(line),
      })
      return { plan, calls, runs, lines }
    }

    test("takes Linear's branch name, read once, when it has a safe shape and git accepts it", async () => {
      const { plan, calls, runs } = await routeTicket()
      expect(plan.fixes.map((t) => t.branch)).toEqual([linearName])
      expect(calls).toEqual([{ op: 'Tickets', variables: { ids: ['issue-1'] } }])
      expect(runs.map((r) => r.cmd)).toContainEqual(['git', 'check-ref-format', '--branch', linearName])
    })

    test.each([
      ['uppercase', 'jane/thb-42-Code-entry'],
      ['a second slash', 'jane/thb-42/code-entry'],
      ['a double dot', 'jane/thb-42-code..entry'],
      ['no identifier', 'jane/code-entry-has-no-name'],
      ['a longer identifier', 'jane/thb-420-code-entry'],
      ['the identifier after the slug', 'jane/code-entry-thb-42'],
      ['more than 100 characters', `jane/thb-42-${'a'.repeat(89)}`],
      ['a leading dash', '-jane/thb-42-code-entry'],
      ['no prefix', 'thb-42-code-entry'],
    ])('falls back to the identifier-only name for a Linear name with %s', async (_why, branchName) => {
      const { plan } = await routeTicket({ branchName })
      expect(plan.fixes.map((t) => t.branch)).toEqual([fallback])
    })

    test('falls back when git refuses a name that has the safe shape', async () => {
      const runs: RunCall[] = []
      const run: Run = async (cmd, opts) => {
        if (cmd[1] === 'check-ref-format') throw new Error('git check-ref-format exited 1')
        return fakeRun(runs)(cmd, opts)
      }
      const { plan } = await routeTicket({ run })
      expect(plan.fixes.map((t) => t.branch)).toEqual([fallback])
    })

    test("a security ticket gets the identifier-only name, so its title's slug never shows in a public branch", async () => {
      const { plan, runs } = await routeTicket({ area: 'security' })
      expect(plan.fixes.map((t) => t.branch)).toEqual([fallback])
      expect(runs.some((r) => r.cmd.includes('check-ref-format'))).toBe(false)
    })

    test('a ticket filed in a dry run has no identifier and keeps the fingerprint branch, without a Linear read', async () => {
      const { plan, calls } = await routeTicket({ dryRun: true })
      expect(plan.fixes.map((t) => t.branch)).toEqual(['qa-fix/fp-one'])
      expect(calls).toEqual([])
    })

    test.each([
      ["on Linear's branch", linearName],
      ['on the older fingerprint branch', 'qa-fix/fp-one'],
      ["on a teammate's branch, whose prefix differs from the key owner's", 'joe/thb-42-fix-label'],
      ['on a branch that starts with the identifier in capitals', 'THB-42/fix-label'],
    ])('a ticket with an open PR %s is not routed', async (_where, head) => {
      const { plan, lines } = await routeTicket({ outputs: { 'gh pr': `qa-fix/other\n${head}\n` } })
      expect(plan.fixes).toEqual([])
      expect(lines).toContain('fix: THB-42 already has an open PR, so it is not routed')
    })

    test('an open PR whose branch holds the identifier only inside a longer token does not hold the ticket back', async () => {
      const { plan } = await routeTicket({ outputs: { 'gh pr': 'joe/thb-420-fix-label\njoe/xthb-42-fix\n' } })
      expect(plan.fixes.map((t) => t.branch)).toEqual([linearName])
    })

    test('a ticket Linear does not return is routed on the identifier-only branch, and the log says so', async () => {
      const { plan, lines } = await routeTicket({ returned: false })
      expect(plan.fixes.map((t) => t.branch)).toEqual([fallback])
      expect(lines).toContain(
        'fix: Linear did not return THB-42, so its state is not checked and it gets the identifier-only branch',
      )
    })

    test("only this repository's PRs count, since anyone can name a fork's branch after a ticket", async () => {
      // Runs route's own --jq filter over gh's JSON.
      const routeWith = (isCrossRepository: boolean) => {
        const prs = JSON.stringify([{ headRefName: linearName, isCrossRepository }])
        const run: Run = async (cmd) =>
          cmd[0] === 'gh'
            ? Bun.spawnSync(['jq', '--raw-output', cmd[cmd.indexOf('--jq') + 1]], {
                stdin: Buffer.from(prs),
              }).stdout.toString()
            : ''
        return routeTicket({ run })
      }
      expect((await routeWith(true)).plan.fixes.map((t) => t.branch)).toEqual([linearName])
      expect((await routeWith(false)).plan.fixes).toEqual([])
    })

    test('a ticket whose branch exists without an open PR is not routed, since a person may be working there', async () => {
      const heads = `abc\trefs/heads/main\ndef\trefs/heads/${linearName}\n`
      const { plan, lines } = await routeTicket({ outputs: { 'git ls-remote': heads } })
      expect(plan.fixes).toEqual([])
      expect(lines).toContain(`fix: THB-42's branch ${linearName} exists without an open PR, so it is not routed`)
    })

    test.each(['completed', 'canceled'])('a %s ticket is not routed, and the log says why', async (state) => {
      const { plan, lines } = await routeTicket({ state })
      expect(plan.fixes).toEqual([])
      expect(lines).toContain(`fix: THB-42 is ${state} in Linear, so it is not routed`)
    })
  })
})

describe('isDenied', () => {
  test.each([
    '.github/workflows/ci.yml',
    '.github/qa/fix.md',
    '.github/qa/scripts/fix.ts',
    '.github/qa/playwright.config.ts',
    'package.json',
    'backend/package.json',
    'cli/package.json',
    'bun.lock',
    'bun.lockb',
    'backend/bun.lock',
    'cli/bun.lock',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'crates/thunderbolt-acp-client/Cargo.toml',
    'src-tauri/gen/android/build.gradle',
    'src-tauri/gen/android/app/build.gradle.kts',
    'src-tauri/gen/apple/Podfile',
    'src-tauri/gen/apple/Podfile.lock',
    'src-tauri/plugins/tauri-plugin-passkey/ios/Package.resolved',
    'src-tauri/plugins/tauri-plugin-passkey/ios/Package.swift',
    'requirements.txt',
    'scripts/requirements-dev.txt',
    'go.mod',
    'tools/go.sum',
    'Gemfile',
    'src-tauri/gen/apple/Gemfile',
    'src-tauri/gen/apple/Gemfile.lock',
    'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar',
    'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties',
    'bunfig.toml',
    'backend/bunfig.toml',
    'src-tauri/.cargo/config.toml',
    'crates/thunderbolt-acp-client/.cargo/config',
    'rust-toolchain',
    'src-tauri/rust-toolchain.toml',
    '.npmrc',
    'cli/.npmrc',
    '.nvmrc',
    'backend/.nvmrc',
    '.tool-versions',
    'src-tauri/.tool-versions',
    // Repro specs and visual checks import e2e/helpers, so a patch there could hollow out an unedited spec.
    'e2e/helpers.ts',
    'e2e/consumer-qa-ab12cd34.spec.ts',
    // Git hooks and lint-staged run code on a developer's machine at their next commit.
    '.husky/pre-commit',
    '.husky/_/husky.sh',
    '.lintstagedrc',
    '.lintstagedrc.json',
    'backend/.lintstagedrc.mjs',
    'lint-staged.config.js',
    'cli/lint-staged.config.mjs',
    'package-lock.json',
    'web/package-lock.json',
    'yarn.lock',
    'cli/yarn.lock',
    'pnpm-lock.yaml',
    'web/pnpm-lock.yaml',
    'npm-shrinkwrap.json',
    'backend/npm-shrinkwrap.json',
    // The dev servers re-run these while the fix agent works, and the checks obey them.
    'vite.config.ts',
    'web/vite.config.mjs',
    'playwright.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'backend/tsconfig.json',
    'src/sub/.husky/pre-commit',
  ])('denies %s', (path) => {
    expect(isDenied(path)).toBe(true)
  })

  test.each([
    'src/chats/chat-title.tsx',
    'shared/url.ts',
    'backend/src/api/chat.ts',
    'src/lib/auth-client.ts',
    'backend/src/auth/auth.ts',
    'src/crypto/keys.ts',
    'src/db/schema.ts',
    'shared/powersync-tables.ts',
    'powersync-service/config/config.yaml',
    'backend/drizzle/0042_x.sql',
    'backend/drizzle/meta/_journal.json',
    'src-tauri/src/lib.rs',
    'src-tauri/tauri.conf.json',
    'deploy/k8s/values.yaml',
    'src/lib/package-json.ts',
    'src/my-package.json',
    'src/lib/cargo/config.ts',
    'src/e2e/helpers.ts',
    'src/components/gemfile-view.tsx',
    'src/lib/husky.ts',
    'src/lib/lint-staged.ts',
    'src/lib/vite-config.ts',
    'src/settings/tsconfig-view.tsx',
  ])('allows %s', (path) => {
    expect(isDenied(path)).toBe(false)
  })
})

describe('regressionSpec', () => {
  /** The spec's lines after the MPL header and the blank line below it. */
  const body = async (charterDir: string, source: string) =>
    (await regressionSpec(charterDir, 'ab12cd34', source)).source.split('\n').slice(4).join('\n')
  const uses = 'test.use({ viewport: { width: 1, height: 1 } })\n'

  test('names the spec for the consumer project and imports from e2e/', async () => {
    const { path, source } = await regressionSpec('c4-skills-projects', 'ab12cd34', spec)
    expect(path).toBe('e2e/consumer-qa-ab12cd34.spec.ts')
    expect(source).toContain("import { expect, test } from './test'")
    expect(source).toContain("import { loginViaEmailCode } from './helpers'")
    expect(source).not.toContain('../../../e2e')
    expect(source.split('\n').slice(6)).toEqual(spec.split('\n').slice(2))
  })

  test('moves the layout helper import from qa-out/ to e2e/', async () => {
    const source = `import { layoutProblems } from '../../../.github/qa/layout'\nlayoutProblems()\n`
    expect(await body('c8-phone', source)).toBe(
      `import { layoutProblems } from '../.github/qa/layout'\nlayoutProblems()\n`,
    )
  })

  test('moves the ports import from qa-out/ to e2e/, in either quote style', async () => {
    const source = `import { frontendURL } from '../../../.github/qa/ports'\nimport { stackURLs } from "../../../.github/qa/ports"\nstackURLs(frontendURL)\n`
    expect(await body('c2-chat-power-user', source)).toBe(
      `import { frontendURL } from '../.github/qa/ports'\nimport { stackURLs } from '../.github/qa/ports'\nstackURLs(frontendURL)\n`,
    )
  })

  test('uses the sync prefix for the two-device charter', async () => {
    expect((await regressionSpec('c7-two-devices', 'ab12cd34', spec)).path).toBe('e2e/sync-qa-ab12cd34.spec.ts')
  })

  test('keeps @playwright/test when the spec imports something e2e/test.ts does not export', async () => {
    const source = `import { devices, test } from '@playwright/test'\nimport type { Page } from "@playwright/test"\nconst p: Page = devices\n${uses}`
    expect(await body('c8-phone', source)).toBe(
      `import { devices, test } from '@playwright/test'\nimport type { Page } from './test'\nconst p: Page = devices\n${uses}`,
    )
  })

  // A promoted spec once failed the PR's lint on an unused import and had no license header.
  test('comes out clean: the MPL header on top, no unused import, formatted as the repo formats e2e/', async () => {
    const messy = `import { expect, test } from "@playwright/test"
import { collectPageErrors, loginViaEmailCode } from '../../../e2e/helpers'
import { layoutProblems } from '../../../.github/qa/layout'

test('menu fits',async ({ page }) => {
    await loginViaEmailCode(page);
    await expect(page.getByRole("button", { name: "Menu" })).toBeVisible()
})
`
    const { path, source } = await regressionSpec('c8-phone', 'ab12cd34', messy)
    expect(source).toBe(`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'

test('menu fits', async ({ page }) => {
  await loginViaEmailCode(page)
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
})
`)
    const config = await prettier.resolveConfig(join(import.meta.dir, '../../..', path))
    expect(await prettier.check(source, { ...config, filepath: path })).toBe(true)
  })

  test('keeps a header that is already there, and a side-effect import', async () => {
    const headed = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './setup'
`
    expect((await regressionSpec('c8-phone', 'ab12cd34', headed)).source).toBe(headed)
  })
})

describe('whyNoSpec', () => {
  type Extra = Partial<Pick<FixTask, 'charterDir' | 'real'>> & {
    proof?: { kind: 'visual' } | { kind: 'spec'; flow: string }
  }
  const task = ({ proof, ...extra }: Extra = {}, finding: Partial<FixTask['finding']> = {}): FixTask => ({
    fp: 'ab12cd34',
    severity: 'High',
    branch: 'qa-fix/ab12cd34',
    charterDir: 'c2-chat',
    platform: 'desktop',
    real: false,
    ...(proof ?? { kind: 'spec', spec: 'qa-out/c2-chat/repro/1.spec.ts' }),
    finding: {
      title: 'Menu',
      area: 'chat',
      viewport: 'desktop',
      oracle: { type: 'layout', evidence: '[qa-layout] overflow-text button "Menu"' },
      steps: [],
      expected: '',
      actual: '',
      ...finding,
    },
    ...extra,
  })
  const oracle = (type: FixTask['finding']['oracle']['type'], evidence = 'x') => ({ oracle: { type, evidence } })

  test('adds a spec for what only a real browser shows: layout, visual and data lost on a reload', () => {
    expect(whyNoSpec(task())).toBeUndefined()
    expect(whyNoSpec(task({ proof: { kind: 'visual' } }, oracle('visual')))).toBeUndefined()
    expect(whyNoSpec(task({}, oracle('lost-on-reload')))).toBeUndefined()
  })

  test('leaves the rest to the unit test, a missing accessible name included', () => {
    for (const type of [
      'page-error',
      'console-error',
      'http-5xx',
      'stuck',
      'assert-failed',
      'ai-reported-failure',
    ] as const)
      expect({ type, why: whyNoSpec(task({}, oracle(type))) }).toEqual({ type, why: 'unit' })
    const unnamed = oracle('layout', '[qa-layout] unnamed-control button "arrow-left icon after Connect Google"')
    expect(whyNoSpec(task({}, unnamed))).toBe('unit')
  })

  test('never adds one for a security, native, onboarding or real-AI fix, whatever the oracle', () => {
    expect(whyNoSpec(task({}, { area: 'security' }))).toBe('security')
    expect(whyNoSpec(task({ proof: { kind: 'spec', flow: 'f.yaml' } }))).toBe('native')
    expect(whyNoSpec(task({ charterDir: 'c1-first-run-desktop' }))).toBe('onboarding')
    expect(whyNoSpec(task({ real: true }))).toBe('real')
  })
})

describe('checkPatch', () => {
  const fp = 'ab12cd34'
  let repo: string
  let git: Run
  const reproSpec = () => join(outDir, 'c2-chat', 'repro', '1.spec.ts')
  const task = (): FixTask => ({
    fp,
    severity: 'High',
    branch: `qa-fix/${fp}`,
    charterDir: 'c2-chat',
    platform: 'desktop',
    kind: 'spec',
    real: false,
    spec: reproSpec(),
    finding: { ...finding('chat'), oracle: { type: 'page-error', evidence: 'x' } },
  })
  const visualTask = (): FixTask => ({
    fp,
    severity: 'High',
    branch: `qa-fix/${fp}`,
    charterDir: 'c2-chat',
    platform: 'desktop',
    kind: 'visual',
    real: false,
    finding: { ...finding('layout'), oracle: { type: 'visual', evidence: 'Continue sits under the banner' } },
  })
  const fixed = () => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n')

  const patchFrom = async (edit: () => Promise<void>) => {
    await edit()
    await git(['git', 'add', '-A'])
    await put(join(outDir, 'fix', `${fp}.patch`), await git(['git', 'diff', '--cached', '--binary', 'HEAD']))
    await git(['git', 'reset', '--quiet', '--hard'])
  }

  beforeEach(async () => {
    repo = join(dir, 'repo')
    git = runIn(repo)
    await put(join(repo, 'src', 'chat.ts'), 'export const title = 1\n')
    await put(join(repo, 'shared', 'powersync-tables.ts'), 'export const tables = []\n')
    await put(join(repo, 'package.json'), '{}\n')
    await git(['git', 'init', '--quiet'])
    await git(['git', 'add', '-A'])
    await git(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init'])
    await put(reproSpec(), spec)
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec)
  })

  test('accepts a patch that only fixes app code, without touching the checkout', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n'))
    expect(await checkPatch(git, outDir, task(), [])).toEqual({
      reasons: [],
      files: ['src/chat.ts'],
      unitTests: false,
    })
    expect(await git(['git', 'status', '--porcelain'])).toBe('')
  })

  test('says whether the patch adds or changes a unit test, which deleting one does not', async () => {
    await put(join(repo, 'src', 'old.test.ts'), 'old\n')
    await git(['git', 'add', '-A'])
    await git(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'test'])
    await patchFrom(() => rm(join(repo, 'src', 'old.test.ts')))
    expect((await checkPatch(git, outDir, task(), [])).unitTests).toBe(false)
    await patchFrom(() => put(join(repo, 'src', 'chat.test.ts'), 'new\n'))
    expect((await checkPatch(git, outDir, task(), [])).unitTests).toBe(true)
  })

  test('rejects an empty patch', async () => {
    await put(join(outDir, 'fix', `${fp}.patch`), '\n')
    expect(await checkPatch(git, outDir, task(), [])).toEqual({ reasons: ['empty patch'], files: [], unitTests: false })
  })

  test('rejects a patch that adds a symlink or a submodule, even under an allowed path', async () => {
    await patchFrom(async () => {
      await symlink('../.github', join(repo, 'src', 'link'))
      // A nested repo is staged as a submodule entry (mode 160000).
      const vendor = runIn(join(repo, 'src', 'vendor'))
      await mkdir(join(repo, 'src', 'vendor'))
      await vendor(['git', 'init', '--quiet'])
      await vendor([
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'v',
      ])
    })
    const { reasons, files } = await checkPatch(git, outDir, task(), [])
    expect(files.sort()).toEqual(['src/link', 'src/vendor'])
    expect(reasons.sort()).toEqual([
      'adds or changes a symlink or submodule: src/link',
      'adds or changes a symlink or submodule: src/vendor',
    ])
  })

  test('rejects a patch that turns an existing symlink into a file', async () => {
    await symlink('chat.ts', join(repo, 'src', 'alias.ts'))
    await git(['git', 'add', '-A'])
    await git(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'link'])
    await patchFrom(async () => {
      await rm(join(repo, 'src', 'alias.ts'))
      await writeFile(join(repo, 'src', 'alias.ts'), 'export const alias = 1\n')
    })
    expect((await checkPatch(git, outDir, task(), [])).reasons).toEqual([
      'adds or changes a symlink or submodule: src/alias.ts',
    ])
  })

  test('rejects a patch that matches a secret pattern', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), "export const token = 'ghs_abc123'\n"))
    expect((await checkPatch(git, outDir, task(), [])).reasons).toEqual(['the patch matches a secret pattern'])
  })

  test('accepts a patch to app code a person must review: Tauri, migrations, auth, sync', async () => {
    const paths = ['src-tauri/src/lib.rs', 'backend/drizzle/0042_x.sql', 'src/lib/auth-client.ts']
    await patchFrom(async () => {
      for (const path of paths) await put(join(repo, path), 'changed\n')
      await writeFile(join(repo, 'shared', 'powersync-tables.ts'), 'export const tables = [1]\n')
    })
    const { reasons, files } = await checkPatch(git, outDir, task(), [])
    expect(reasons).toEqual([])
    expect(files.sort()).toEqual([...paths, 'shared/powersync-tables.ts'].sort())
  })

  test('rejects a patch to .github/, a dependency manifest or a lockfile', async () => {
    const paths = [
      '.github/workflows/x.yml',
      'backend/bun.lock',
      'src-tauri/Cargo.toml',
      'src-tauri/gen/android/app/build.gradle.kts',
    ]
    await patchFrom(async () => {
      for (const path of paths) await put(join(repo, path), 'changed\n')
      await writeFile(join(repo, 'package.json'), '{ "dependencies": { "x": "1" } }\n')
    })
    const { reasons } = await checkPatch(git, outDir, task(), [])
    expect(reasons.sort()).toEqual([...paths, 'package.json'].map((path) => `touches ${path}`).sort())
  })

  test('rejects a file renamed out of a denied path', async () => {
    await patchFrom(async () => {
      await fixed()
      await git(['git', 'mv', 'package.json', 'src/package-copy.json'])
    })
    const { reasons, files } = await checkPatch(git, outDir, task(), [])
    expect(files.sort()).toEqual(['package.json', 'src/chat.ts', 'src/package-copy.json'])
    expect(reasons).toEqual(['touches package.json'])
  })

  test('rejects a deleted lockfile and a file renamed into a denied path', async () => {
    await patchFrom(async () => {
      await git(['git', 'rm', '--quiet', 'package.json'])
      await mkdir(join(repo, '.github'))
      await git(['git', 'mv', 'src/chat.ts', '.github/chat.ts'])
    })
    const { reasons, files } = await checkPatch(git, outDir, task(), [])
    expect(files.sort()).toEqual(['.github/chat.ts', 'package.json', 'src/chat.ts'])
    expect(reasons.sort()).toEqual(['touches .github/chat.ts', 'touches package.json'])
  })

  describe('a visual task', () => {
    const check = () => join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts')

    test('passes with a linted check', async () => {
      await patchFrom(fixed)
      await put(check(), spec)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual([])
    })

    test('is rejected without a check, and with a check that fails the lint', async () => {
      await patchFrom(fixed)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual(['the visual check is missing'])

      await put(check(), `${spec}process.exit(0)\n`)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual([
        'visual check: line 8: "process" is not allowed',
      ])
    })
  })

  describe('a native task', () => {
    const flow = '- launchApp\n- assertVisible: Renamed\n'
    const reproFlow = () => join(outDir, 'c1-first-run-ios', 'repro', '1.yaml')
    const check = () => join(outDir, `fix-${fp}`, 'repro', 'check.yaml')
    const native = (): FixTask => ({
      fp,
      severity: 'High',
      branch: `qa-fix/${fp}`,
      charterDir: 'c1-first-run-ios',
      platform: 'ios',
      kind: 'spec',
      real: false,
      flow: reproFlow(),
      finding: { ...finding('onboarding'), viewport: 'ios', oracle: { type: 'assert-failed', evidence: 'x' } },
    })
    const nativeVisual = (): FixTask => ({
      ...visualTask(),
      charterDir: 'c1-first-run-ios',
      platform: 'ios',
      flow: check(),
    })
    beforeEach(async () => {
      await put(reproFlow(), flow)
      await put(join(outDir, 'fix', `${fp}.yaml`), flow)
    })

    test('accepts a patch to src-tauri/ with the flow unedited', async () => {
      await patchFrom(() => put(join(repo, 'src-tauri', 'src', 'lib.rs'), 'fn main() {}\n'))
      expect(await checkPatch(git, outDir, native(), [])).toMatchObject({
        reasons: [],
        files: ['src-tauri/src/lib.rs'],
      })
    })

    test('rejects an edited repro flow', async () => {
      await patchFrom(fixed)
      await put(join(outDir, 'fix', `${fp}.yaml`), flow.replace('Renamed', 'Anything'))
      expect((await checkPatch(git, outDir, native(), [])).reasons).toEqual(['the repro flow was edited'])
    })

    test('rejects a repro flow outside the Maestro allow list', async () => {
      await patchFrom(fixed)
      const evil = '- runScript: evil.js\n'
      await put(reproFlow(), evil)
      await put(join(outDir, 'fix', `${fp}.yaml`), evil)
      const { reasons } = await checkPatch(git, outDir, native(), [])
      expect(reasons.length).toBeGreaterThan(0)
      for (const reason of reasons) expect(reason).toStartWith('repro flow: commands[0]')
    })

    test('a visual one needs a Maestro check inside the allow list', async () => {
      await patchFrom(fixed)
      expect((await checkPatch(git, outDir, nativeVisual(), [])).reasons).toEqual(['the visual check is missing'])

      await put(check(), flow)
      expect((await checkPatch(git, outDir, nativeVisual(), [])).reasons).toEqual([])

      await put(check(), `${flow}- evalScript: \${fetch('https://x')}\n`)
      const { reasons } = await checkPatch(git, outDir, nativeVisual(), [])
      expect(reasons.length).toBeGreaterThan(0)
      for (const reason of reasons) expect(reason).toStartWith('visual check: commands[2]')
    })

    const androidCheck: NativeCheck = {
      fp,
      platform: 'android',
      session: 'c2-chat-android',
      flow: 'qa-out/c2-chat-android/repro/1.yaml',
      unpatched: false,
    }
    const unverified = (path: string) =>
      `touches ${path}, but the verification ran on the backend from before the patch`
    // No job runs the patched backend for these tasks.
    test.each([
      ['a real-AI web task', () => ({ ...task(), charterDir: 'c3-models-providers-desktop', real: true }), []],
      ['a native task', native, []],
      ['a web task the native verification also checks', task, [androidCheck]],
    ] as const)('refuses backend/ and shared/ changes for %s', async (_name, make, checks) => {
      const cases = [
        { edits: ['backend/src/x.ts'], refused: ['backend/src/x.ts'] },
        { edits: ['src/chat.ts', 'backend/src/x.ts'], refused: ['backend/src/x.ts'] },
        { edits: ['shared/powersync-tables.ts'], refused: ['shared/powersync-tables.ts'] },
      ]
      for (const { edits, refused } of cases) {
        await patchFrom(async () => {
          for (const path of edits) await put(join(repo, path), 'changed\n')
        })
        const { reasons } = await checkPatch(git, outDir, make(), [...checks])
        expect({ edits, reasons }).toEqual({ edits, reasons: refused.map(unverified) })
      }
    })
  })

  test('rejects an edited repro spec and a spec that fails the lint', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n'))
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec.replace('Renamed', 'Anything'))
    expect((await checkPatch(git, outDir, task(), [])).reasons).toEqual(['the repro spec was edited'])

    await put(reproSpec(), `${spec}process.exit(0)\n`)
    const { reasons } = await checkPatch(git, outDir, task(), [])
    expect(reasons).toContain('the repro spec was edited')
    expect(reasons).toContain('repro spec: line 8: "process" is not allowed')
  })
})

describe('testRuns', () => {
  test('runs the unit tests a patch adds, changes or renames, each from where its tree runs its tests', () => {
    const files = [
      { path: 'src/chat.test.tsx', status: 'A' },
      { path: 'src/lib/title.test.ts', status: 'M' },
      // A rename, as the raw diff without rename detection lists it.
      { path: 'src/old-name.test.ts', status: 'D' },
      { path: 'src/new-name.test.ts', status: 'A' },
      { path: 'src/gone.test.ts', status: 'D' },
      { path: 'src/chat.ts', status: 'M' },
      { path: 'shared/i18n/locales.test.ts', status: 'M' },
      { path: 'shared/agent-core/tools.test.ts', status: 'A' },
      { path: 'backend/src/waitlist/routes.test.ts', status: 'M' },
      { path: 'cli/src/acp/serve.test.ts', status: 'M' },
      // Outside the unit test trees, or not a unit test.
      { path: 'e2e/fake-provider.test.ts', status: 'M' },
      { path: '.github/qa/scripts/fix.test.ts', status: 'M' },
      { path: 'scripts/release.test.ts', status: 'A' },
      { path: 'src/chat.spec.ts', status: 'A' },
      { path: 'src/chat.test.js', status: 'A' },
    ]
    const bunTest = ['bun', 'test', '--timeout', '5000']
    expect(testRuns(files)).toEqual([
      { cwd: 'shared/agent-core', cmd: [...bunTest, './tools.test.ts'] },
      { cwd: '.', cmd: [...bunTest, './shared/i18n/locales.test.ts'] },
      { cwd: 'src', cmd: [...bunTest, './chat.test.tsx', './lib/title.test.ts', './new-name.test.ts'] },
      { cwd: 'backend', cmd: [...bunTest, './src/waitlist/routes.test.ts'] },
      { cwd: 'cli', cmd: [...bunTest, './src/acp/serve.test.ts'] },
    ])
  })

  test('finds nothing to run in a patch that only deletes a test or changes no unit test', () => {
    expect(testRuns([{ path: 'src/gone.test.ts', status: 'D' }])).toEqual([])
    expect(testRuns([{ path: 'src-tauri/src/lib.rs', status: 'M' }])).toEqual([])
  })
})

describe('checkTests', () => {
  const fp = 'ab12cd34'
  let repo: string
  let git: Run
  const buggy = 'export const title = (text: string) => text\n'
  const fixed = 'export const title = (text: string) => text.trim()\n'
  /** A test file of `title`; it fails on the buggy module when `input` has spaces around it. */
  const titleTest = (input: string) =>
    `import { expect, test } from 'bun:test'\nimport { title } from './title'\n` +
    `test('title', () => expect(title(${JSON.stringify(input)})).toBe(${JSON.stringify(input.trim())}))\n`
  beforeEach(async () => {
    repo = join(dir, 'repo')
    git = runIn(repo)
    await initRepo(repo, { 'src/title.ts': buggy, 'src/old.test.ts': titleTest('plain') })
  })

  const patchOf = (files: Record<string, string>, renames: [string, string][] = []) =>
    writePatch(repo, fp, files, renames)
  const check = async (exec = quiet) => {
    const result = await checkTests({ outDir, fp, repoDir: repo, run: git, exec, log: () => {} })
    // Each half takes its hunks out again, so the checkout ends as it started.
    expect(await git(['git', 'status', '--porcelain'])).toBe('')
    return result
  }

  test('passes a regression test that fails without the fix and passes with it', async () => {
    await patchOf({ 'src/title.ts': fixed, 'src/title.test.ts': titleTest('  Renamed  ') })
    expect(await check()).toEqual({ failsWithout: true, passesWith: true })
  }, 20_000)

  test('passes a renamed test file that gains the regression case', async () => {
    await patchOf({ 'src/title.ts': fixed, 'src/title.test.ts': titleTest('  Renamed  ') }, [
      ['src/old.test.ts', 'src/title.test.ts'],
    ])
    expect(await check()).toEqual({ failsWithout: true, passesWith: true })
  }, 20_000)

  test('fails a test that also passes without the fix', async () => {
    await patchOf({ 'src/title.ts': fixed, 'src/title.test.ts': titleTest('Renamed') })
    expect(await check()).toEqual({ failsWithout: false, passesWith: true })
  }, 20_000)

  test('applies a test file whose path holds glob characters, rather than running none', async () => {
    const weak = titleTest('Renamed').replace("'./title'", "'../title'")
    await patchOf({ 'src/title.ts': fixed, 'src/[id]/title.test.ts': weak })
    expect(await check()).toEqual({ failsWithout: false, passesWith: true })
  }, 20_000)

  test('fails a test that still fails with the fix', async () => {
    await patchOf({
      'src/title.ts': buggy.replace('text\n', 'text.trimEnd()\n'),
      'src/title.test.ts': titleTest('  x  '),
    })
    expect(await check()).toEqual({ failsWithout: true, passesWith: false })
  }, 20_000)

  test('runs the tests as the given user, with only PATH from this environment, and git as this user', async () => {
    const cmds: string[][] = []
    const exec = async (cmd: string[]) => {
      cmds.push(cmd)
      return cmds.length === 1 ? 1 : 0
    }
    await patchOf({ 'src/title.ts': fixed, 'src/title.test.ts': titleTest('  Renamed  ') })
    const gitCalls: string[][] = []
    const recordingGit: Run = async (cmd, opts) => {
      gitCalls.push(cmd)
      return git(cmd, opts)
    }
    const result = await checkTests({
      outDir,
      fp,
      user: 'qa-test',
      repoDir: repo,
      run: recordingGit,
      exec,
      log: () => {},
    })
    expect(result).toEqual({ failsWithout: true, passesWith: true })
    const asTestUser = ['sudo', '-n', '--user', 'qa-test', '--set-home', '--', 'env', `PATH=${process.env.PATH}`]
    const bunTest = ['bun', 'test', '--timeout', '5000', './title.test.ts']
    expect(cmds).toEqual([
      [...asTestUser, ...bunTest],
      [...asTestUser, ...bunTest],
    ])
    expect(gitCalls.every((cmd) => cmd[0] === 'git')).toBe(true)
  })

  test('fails a patch with no unit test, and an empty patch, without running anything', async () => {
    const runs: string[][] = []
    const exec = async (cmd: string[]) => runs.push(cmd)
    const none = { failsWithout: false, passesWith: false }
    await patchOf({ 'src/title.ts': fixed })
    expect(await check(exec)).toEqual(none)
    await put(join(outDir, 'fix', `${fp}.patch`), '\n')
    expect(await check(exec)).toEqual(none)
    expect(runs).toEqual([])
  })
})

describe('the PR checks gate', () => {
  const fp = 'ab12cd34'
  const header = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
`
  const bin = join(import.meta.dir, '../../../node_modules/.bin')
  // Real tools over the staged tree, as `bun run check` runs them: TypeScript's unused-import errors, the license
  // check's test for a header, and prettier with the repo's config.
  const checks: PrCheck[] = [
    {
      name: 'unused imports',
      run: `test -z "$(${bin}/tsc --noEmit --noUnusedLocals --module esnext --moduleResolution bundler $(git ls-files '*.ts') | grep -E 'TS(6133|6192)')"`,
    },
    { name: 'license', run: `test -z "$(git ls-files '*.ts' | xargs grep -L 'mozilla.org/MPL')"` },
    { name: 'format', run: `${bin}/prettier --check $(git ls-files '*.ts')` },
    { name: 'backend only', run: 'false', paths: ['backend/'] },
  ]
  let repo: string
  let git: Run
  const task = (): FixTask => ({
    fp,
    severity: 'High',
    branch: 'qa-fix/thb-1',
    identifier: 'THB-1',
    charterDir: 'c8-phone',
    platform: 'phone',
    real: false,
    kind: 'spec',
    spec: join(outDir, 'c8-phone', 'repro', '1.spec.ts'),
    finding: {
      title: 'Menu overflows',
      area: 'chat',
      viewport: 'phone',
      oracle: { type: 'layout', evidence: '[qa-layout] overflow-page' },
      steps: [],
      expected: '',
      actual: '',
    },
  })

  beforeEach(async () => {
    repo = join(dir, 'repo')
    git = runIn(repo)
    const prettierrc = '.prettierrc.json'
    await initRepo(repo, {
      [prettierrc]: await readFile(join(import.meta.dir, '../../..', prettierrc), 'utf8'),
      'src/chat.ts': `${header}\nexport const title = (text: string) => text\n`,
      'e2e/test.ts': `${header}\nexport const test = () => {}\n`,
      'src/locales/en/messages.po': '',
      'backend/src/emails/locales/en/messages.po': '',
    })
    await put(join(outDir, 'fix-plan.json'), JSON.stringify({ fixes: [task()], verifyNative: [] }))
    // A repro as the explorer writes them: an unused import, no header, not formatted.
    await put(
      join(outDir, 'c8-phone', 'repro', '1.spec.ts'),
      `import { test } from "@playwright/test"\nimport { loginViaEmailCode } from '../../../e2e/helpers'\n\ntest('menu', async () => {})\n`,
    )
  })

  const patchOf = (files: Record<string, string>) => writePatch(repo, fp, files)
  const gate = async (files: Record<string, string>, gateChecks = checks) => {
    await patchOf(files)
    const ran: string[] = []
    const exec = async (cmd: string[], cwd: string) => {
      ran.push(cmd.at(-1) ?? '')
      return quiet(cmd, cwd)
    }
    const summary = join(dir, 'summary.md')
    const failed = await runGate({
      outDir,
      fp,
      repoDir: repo,
      run: git,
      exec,
      summary,
      checks: gateChecks,
      log: () => {},
    })
    const said = (await Bun.file(summary).exists()) ? await readFile(summary, 'utf8') : ''
    return { failed, ran: ran.length, said }
  }

  test('passes the tree publish pushes, committed, with the repro cleaned into a regression spec', async () => {
    expect(await gate({ 'src/chat.ts': `${header}\nexport const title = (text: string) => text.trim()\n` })).toEqual({
      failed: undefined,
      ran: 3,
      said: '',
    })
    expect(await git(['git', 'diff', '--name-only', 'HEAD~1', 'HEAD'])).toBe(
      'e2e/consumer-qa-ab12cd34.spec.ts\nsrc/chat.ts\n',
    )
    expect(await git(['git', 'status', '--porcelain'])).toBe('')
  }, 20_000)

  // A staged catalog fails `i18n:check`'s `git status` test in the gate, but not in CI, which checks out a commit.
  test("passes i18n:check's git tests on a patch that changes a tracked catalog", async () => {
    const catalogs = {
      name: 'catalogs',
      run: 'git diff --exit-code -- src/locales && test -z "$(git status --porcelain -- src/locales)"',
    }
    const catalog = { 'src/locales/en/messages.po': 'msgid "Menu"\nmsgstr "Menu"\n' }
    expect((await gate(catalog, [catalogs])).failed).toBeUndefined()
  }, 20_000)

  test('fails a tree with an unused import, stops there, and the summary names the ticket and the check', async () => {
    const unused = `${header}\nimport { title } from './chat'\n\nexport const name = 'x'\n`
    expect(await gate({ 'src/name.ts': unused })).toEqual({
      failed: 'unused imports',
      ran: 1,
      said: '- THB-1: the tree publish would push fails `unused imports`, so it opens no PR and leaves the ticket for a later run.\n',
    })
  }, 20_000)

  test('fails a tree with a file that lacks the license header', async () => {
    expect((await gate({ 'src/name.ts': "export const name = 'x'\n" })).failed).toBe('license')
  }, 20_000)

  test('fails a tree that is not formatted', async () => {
    expect((await gate({ 'src/name.ts': `${header}\nexport const name = "x";\n` })).failed).toBe('format')
  }, 20_000)

  test('runs a check limited to some paths only when the tree touches one, as the given user', async () => {
    const cmds: string[][] = []
    const exec = async (cmd: string[]) => {
      cmds.push(cmd)
      return 0
    }
    const gateAs = async (files: Record<string, string>) => {
      await patchOf(files)
      const only = [checks[3]]
      await runGate({ outDir, fp, user: 'qa-test', repoDir: repo, run: git, exec, checks: only, log: () => {} })
    }
    await gateAs({ 'backend/x.ts': 'x' })
    expect(cmds).toEqual([
      [
        ...['sudo', '-n', '--user', 'qa-test', '--set-home', '--', 'env', `PATH=${process.env.PATH}`],
        ...['env', 'CI=true', 'bash', '-eo', 'pipefail', '-c', 'false'],
      ],
    ])
    // The catalog check rewrites the catalogs as the test user.
    for (const catalogs of ['src/locales/en', 'backend/src/emails/locales/en/messages.po'])
      expect((await stat(join(repo, catalogs))).mode & 0o002).toBe(0o002)
    await gateAs({ 'src/x.ts': 'x' })
    expect(cmds).toHaveLength(1)
  })

  test('refuses a patch that turns a catalog folder into a symlink, before it writes or changes anything', async () => {
    const outside = join(dir, 'outside')
    await mkdir(outside, { mode: 0o755 })
    await git(['git', 'rm', '-r', '--quiet', 'src/locales'])
    await symlink(outside, join(repo, 'src', 'locales'))
    await git(['git', 'add', '--all'])
    await put(join(outDir, 'fix', `${fp}.patch`), await git(['git', 'diff', '--cached', '--binary', 'HEAD']))
    await git(['git', 'reset', '--quiet', '--hard'])
    const cmds: string[][] = []
    const exec = async (cmd: string[]) => cmds.push(cmd)
    const failed = await runGate({ outDir, fp, user: 'qa-test', repoDir: repo, run: git, exec, checks, log: () => {} })
    expect(failed).toBe(noLinks)
    expect((await stat(outside)).mode & 0o777).toBe(0o755)
    expect(cmds).toEqual([])
    expect(await git(['git', 'log', '--format=%s'])).toBe('init\n')
  })

  // Lifecycle scripts point core.hooksPath at husky's folder, which a patch may change before the gate commits.
  test('commits the tree with no git hook, whatever core.hooksPath says', async () => {
    const marker = join(dir, 'hook-ran')
    await put(join(dir, 'hooks', 'post-commit'), `#!/bin/sh\ntouch ${marker}\n`)
    await chmod(join(dir, 'hooks', 'post-commit'), 0o755)
    await git(['git', 'config', 'core.hooksPath', join(dir, 'hooks')])
    expect(
      (await gate({ 'src/chat.ts': `${header}\nexport const title = (text: string) => text.trim()\n` })).failed,
    ).toBe(undefined)
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 20_000)
})

describe('publish', () => {
  const fp = 'ab12cd34'
  const specPath = () => join(outDir, 'c2-chat', 'repro', '1.spec.ts')
  const rawDiff = (...paths: string[]) => paths.map((p) => `:100644 100644 aaa bbb M\0${p}\0`).join('')
  const diffOutput = { 'git diff': rawDiff('src/chat.ts') }
  const linearBranch = 'jane/thb-1-renaming-a-chat-loses-its-title'
  const argAfter = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1]

  type Setup = {
    ticket?: boolean
    branch?: string
    kind?: FixTask['kind']
    extra?: Partial<FixTask['finding']>
    /** A native task's flow: the task carries it instead of a spec. */
    flow?: string
    charterDir?: string
    real?: boolean
    verifyNative?: NativeCheck[]
  }
  const setup = async ({
    ticket = true,
    branch = ticket ? linearBranch : `qa-fix/${fp}`,
    kind = 'spec',
    extra,
    flow,
    charterDir = 'c2-chat',
    real = false,
    verifyNative = [],
  }: Setup = {}) => {
    const base = {
      fp,
      severity: 'High',
      branch,
      charterDir,
      platform: 'desktop',
      real,
      finding: {
        title: 'Renaming a chat\nloses its title',
        area: 'chat',
        viewport: 'desktop',
        oracle: { type: 'lost-on-reload', evidence: 'Untitled after a reload' },
        steps: ['Rename a chat'],
        expected: 'Renamed',
        actual: 'Untitled',
        ...extra,
      },
    } satisfies Omit<FixTask, 'kind' | 'spec' | 'flow'>
    const proof = () => {
      if (flow) return { kind, platform: 'ios', flow }
      return kind === 'visual' ? { kind } : { kind, spec: specPath() }
    }
    const task: FixTask = { ...base, ...proof() }
    const withTicket = { ...task, issueId: 'issue-1', identifier: 'THB-1' }
    const plan: FixPlan = { fixes: [ticket ? withTicket : task], verifyNative }
    await put(join(outDir, 'fix-plan.json'), JSON.stringify(plan))
    await put(specPath(), spec)
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec)
    await put(join(outDir, 'fix', `${fp}.patch`), 'diff --git a/src/chat.ts b/src/chat.ts\n')
    await putStatus(null)
    await putPasses(...everyCheck)
  }
  const putStatus = (stoppedBeforeSession: string | null) =>
    put(join(outDir, 'status', `${fp}.json`), JSON.stringify({ stoppedBeforeSession }))
  const everyCheck = ['session', 'replay', 'visual', 'tests', 'real', 'ios', 'android', 'checks']
  /** The run's artifact names as the publish job lists them: the passes of `checks`, among other artifacts. */
  const putPasses = (...checks: string[]) => putPassesOf('1', ...checks)
  /** The same, as uploaded in run attempt `attempt`. */
  const putPassesOf = (attempt: string, ...checks: string[]) =>
    put(
      join(outDir, 'artifacts.txt'),
      [`qa-fix-${fp}-${attempt}`, ...checks.map((c) => `qa-pass-${fp}-${c}-${attempt}`), ''].join('\n'),
    )

  test('dry run: validates and describes the PR without writing anything', async () => {
    await setup()
    const runs: RunCall[] = []
    const calls: Call[] = []
    const lines: string[] = []
    const result = await publish({
      outDir,
      fp,
      live: false,
      run: fakeRun(runs, diffOutput),
      fetchFn: fakeLinear(calls),
      log: (line) => lines.push(line),
    })

    expect(result).toEqual({
      outcome: 'pr',
      branch: linearBranch,
      files: ['src/chat.ts'],
      spec: 'e2e/consumer-qa-ab12cd34.spec.ts',
      commit:
        'fix: Renaming a chat loses its title\n\n' +
        "Keeps the QA agent's repro as the regression test e2e/consumer-qa-ab12cd34.spec.ts.",
    })
    expect(runs.map((r) => r.cmd.slice(0, 2).join(' '))).toEqual(['git read-tree', 'git apply', 'git diff'])
    expect(runs[1].cmd).toContain('--cached')
    expect(calls).toEqual([])
    expect(lines.join('\n')).toContain(`would push ${linearBranch}`)
  })

  test("live: one commit on the plan's branch, pushed only if it is new, a draft PR, and its link on the ticket", async () => {
    await setup()
    const repoDir = join(dir, 'repo')
    await mkdir(join(repoDir, 'e2e'), { recursive: true })
    const runs: RunCall[] = []
    const calls: Call[] = []
    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 'app-token',
      repoDir,
      run: fakeRun(runs, { ...diffOutput, 'gh pr': 'https://github.com/o/r/pull/9\n' }),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    expect(result).toMatchObject({ outcome: 'pr', prUrl: 'https://github.com/o/r/pull/9' })
    const noHooks = ['git', '-c', 'core.hooksPath=/dev/null']
    expect(runs.slice(3, -1).map((r) => r.cmd.slice(0, 5))).toEqual([
      [...noHooks, 'switch', '--create'],
      [...noHooks, 'apply', '--index'],
      [...noHooks, 'add', 'e2e/consumer-qa-ab12cd34.spec.ts'],
      [...noHooks, 'commit', '--no-verify'],
      [...noHooks, 'push', '--no-verify'],
    ])
    expect(argAfter(runs[3].cmd, '--create')).toBe(linearBranch)
    const [push, pr] = runs.slice(-2)
    expect(push.cmd.slice(5)).toEqual([
      `--force-with-lease=refs/heads/${linearBranch}:`,
      'origin',
      `HEAD:refs/heads/${linearBranch}`,
    ])
    expect(pr.cmd.slice(0, 3)).toEqual(['gh', 'pr', 'create'])
    expect(argAfter(pr.cmd, '--head')).toBe(linearBranch)
    expect(push.cmd.join(' ')).not.toContain('app-token')
    expect(Buffer.from(push.env?.GIT_CONFIG_VALUE_0.split(' ').at(-1) ?? '', 'base64').toString()).toBe(
      'x-access-token:app-token',
    )
    expect(pr.cmd).toContain('--draft')
    expect(pr.env).toEqual({ GH_TOKEN: 'app-token' })
    // The branch name links the PR to the ticket, so the description does not name it.
    expect(pr.stdin).not.toContain('THB-1')
    expect(pr.stdin).toContain('**Finding:** `Renaming a chat loses its title` · chat · High')
    expect(runs.flatMap((r) => r.cmd).some((arg) => /^(merge|ready|review)$/.test(arg))).toBe(false)
    expect(await readFile(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts'), 'utf8')).toBe(
      (await regressionSpec('c2-chat', fp, spec)).source,
    )
    expect(calls).toEqual([
      { op: 'Comment', variables: { issueId: 'issue-1', body: 'Draft fix PR: https://github.com/o/r/pull/9' } },
    ])
  })

  const publishLive = async (outputs = diffOutput) => {
    const repoDir = join(dir, 'repo')
    await mkdir(join(repoDir, 'e2e'), { recursive: true })
    const runs: RunCall[] = []
    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 'app-token',
      repoDir,
      run: fakeRun(runs, { ...outputs, 'gh pr': 'https://github.com/o/r/pull/9\n' }),
      fetchFn: fakeLinear([]),
      log: () => {},
    })
    return { repoDir, runs, result }
  }
  test('a security fix PR carries no finding text and no regression spec, only the ticket', async () => {
    await setup({
      branch: 'qa-fix/thb-1',
      extra: {
        title: 'Search leaks other users chats',
        area: 'security',
        oracle: { type: 'assert-failed', evidence: 'saw chat of user b' },
        steps: ['Search for b@thunderbolt.test'],
        expected: 'Only my chats',
        actual: 'Chats of user b',
      },
    })

    const { repoDir, runs, result } = await publishLive()

    expect(result).toEqual({
      outcome: 'pr',
      branch: 'qa-fix/thb-1',
      files: ['src/chat.ts'],
      commit: 'fix: QA finding THB-1',
      prUrl: 'https://github.com/o/r/pull/9',
    })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    const pr = runs.find((r) => r.cmd[0] === 'gh')
    const commit = runs.find((r) => r.cmd.includes('commit'))
    const published = [pr?.stdin, argAfter(pr?.cmd ?? [], '--title'), argAfter(commit?.cmd ?? [], '--message')]
    expect(pr?.stdin).not.toContain('THB-1')
    // Not even the word: a public PR flagged as a security fix points at the hole before the fix ships.
    for (const text of ['leaks', 'user b', 'b@thunderbolt', 'Only my chats', 'consumer-qa-', 'security']) {
      expect(published.join('\n').toLowerCase()).not.toContain(text.toLowerCase())
    }
  })

  test('a visual fix PR keeps the check the fix agent wrote as its regression test', async () => {
    await setup({ kind: 'visual' })
    const check = `import { layoutProblems } from '../../../.github/qa/layout'\n${spec}`
    await put(join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts'), check)

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: 'e2e/consumer-qa-ab12cd34.spec.ts' })
    expect(await readFile(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts'), 'utf8')).toBe(
      (await regressionSpec('c2-chat', fp, check)).source,
    )
    expect(runs.at(-1)?.stdin).toContain('failed without this patch and passes with it')
  })

  test('a real-AI web visual fix is never published, even when its check passed on the fake AI', async () => {
    await setup({ kind: 'visual', real: true, charterDir: 'c4-skills-projects-desktop' })
    await put(join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts'), spec)
    const runs: RunCall[] = []
    const calls: Call[] = []

    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 't',
      run: fakeRun(runs, diffOutput),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    const reason = 'a real-AI web fix without a repro spec cannot be checked on the real AI providers'
    expect(result).toEqual({ outcome: 'human-required', reasons: [reason] })
    expect(runs.map((r) => r.cmd[1])).toEqual(['read-tree', 'apply', 'diff'])
    expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    expect(calls[0].variables.body).toContain(`- ${reason}`)
  })

  test('a fix from the sync session is never published, on the web or Android, since nothing verifies it with sync', async () => {
    const flow = join(outDir, 'c7-two-devices-android', 'repro', '1.yaml')
    const tasks = [{ charterDir: 'c7-two-devices-desktop' }, { charterDir: 'c7-two-devices-android', flow }]
    for (const task of tasks) {
      await setup(task)
      await put(flow, '- launchApp\n')
      await put(join(outDir, 'fix', `${fp}.yaml`), '- launchApp\n')
      const calls: Call[] = []

      const result = await publish({
        outDir,
        fp,
        live: true,
        key: 'lin',
        token: 't',
        run: fakeRun([], diffOutput),
        fetchFn: fakeLinear(calls),
        log: () => {},
      })

      const reason = 'a fix found in a session that needs Postgres and PowerSync is not verified with them'
      expect({ task, result }).toEqual({ task, result: { outcome: 'human-required', reasons: [reason] } })
      expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    }
  })

  test("a backend change is published only when the plan's native verification does not check the bug", async () => {
    const android: NativeCheck = { fp, platform: 'android', session: 'c2-chat-android', flow: 'a', unpatched: false }
    const outcomes = []
    for (const verifyNative of [[], [android]]) {
      await setup({ verifyNative })
      const { runs, result } = await publishLive({ 'git diff': rawDiff('src/chat.ts', 'backend/src/chat.ts') })
      outcomes.push([result.outcome, runs.some((r) => r.cmd.includes('push'))])
    }
    expect(outcomes).toEqual([
      ['pr', true],
      ['human-required', false],
    ])
  })

  test('a native fix PR adds no regression spec and names the platform the flow checked it on', async () => {
    const flow = join(outDir, 'c1-first-run-ios', 'repro', '1.yaml')
    await setup({ flow })
    await put(flow, '- launchApp\n')
    await put(join(outDir, 'fix', `${fp}.yaml`), '- launchApp\n')

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: undefined })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    expect(runs.at(-1)?.stdin).toContain("Checked on ios with the finding's Maestro flow")
  })

  test('an onboarding fix PR adds no regression spec, since e2e/ does not serve the onboarding build', async () => {
    await setup({ charterDir: 'c1-first-run-desktop' })
    // A literal port, which the repro lint allows, so the session decides rather than the ports import.
    const onboardingSpec = `test.use({ baseURL: 'http://localhost:1425' })\n${spec}`
    await put(specPath(), onboardingSpec)
    await put(join(outDir, 'fix', `${fp}.spec.ts`), onboardingSpec)

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: undefined })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    expect(runs.at(-1)?.stdin).toContain('runs on the onboarding build')
  })

  test('a real-AI web fix PR adds no regression spec, since e2e/ runs the consumer project on the fake provider', async () => {
    await setup({ real: true, charterDir: 'c3-models-providers-desktop' })

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: undefined })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    expect(runs.at(-1)?.stdin).toContain('runs on the fake provider')
  })

  test('a fix a unit test can show adds no spec, and its PR says the unit test guards it', async () => {
    await setup({ extra: { oracle: { type: 'assert-failed', evidence: 'expected Renamed' } } })

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: undefined })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    const commit = argAfter(runs.find((r) => r.cmd.includes('commit'))?.cmd ?? [], '--message')
    for (const text of [runs.at(-1)?.stdin ?? '', commit]) {
      expect(text).toContain('The unit test in this patch guards the fix.')
      expect(text).not.toMatch(/is added as|Keeps .* as the regression test|e2e\/consumer-qa-/)
    }
  })

  test('a patch without the PR checks pass leaves the ticket and the repository alone and says so', async () => {
    await setup()
    await putPasses(...everyCheck.filter((c) => c !== 'checks'))
    const summary = join(dir, 'summary.md')
    const runs: RunCall[] = []
    const calls: Call[] = []
    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 't',
      summary,
      run: fakeRun(runs, diffOutput),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    expect(result).toEqual({ outcome: 'infrastructure', reason: expect.stringContaining('gate did not pass') })
    // Only checkPatch's read of the patch: no branch, commit or push.
    expect(runs.map((r) => r.cmd[1])).toEqual(['read-tree', 'apply', 'diff'])
    expect(calls).toEqual([])
    expect(await readFile(summary, 'utf8')).toBe(
      '- THB-1 is left untouched for a later run: the PR checks gate did not pass\n',
    )
  })

  test('unit tests that did not fail without the fix send the ticket to a person, even past a failed PR check', async () => {
    await setup()
    await putPasses('session', 'replay')
    const run = fakeRun([], { 'git diff': rawDiff('src/chat.ts', 'src/chat.test.ts') })
    expect(await publish({ outDir, fp, live: false, run, log: () => {} })).toEqual({
      outcome: 'human-required',
      reasons: ["the patch's unit tests did not fail without the fix and pass with it"],
    })
  })

  test('dry run: a diagnosis is only described, with no git command and no Linear call', async () => {
    await setup()
    await put(join(outDir, 'fix', `${fp}.diagnosis.md`), 'Root cause in src/chat.ts:3.')
    const runs: RunCall[] = []
    const calls: Call[] = []
    const lines: string[] = []
    const result = await publish({
      outDir,
      fp,
      live: false,
      run: fakeRun(runs),
      fetchFn: fakeLinear(calls),
      log: (line) => lines.push(line),
    })

    expect(result).toEqual({ outcome: 'human-required', reasons: ['the fix agent wrote a diagnosis'] })
    expect(runs).toEqual([])
    expect(calls).toEqual([])
    expect(lines.join('\n')).toContain('would comment on THB-1 and label it "Human Required"')
  })

  // setup() records a session that began, so this is also the path of one that failed or timed out.
  test('a diagnosis means no PR: the ticket gets it as a comment and the human required label', async () => {
    await setup()
    await put(join(outDir, 'fix', `${fp}.diagnosis.md`), 'Root cause in src/chat.ts:3, needs a product call.')
    const runs: RunCall[] = []
    const calls: Call[] = []
    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 't',
      run: fakeRun(runs),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    expect(result).toEqual({ outcome: 'human-required', reasons: ['the fix agent wrote a diagnosis'] })
    expect(runs).toEqual([])
    expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    expect(calls[0].variables.body).toContain('Root cause in src/chat.ts:3')
    expect(calls.find((c) => c.op === 'Label')?.variables.name).toBe('Human Required')
  })

  // The patch would pass every check, so only the status stands between it and a PR.
  const publishPassingPatch = (runs: RunCall[], calls: Call[], log: (line: string) => void = () => {}) =>
    publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 't',
      summary: join(dir, 'summary.md'),
      run: fakeRun(runs, diffOutput),
      fetchFn: fakeLinear(calls),
      log,
    })

  test.each([
    ['setup-failed', 'before the fix step ran'],
    ['no-model-answer', 'before the model first answered'],
  ])('a job stopped before the session (%s) leaves the ticket and the repository alone', async (stopped, why) => {
    await setup()
    await putStatus(stopped)
    const runs: RunCall[] = []
    const calls: Call[] = []
    const lines: string[] = []
    const result = await publishPassingPatch(runs, calls, (line) => lines.push(line))

    expect(result).toEqual({ outcome: 'infrastructure', reason: expect.stringContaining(why) })
    expect(runs).toEqual([])
    expect(calls).toEqual([])
    expect(lines.join('\n')).toMatch(new RegExp(`THB-1 is left untouched for a later run: .*${why}`))
    expect(await readFile(join(dir, 'summary.md'), 'utf8')).toMatch(
      new RegExp(`^- THB-1 is left untouched for a later run: .*${why}.*\\n$`),
    )
  })

  test.each([
    ['missing', undefined],
    ['not JSON', 'stopped'],
    ['without the field', '{}'],
    ['an unknown reason', '{"stoppedBeforeSession":"repo-on-fire"}'],
    ['a boolean', '{"stoppedBeforeSession":false}'],
  ])('a status file that is %s fails publish without a PR or a ticket write', async (_, text) => {
    await setup()
    await rm(join(outDir, 'status', `${fp}.json`))
    if (text !== undefined) await put(join(outDir, 'status', `${fp}.json`), text)
    const runs: RunCall[] = []
    const calls: Call[] = []

    await expect(publishPassingPatch(runs, calls)).rejects.toThrow()
    expect(runs).toEqual([])
    expect(calls).toEqual([])
  })

  test('never posts a diagnosis that matches a secret pattern', async () => {
    await setup()
    await put(join(outDir, 'fix', `${fp}.diagnosis.md`), 'The key is sk-ant-abcdefghijklmnop')
    const calls: Call[] = []
    await publish({ outDir, fp, live: true, key: 'lin', token: 't', run: fakeRun([]), fetchFn: fakeLinear(calls) })
    expect(calls[0].variables.body).not.toContain('sk-ant')
  })

  test('a rejected patch means no PR: the reasons go on the ticket', async () => {
    await setup()
    const runs: RunCall[] = []
    const calls: Call[] = []
    const result = await publish({
      outDir,
      fp,
      live: true,
      key: 'lin',
      token: 't',
      run: fakeRun(runs, { 'git diff': rawDiff('src/chat.ts', '.github/workflows/ci.yml') }),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    expect(result).toEqual({ outcome: 'human-required', reasons: ['touches .github/workflows/ci.yml'] })
    expect(runs.map((r) => r.cmd[1])).toEqual(['read-tree', 'apply', 'diff'])
    expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    expect(calls[0].variables.body).toContain('- touches .github/workflows/ci.yml')
  })

  describe('the passes a task needs', () => {
    const nativeFlow = () => join(outDir, 'c1-first-run-ios', 'repro', '1.yaml')
    const native = (platform: string): NativeCheck => ({
      fp,
      platform,
      session: 'c2-chat',
      flow: 'f',
      unpatched: false,
    })
    const reasons = {
      session: 'the fix session did not finish',
      replay: 'the repro spec did not pass three times on the patched code',
      visual: 'the visual check did not fail three times without the patch and pass three times with it',
      tests: "the patch's unit tests did not fail without the fix and pass with it",
      real: 'the repro spec still fails on the real AI providers',
      ios: 'the flow still fails on the native platform (ios)',
      android: 'the flow still fails on the native platform (android)',
    }
    const tasks: [string, Setup, (keyof typeof reasons)[]][] = [
      ['a web spec task', {}, ['session', 'replay', 'tests']],
      ['a web visual task', { kind: 'visual' }, ['session', 'visual', 'tests']],
      ['a real-AI web task', { real: true, charterDir: 'c3-models-providers-desktop' }, ['session', 'real', 'tests']],
      [
        'a web task also found on Android',
        { verifyNative: [native('android')] },
        ['session', 'replay', 'tests', 'android'],
      ],
      ['a native task', { flow: 'native', verifyNative: [native('ios')] }, ['session', 'ios']],
    ]
    const setupTask = async ({ flow, ...rest }: Setup) => {
      await setup({ ...rest, flow: flow && nativeFlow() })
      await put(nativeFlow(), '- launchApp\n')
      await put(join(outDir, 'fix', `${fp}.yaml`), '- launchApp\n')
      await put(join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts'), spec)
    }
    const dryRun = () =>
      publish({
        outDir,
        fp,
        live: false,
        run: fakeRun([], { 'git diff': rawDiff('src/chat.ts', 'src/chat.test.ts') }),
        log: () => {},
      })

    test.each(tasks)(
      '%s opens a PR with only its own passes, and goes to a person without any one of them',
      async (_, task, needed) => {
        await setupTask(task)
        await putPasses(...needed, 'checks')
        expect((await dryRun()).outcome).toBe('pr')
        for (const missing of needed) {
          await putPasses(...needed.filter((c) => c !== missing), 'checks')
          const result = await dryRun()
          expect({ missing, result }).toMatchObject({ missing, result: { outcome: 'human-required' } })
          expect(result.outcome === 'human-required' && result.reasons).toEqual([
            expect.stringContaining(reasons[missing]),
          ])
        }
      },
    )

    test('a pass of another fingerprint counts for nothing', async () => {
      await setupTask({})
      await put(
        join(outDir, 'artifacts.txt'),
        ['session', 'replay', 'tests'].map((c) => `qa-pass-ffffffff-${c}-1`).join('\n'),
      )
      expect(await dryRun()).toEqual({
        outcome: 'human-required',
        reasons: [reasons.session, reasons.replay, reasons.tests],
      })
    })

    // One artifact list spans every attempt of the run, so a re-run must not pair one attempt's patch with another's
    // passes.
    test('only the passes of the attempt whose patch publish read count', async () => {
      await setupTask({})
      await putPassesOf('1', 'session', 'replay', 'tests', 'checks')
      const inAttempt = (attempt: string) =>
        publish({
          outDir,
          fp,
          live: false,
          attempt,
          run: fakeRun([], { 'git diff': rawDiff('src/chat.ts', 'src/chat.test.ts') }),
          log: () => {},
        })
      expect((await inAttempt('1')).outcome).toBe('pr')
      expect(await inAttempt('2')).toEqual({
        outcome: 'human-required',
        reasons: [reasons.session, reasons.replay, reasons.tests],
      })
    })

    test('a patch missing from this attempt goes to a person, not a PR', async () => {
      await setupTask({})
      await rm(join(outDir, 'fix', `${fp}.patch`))
      const runs: RunCall[] = []
      const calls: Call[] = []
      const result = await publish({
        outDir,
        fp,
        live: true,
        key: 'lin',
        token: 't',
        attempt: '2',
        run: fakeRun(runs),
        fetchFn: fakeLinear(calls),
        log: () => {},
      })
      expect(result).toEqual({
        outcome: 'human-required',
        reasons: ['the fix job uploaded no output in run attempt 2'],
      })
      expect(runs).toEqual([])
      expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    })

    test('a web patch with no unit test says so', async () => {
      await setupTask({})
      await putPasses('session', 'replay')
      const result = await publish({ outDir, fp, live: false, run: fakeRun([], diffOutput), log: () => {} })
      expect(result).toEqual({
        outcome: 'human-required',
        reasons: [
          'the patch adds or changes no unit test file (`*.test.ts` or `*.test.tsx` under `src/`, `shared/`, `backend/` or `cli/`), and every web fix needs one that fails without the fix',
        ],
      })
    })

    // Code the agent wrote ran in the fix job after the checks, so it could have deleted the diagnosis the workflow
    // wrote, or written a result file of its own saying the check passed. Neither is a pass.
    test.each([
      ['a failed replay whose diagnosis was deleted', {}, ['session', 'tests']],
      ['a failed visual check with a passing result file in the fix output', { kind: 'visual' }, ['session', 'tests']],
    ] as const)('%s goes to a person, not a PR', async (_, task, passes) => {
      await setupTask(task)
      await putPasses(...passes)
      await put(join(outDir, 'fix', `${fp}.result.json`), JSON.stringify({ failsWithout: true, passesWith: true }))
      const runs: RunCall[] = []
      const calls: Call[] = []
      const result = await publish({
        outDir,
        fp,
        live: true,
        key: 'lin',
        token: 't',
        run: fakeRun(runs, { 'git diff': rawDiff('src/chat.ts', 'src/chat.test.ts') }),
        fetchFn: fakeLinear(calls),
        log: () => {},
      })
      expect(result.outcome).toBe('human-required')
      expect(runs.some((r) => r.cmd.includes('push'))).toBe(false)
      expect(calls.map((c) => c.op)).toEqual(['Comment', 'Label', 'AddLabel'])
    })

    test('a missing list of artifacts fails publish without a PR or a ticket write', async () => {
      await setupTask({})
      await rm(join(outDir, 'artifacts.txt'))
      const calls: Call[] = []
      await expect(
        publish({ outDir, fp, live: true, key: 'lin', token: 't', run: fakeRun([]), fetchFn: fakeLinear(calls) }),
      ).rejects.toThrow()
      expect(calls).toEqual([])
    })
  })

  test('refuses a live run without credentials, a ticket, or a routed fingerprint', async () => {
    await setup({ ticket: false })
    const opts = { outDir, fp, run: fakeRun([]), fetchFn: fakeLinear([]), log: () => {} }
    await expect(publish({ ...opts, live: true, key: 'lin' })).rejects.toThrow('GH_TOKEN')
    await expect(publish({ ...opts, live: true, key: 'lin', token: 't' })).rejects.toThrow('no Linear ticket')
    await expect(publish({ ...opts, fp: 'ffffffff', live: false })).rejects.toThrow('not in fix-plan.json')
  })
})
