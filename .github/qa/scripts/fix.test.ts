/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Filed } from './file-findings'
import type { Area, RawFinding, Severity } from './findings'
import { checkPatch, type FixPlan, type FixTask, isDenied, publish, regressionSpec, route, type Run } from './fix'
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

  test('routes at most three fixable tickets, highest severity first, and lists the ones a person must fix', async () => {
    await setup()
    const runs: RunCall[] = []
    const plan = await route({ outDir, live: false, run: fakeRun(runs, branches), log: () => {} })

    expect(plan.fixes.map((t) => t.fp)).toEqual([fp('urgent-settings'), fp('high-skills'), fp('medium-widgets')])
    expect(plan.humanRequired).toEqual([
      {
        fp: fp('high-sync'),
        severity: 'High',
        issueId: 'issue-high-sync',
        identifier: 'THB-high-sync',
        url: 'https://linear.app/high-sync',
        area: 'sync',
      },
    ])
    expect(JSON.parse(await readFile(join(outDir, 'fix-plan.json'), 'utf8'))).toEqual(plan)
    expect(runs.map((r) => r.cmd)).toEqual([['git', 'ls-remote', '--heads', 'origin', 'qa-fix/*']])
  })

  test('gives the fix agent the sanitized ticket fields and a runnable spec path, nothing else', async () => {
    await setup()
    const plan = await route({ outDir, live: false, run: fakeRun([], branches), log: () => {} })
    const [first] = plan.fixes
    expect(first.spec).toBe(join(outDir, 'c2-chat', 'repro', 'urgent-settings.spec.ts'))
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

  test('labels only the human-required tickets when live, and never in a dry run', async () => {
    await setup()
    const dry: Call[] = []
    await route({ outDir, live: false, key: 'k', run: fakeRun([], branches), fetchFn: fakeLinear(dry), log: () => {} })
    expect(dry).toEqual([])

    const calls: Call[] = []
    await route({ outDir, live: true, key: 'k', run: fakeRun([], branches), fetchFn: fakeLinear(calls), log: () => {} })
    expect(calls.map((c) => c.op)).toEqual(['Label', 'AddLabel'])
    expect(calls[1].variables).toEqual({ id: 'issue-high-sync', labelId: 'label-hr' })
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
    const calls: Call[] = []

    const plan = await route({
      outDir,
      live: true,
      key: 'k',
      run: fakeRun([], {}),
      fetchFn: fakeLinear(calls),
      log: () => {},
    })

    expect(plan).toEqual({ fixes: [], humanRequired: [] })
    expect(calls).toEqual([])
  })

  test('a real-AI finding goes to a person even in a fixable area: the fix check runs on the fake AI', async () => {
    const charterDir = 'c5-widgets-connections'
    const filed: Filed[] = [{ fp: 'fp-real', charterDir, id: '1', severity: 'High', action: 'created' }]
    const confirmed: VerifiedFinding[] = [
      { charterDir, id: '1', finding: finding('chat'), replay: { failed: 2, runs: 3 }, artifacts: {} },
    ]
    const verified: Verified = { confirmed, flaky: [], observations: [], dropped: [] }
    await put(join(outDir, 'filed.json'), JSON.stringify(filed))
    await put(join(outDir, 'verified.json'), JSON.stringify(verified))
    await put(join(outDir, charterDir, 'repro', '1.spec.ts'), spec)

    const plan = await route({ outDir, live: false, run: fakeRun([]), log: () => {} })

    expect(plan.fixes).toEqual([])
    expect(plan.humanRequired.map((t) => [t.fp, t.area])).toEqual([['fp-real', 'chat']])
  })

  test('refuses a live run without a Linear key', async () => {
    await setup()
    await expect(route({ outDir, live: true, run: fakeRun([], branches), log: () => {} })).rejects.toThrow(
      'LINEAR_API_KEY',
    )
  })
})

describe('isDenied', () => {
  test.each([
    'shared/powersync-tables.ts',
    'powersync-service/config/config.yaml',
    'backend/drizzle/0042_x.sql',
    'src/drizzle/meta/_journal.json',
    'src/db/schema.ts',
    'backend/src/db/schema.ts',
    'backend/src/auth/auth.ts',
    'src/contexts/auth-context.tsx',
    'src/lib/mcp-auth/index.ts',
    'src/crypto/keys.ts',
    'src/services/encryption.ts',
    'src/hooks/use-powersync-status.ts',
    'src/lib/oauth-state.ts',
    'src/lib/oauth-redirect.ts',
    'src/lib/sso-loopback.ts',
    'backend/src/dal/sessions.ts',
    'src/components/approve-device-dialog.tsx',
    'src/components/sign-in/sign-in-form.tsx',
    'backend/src/dal/otp-challenge.ts',
    'src/components/sync-setup/recovery-key-entry-step.tsx',
    'src/dal/mcp-secrets.ts',
    'deploy/k8s/values.yaml',
    'src-tauri/src/main.rs',
    '.github/workflows/ci.yml',
    '.husky/pre-commit',
    '.lintstagedrc.json',
    'Makefile',
    'eslint.config.js',
    'scripts/license-headers.ts',
    'package.json',
    'backend/package.json',
    'bun.lock',
    '.github/qa/fix.md',
    '.github/qa/scripts/fix.ts',
    'e2e/helpers.ts',
    '.github/qa/playwright.config.ts',
  ])('denies %s', (path) => {
    expect(isDenied(path)).toBe(true)
  })

  test.each([
    'src/chats/chat-title.tsx',
    'src/components/chat/message-bubbles.tsx',
    'shared/url.ts',
    'backend/src/api/chat.ts',
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
  const task = (): FixTask => ({
    fp,
    severity: 'High',
    charterDir: 'c2-chat',
    spec: join(outDir, 'c2-chat', 'repro', '1.spec.ts'),
    finding: { ...finding('chat'), oracle: { type: 'page-error', evidence: 'x' } },
  })

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
    await git(['git', 'init', '--quiet'])
    await git(['git', 'add', '-A'])
    await git(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init'])
    await put(task().spec, spec)
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec)
  })

  test('accepts a patch that only fixes app code, without touching the checkout', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n'))
    expect(await checkPatch(git, outDir, task())).toEqual({ reasons: [], files: ['src/chat.ts'] })
    expect(await git(['git', 'status', '--porcelain'])).toBe('')
  })

  test('rejects an empty patch', async () => {
    await put(join(outDir, 'fix', `${fp}.patch`), '\n')
    expect(await checkPatch(git, outDir, task())).toEqual({ reasons: ['empty patch'], files: [] })
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
    const { reasons, files } = await checkPatch(git, outDir, task())
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
    expect((await checkPatch(git, outDir, task())).reasons).toEqual([
      'adds or changes a symlink or submodule: src/alias.ts',
    ])
  })

  test('rejects a patch that matches a secret pattern', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), "export const token = 'ghs_abc123'\n"))
    expect((await checkPatch(git, outDir, task())).reasons).toEqual(['the patch matches a secret pattern'])
  })

  test('rejects a denied path, including a file renamed out of one', async () => {
    await patchFrom(async () => {
      await writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n')
      await git(['git', 'mv', 'shared/powersync-tables.ts', 'src/tables.ts'])
    })
    const { reasons, files } = await checkPatch(git, outDir, task())
    expect(files.sort()).toEqual(['shared/powersync-tables.ts', 'src/chat.ts', 'src/tables.ts'])
    expect(reasons).toEqual(['touches shared/powersync-tables.ts'])
  })

  test('rejects an edited repro spec and a spec that fails the lint', async () => {
    await patchFrom(() => writeFile(join(repo, 'src', 'chat.ts'), 'export const title = 2\n'))
    await put(join(outDir, 'fix', `${fp}.spec.ts`), spec.replace('Renamed', 'Anything'))
    expect((await checkPatch(git, outDir, task())).reasons).toEqual(['the repro spec was edited'])

    await put(task().spec, `${spec}process.exit(0)\n`)
    const { reasons } = await checkPatch(git, outDir, task())
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

  const setup = async (ticket = true) => {
    const task: FixTask = {
      fp,
      severity: 'High',
      charterDir: 'c2-chat',
      spec: specPath(),
      finding: {
        title: 'Renaming a chat\nloses its title',
        area: 'chat',
        viewport: 'desktop',
        oracle: { type: 'assert-failed', evidence: 'expected Renamed' },
        steps: ['Rename a chat'],
        expected: 'Renamed',
        actual: 'Untitled',
      },
    }
    const withTicket = { ...task, issueId: 'issue-1', identifier: 'THB-1', url: 'https://linear.app/t/THB-1' }
    const plan: FixPlan = { fixes: [ticket ? withTicket : task], humanRequired: [] }
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
    expect(lines.join('\n')).toContain('would comment on THB-1 and label it "human required"')
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
    await setup(false)
    const opts = { outDir, fp, run: fakeRun([]), fetchFn: fakeLinear([]), log: () => {} }
    await expect(publish({ ...opts, live: true, key: 'lin' })).rejects.toThrow('GH_TOKEN')
    await expect(publish({ ...opts, live: true, key: 'lin', token: 't' })).rejects.toThrow('no Linear ticket')
    await expect(publish({ ...opts, fp: 'ffffffff', live: false })).rejects.toThrow('not in fix-plan.json')
  })
})
