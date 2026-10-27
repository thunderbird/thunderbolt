/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Filed } from './file-findings'
import type { Area, RawFinding, Severity } from './findings'
import {
  checkPatch,
  type FixPlan,
  type FixTask,
  isDenied,
  type NativeCheck,
  publish,
  regressionSpec,
  route,
  type Run,
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
/** Fake Linear API that records each operation and answers with success. */
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
/** Fake command runner: records calls and answers from `outputs` keyed by the first two words. */
const fakeRun = (calls: RunCall[], outputs: Record<string, string> = {}): Run => {
  return async (cmd, opts = {}) => {
    calls.push({ cmd, ...opts })
    return outputs[cmd.slice(0, 2).join(' ')] ?? ''
  }
}

/** Runs real commands in `cwd`. */
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
    { id: 'rolled-chat', area: 'chat', severity: 'Urgent', action: 'rolled-up' },
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
  const branches = { 'git ls-remote': `abc123\trefs/heads/qa-fix/${fp('pending-layout')}\n` }

  test('routes at most three confirmed tickets of any area, highest severity first, skipping pending branches', async () => {
    await setup()
    const runs: RunCall[] = []
    const lines: string[] = []
    const plan = await route({ outDir, live: false, run: fakeRun(runs, branches), log: (line) => lines.push(line) })

    expect(lines).toContain(`fix: ${fp('nospec-chat')} has no repro on disk, so it is not routed`)
    // pending-layout (Urgent) has an open qa-fix/ branch; high-sync is the third, so the cap leaves out
    // high-security, medium-widgets and low-chat.
    expect(plan.fixes.map((t) => t.fp)).toEqual([fp('urgent-settings'), fp('high-skills'), fp('high-sync')])
    expect(JSON.parse(await readFile(join(outDir, 'fix-plan.json'), 'utf8'))).toEqual(plan)
    expect(runs.map((r) => r.cmd)).toEqual([['git', 'ls-remote', '--heads', 'origin', 'qa-fix/*']])
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

  /** Writes filed.json and verified.json for these created, confirmed tickets, with each repro on disk. */
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
  /** Routes one confirmed, created ticket from `charterDir`, with its repro on disk when it names one. */
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

  test('a sync bug filed after three others of the same severity does not take their slots', async () => {
    const sessions = ['c2-chat-power-user-desktop', 'c2-chat-power-user-phone', 'c6-settings-data-desktop']
    await fileTickets([
      ...sessions.map((charterDir, i) => ({ fp: `fp-${i}`, charterDir, raw: finding('chat') })),
      { fp: 'fp-sync', charterDir: 'c7-two-devices-desktop', raw: finding('chat') },
    ])
    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })
    expect(plan.fixes.map((t) => t.fp)).toEqual(['fp-0', 'fp-1', 'fp-2'])
  })

  test('routes one fix per fingerprint when the same bugs were filed on desktop and phone', async () => {
    const ticket = { fp: 'fp-same', severity: 'High', action: 'created', issueId: 'i1', identifier: 'THB-1' } as const
    const sync = { fp: 'fp-sync', severity: 'High', action: 'created', issueId: 'i2', identifier: 'THB-2' } as const
    const filed: Filed[] = [
      { ...ticket, charterDir: 'c2-chat-power-user-desktop', id: '1' },
      { ...ticket, charterDir: 'c2-chat-power-user-phone', id: '1' },
      { ...sync, charterDir: 'c2-chat-power-user-desktop', id: '2' },
      { ...sync, charterDir: 'c2-chat-power-user-phone', id: '2' },
    ]
    const confirmed: VerifiedFinding[] = filed.map(({ charterDir, id }) => ({
      charterDir,
      id,
      finding: finding(id === '1' ? 'chat' : 'sync', { repro_spec: `repro/${id}.spec.ts` }),
      replay: { failed: 3, runs: 3 },
      artifacts: {},
    }))
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    for (const { charterDir, id } of filed) await put(join(outDir, charterDir, 'repro', `${id}.spec.ts`), spec)

    const plan = await route({ outDir, live: true, run: fakeRun([]), log: () => {} })

    expect(plan.fixes.map((t) => [t.fp, t.charterDir])).toEqual([
      ['fp-same', 'c2-chat-power-user-desktop'],
      ['fp-sync', 'c2-chat-power-user-desktop'],
    ])
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
  test('names the spec for the consumer project and imports from e2e/', () => {
    const { path, source } = regressionSpec('c4-skills-projects', 'ab12cd34', spec)
    expect(path).toBe('e2e/consumer-qa-ab12cd34.spec.ts')
    expect(source).toContain("import { expect, test } from './test'")
    expect(source).toContain("import { loginViaEmailCode } from './helpers'")
    expect(source).not.toContain('../../../e2e')
    expect(source.split('\n').slice(2)).toEqual(spec.split('\n').slice(2))
  })

  test('moves the layout helper import from qa-out/ to e2e/', () => {
    const source = `import { layoutProblems } from '../../../.github/qa/layout'\n`
    expect(regressionSpec('c8-phone', 'ab12cd34', source).source).toBe(
      `import { layoutProblems } from '../.github/qa/layout'\n`,
    )
  })

  test('moves the ports import from qa-out/ to e2e/, in either quote style', () => {
    const source = `import { frontendURL } from '../../../.github/qa/ports'\nimport { stackURLs } from "../../../.github/qa/ports"\n`
    expect(regressionSpec('c2-chat-power-user', 'ab12cd34', source).source).toBe(
      `import { frontendURL } from '../.github/qa/ports'\nimport { stackURLs } from "../.github/qa/ports"\n`,
    )
  })

  test('uses the sync prefix for the two-device charter', () => {
    expect(regressionSpec('c7-two-devices', 'ab12cd34', spec).path).toBe('e2e/sync-qa-ab12cd34.spec.ts')
  })

  test('keeps @playwright/test when the spec imports something e2e/test.ts does not export', () => {
    const source = `import { devices, test } from '@playwright/test'\nimport type { Page } from "@playwright/test"\n`
    expect(regressionSpec('c8-phone', 'ab12cd34', source).source).toBe(
      `import { devices, test } from '@playwright/test'\nimport type { Page } from "./test"\n`,
    )
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
    charterDir: 'c2-chat',
    platform: 'desktop',
    kind: 'visual',
    real: false,
    finding: { ...finding('layout'), oracle: { type: 'visual', evidence: 'Continue sits under the banner' } },
  })
  const fixed = () => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n')

  /** Writes `fix/<fp>.patch` from the given working-tree edits, then resets the repo. */
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
    expect(await checkPatch(git, outDir, task(), [])).toEqual({ reasons: [], files: ['src/chat.ts'] })
    expect(await git(['git', 'status', '--porcelain'])).toBe('')
  })

  test('rejects an empty patch', async () => {
    await put(join(outDir, 'fix', `${fp}.patch`), '\n')
    expect(await checkPatch(git, outDir, task(), [])).toEqual({ reasons: ['empty patch'], files: [] })
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
    /** Writes `verify.json` as given, so a test can also write a broken one. */
    const verify = (text: string) => put(join(outDir, 'fix', `${fp}.verify.json`), text)
    const passed = '{ "failsWithout": true, "passesWith": true }'
    const notVerified = 'the visual check did not fail without the patch and pass with it'
    const unreadable = 'the visual check result is unreadable'

    test('passes with a linted check that failed without the patch and passed with it', async () => {
      await patchFrom(fixed)
      await put(check(), spec)
      await verify(passed)
      expect(await checkPatch(git, outDir, visualTask(), [])).toEqual({ reasons: [], files: ['src/chat.ts'] })
    })

    test('is rejected without a check, and with a check that fails the lint', async () => {
      await patchFrom(fixed)
      await verify(passed)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual(['the visual check is missing'])

      await put(check(), `${spec}process.exit(0)\n`)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual([
        'visual check: line 8: "process" is not allowed',
      ])
    })

    test.each([
      ['no verify.json', undefined, notVerified],
      ['a check that passed without the patch', '{ "failsWithout": false, "passesWith": true }', notVerified],
      ['a check that still fails with the patch', '{ "failsWithout": true, "passesWith": false }', notVerified],
      // Real booleans only: the workflow writes this file, so anything else is a broken record.
      ['a verify.json with strings', '{ "failsWithout": "true", "passesWith": "true" }', unreadable],
      ['a verify.json missing a field', '{ "failsWithout": true }', unreadable],
      ['a verify.json that is not JSON', '{ "failsWithout": true,', unreadable],
    ])('is rejected with %s', async (_name, result, reason) => {
      await patchFrom(fixed)
      await put(check(), spec)
      if (result) await verify(result)
      expect((await checkPatch(git, outDir, visualTask(), [])).reasons).toEqual([reason])
    })
  })

  describe('a native task', () => {
    const flow = '- launchApp\n- assertVisible: Renamed\n'
    const reproFlow = () => join(outDir, 'c1-first-run-ios', 'repro', '1.yaml')
    const check = () => join(outDir, `fix-${fp}`, 'repro', 'check.yaml')
    const native = (): FixTask => ({
      fp,
      severity: 'High',
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
      expect(await checkPatch(git, outDir, native(), [])).toEqual({ reasons: [], files: ['src-tauri/src/lib.rs'] })
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

    test('a visual one needs a Maestro check inside the allow list, verified like a web check', async () => {
      await patchFrom(fixed)
      await put(join(outDir, 'fix', `${fp}.verify.json`), '{ "failsWithout": true, "passesWith": true }')
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

describe('publish', () => {
  const fp = 'ab12cd34'
  const specPath = () => join(outDir, 'c2-chat', 'repro', '1.spec.ts')
  /** `git diff --raw -z` output for these modified regular files. */
  const rawDiff = (...paths: string[]) => paths.map((p) => `:100644 100644 aaa bbb M\0${p}\0`).join('')
  const diffOutput = { 'git diff': rawDiff('src/chat.ts') }

  type Setup = {
    ticket?: boolean
    kind?: FixTask['kind']
    url?: string
    extra?: Partial<FixTask['finding']>
    /** A native task's flow: the task carries it instead of a spec. */
    flow?: string
    charterDir?: string
    real?: boolean
    verifyNative?: NativeCheck[]
  }
  const setup = async ({
    ticket = true,
    kind = 'spec',
    url = 'https://linear.app/t/THB-1',
    extra,
    flow,
    charterDir = 'c2-chat',
    real = false,
    verifyNative = [],
  }: Setup = {}) => {
    const base = {
      fp,
      severity: 'High',
      charterDir,
      platform: 'desktop',
      real,
      finding: {
        title: 'Renaming a chat\nloses its title',
        area: 'chat',
        viewport: 'desktop',
        oracle: { type: 'assert-failed', evidence: 'expected Renamed' },
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
    const withTicket = { ...task, issueId: 'issue-1', identifier: 'THB-1', url }
    const plan: FixPlan = { fixes: [ticket ? withTicket : task], verifyNative }
    await put(join(outDir, 'fix-plan.json'), JSON.stringify(plan))
    await put(specPath(), spec)
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec)
    await put(join(outDir, 'fix', `${fp}.patch`), 'diff --git a/src/chat.ts b/src/chat.ts\n')
  }

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
      branch: 'qa-fix/ab12cd34',
      files: ['src/chat.ts'],
      spec: 'e2e/consumer-qa-ab12cd34.spec.ts',
      commit:
        'fix: Renaming a chat loses its title\n\n' +
        "Keeps the QA agent's repro as the regression test e2e/consumer-qa-ab12cd34.spec.ts.",
    })
    expect(runs.map((r) => r.cmd.slice(0, 2).join(' '))).toEqual(['git read-tree', 'git apply', 'git diff'])
    expect(runs[1].cmd).toContain('--cached')
    expect(calls).toEqual([])
    expect(lines.join('\n')).toContain('THB-1 (https://linear.app/t/THB-1)')
  })

  test('live: one commit on qa-fix/<fp>, pushed with the token, a draft PR, and the PR link on the ticket', async () => {
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
    const [push, pr] = runs.slice(-2)
    expect(pr.cmd.slice(0, 3)).toEqual(['gh', 'pr', 'create'])
    expect(push.cmd.join(' ')).not.toContain('app-token')
    expect(Buffer.from(push.env?.GIT_CONFIG_VALUE_0.split(' ').at(-1) ?? '', 'base64').toString()).toBe(
      'x-access-token:app-token',
    )
    expect(pr.cmd).toContain('--draft')
    expect(pr.env).toEqual({ GH_TOKEN: 'app-token' })
    expect(pr.stdin).toContain('THB-1 (https://linear.app/t/THB-1)')
    expect(pr.stdin).toContain('**Finding:** `Renaming a chat loses its title` · chat · High')
    expect(runs.flatMap((r) => r.cmd).some((arg) => /^(merge|ready|review)$/.test(arg))).toBe(false)
    expect(await readFile(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts'), 'utf8')).toBe(
      regressionSpec('c2-chat', fp, spec).source,
    )
    expect(calls).toEqual([
      { op: 'Comment', variables: { issueId: 'issue-1', body: 'Draft fix PR: https://github.com/o/r/pull/9' } },
    ])
  })

  /** Runs a live publish into a fresh `repo/`, git answering from `outputs`, and returns the commands it ran. */
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
  /** The value after `flag` in a command. */
  const argAfter = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1]

  test('a security fix PR carries no finding text and no regression spec, only the ticket', async () => {
    await setup({
      url: 'https://linear.app/t/issue/THB-1/search-leaks-other-users-chats',
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
      branch: 'qa-fix/ab12cd34',
      files: ['src/chat.ts'],
      commit: 'fix: QA finding THB-1',
      prUrl: 'https://github.com/o/r/pull/9',
    })
    expect(runs.some((r) => r.cmd.includes('add'))).toBe(false)
    expect(await Bun.file(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts')).exists()).toBe(false)
    const pr = runs.find((r) => r.cmd[0] === 'gh')
    const commit = runs.find((r) => r.cmd.includes('commit'))
    const published = [pr?.stdin, argAfter(pr?.cmd ?? [], '--title'), argAfter(commit?.cmd ?? [], '--message')]
    expect(pr?.stdin).toContain('THB-1 (https://linear.app/t/issue/THB-1)')
    // Not even the word: a public PR flagged as a security fix points at the hole before the fix ships.
    for (const text of ['leaks', 'user b', 'b@thunderbolt', 'Only my chats', 'consumer-qa-', 'security']) {
      expect(published.join('\n').toLowerCase()).not.toContain(text.toLowerCase())
    }
  })

  test('a visual fix PR keeps the check the fix agent wrote as its regression test', async () => {
    await setup({ kind: 'visual' })
    const check = `import { layoutProblems } from '../../../.github/qa/layout'\n${spec}`
    await put(join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts'), check)
    await put(join(outDir, 'fix', `${fp}.verify.json`), JSON.stringify({ failsWithout: true, passesWith: true }))

    const { repoDir, runs, result } = await publishLive()

    expect(result).toMatchObject({ outcome: 'pr', spec: 'e2e/consumer-qa-ab12cd34.spec.ts' })
    expect(await readFile(join(repoDir, 'e2e', 'consumer-qa-ab12cd34.spec.ts'), 'utf8')).toBe(
      regressionSpec('c2-chat', fp, check).source,
    )
    expect(runs.at(-1)?.stdin).toContain('failed without this patch and passes with it')
  })

  test('a real-AI web visual fix is never published, even when its check passed on the fake AI', async () => {
    await setup({ kind: 'visual', real: true, charterDir: 'c4-skills-projects-desktop' })
    await put(join(outDir, `fix-${fp}`, 'repro', 'check.spec.ts'), spec)
    await put(join(outDir, 'fix', `${fp}.verify.json`), JSON.stringify({ failsWithout: true, passesWith: true }))
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

  test('refuses a live run without credentials, a ticket, or a routed fingerprint', async () => {
    await setup({ ticket: false })
    const opts = { outDir, fp, run: fakeRun([]), fetchFn: fakeLinear([]), log: () => {} }
    await expect(publish({ ...opts, live: true, key: 'lin' })).rejects.toThrow('GH_TOKEN')
    await expect(publish({ ...opts, live: true, key: 'lin', token: 't' })).rejects.toThrow('no Linear ticket')
    await expect(publish({ ...opts, fp: 'ffffffff', live: false })).rejects.toThrow('not in fix-plan.json')
  })
})
