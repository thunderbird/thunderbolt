/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The weekly workflow's trust boundaries, read from the YAML with its aliases resolved, and the two steps that decide
// whether a fix may become a PR, run as the workflow runs them.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  env?: Record<string, string>
  with?: Record<string, string>
}
type Job = { steps?: Step[]; uses?: string; 'timeout-minutes'?: number; permissions?: unknown; environment?: string }

const workflow = join(import.meta.dir, '../../workflows/qa-weekly.yml')
const { jobs } = Bun.YAML.parse(readFileSync(workflow, 'utf8')) as { jobs: Record<string, Job> }
const work = mkdtempSync(join(tmpdir(), 'qa-workflow-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const qaKey = 'secrets.QA_ANTHROPIC_API_KEY'
const steps = (job: string) => jobs[job].steps ?? []
const label = (step: Step) => step.name ?? step.uses ?? '?'
const step = (job: string, name: string) => {
  const found = steps(job).find((s) => s.name === name)
  if (!found) throw new Error(`${job} has no step ${name}`)
  return found
}
const indexOf = (job: string, name: string) => steps(job).findIndex((s) => s.name === name)
/** The steps of `job` whose text mentions `needle`, with the key it sits under. */
const mentions = (job: string, needle: string) =>
  steps(job).flatMap((s) =>
    Object.entries(s)
      .filter(([, value]) => JSON.stringify(value).includes(needle))
      .map(([key]) => `${label(s)}:${key}`),
  )

describe('secrets', () => {
  test('no run: text interpolates a secret', () => {
    const bad = Object.entries(jobs).flatMap(([name, job]) =>
      (job.steps ?? []).filter((s) => s.run?.includes('secrets.')).map((s) => `${name}/${label(s)}`),
    )
    expect(bad).toEqual([])
  })

  test('the jobs that build, check or calibrate native apps hold no secret and no environment', () => {
    for (const job of ['build-native', 'verify-native-build', 'verify-native-run', 'native-control']) {
      expect({ job, hits: JSON.stringify(jobs[job]).match(/secrets\./g) ?? [] }).toEqual({ job, hits: [] })
      expect(jobs[job].environment).toBeUndefined()
    }
  })

  test('replay-native has secrets only in the stack start, and only for the real leg', () => {
    expect(mentions('replay-native', 'secrets.')).toEqual(['Start the stack:env'])
    for (const value of Object.values(step('replay-native', 'Start the stack').env ?? {}).filter((v) =>
      v.includes('secrets.'),
    ))
      expect(value).toMatch(/^\$\{\{ matrix\.leg\.real && secrets\.\w+ \|\| '' \}\}$/)
  })

  test('explore-native has the QA key only in the env of the real stack, the canary, the session and the scan', () => {
    expect(mentions('explore-native', qaKey)).toEqual([
      'Start the stack:env',
      'Check that the gate denies a canary session:env',
      'Explore:env',
      'Check the session output for secrets:env',
    ])
    expect(step('explore-native', 'Start the stack').env?.ANTHROPIC_API_KEY).toBe(
      `\${{ matrix.leg.real && ${qaKey} || '' }}`,
    )
  })

  test('the fix job holds no provider key; verify-real holds them only to start its stack', () => {
    expect(JSON.stringify(jobs.fix)).not.toMatch(/QA_TINFOIL|QA_EXA/)
    expect(mentions('verify-real', 'secrets.')).toEqual(['Start the stack on the real providers:env'])
  })

  test('every scan clears the startup and preload variables and calls grep by absolute path', () => {
    const scans: [string, string][] = [
      ['explore-native', 'Check the session output for secrets'],
      ['fix', "Check the agent's output for the key"],
      ['fix', 'Check the fix output for secrets'],
    ]
    for (const [job, name] of scans) {
      const scan = step(job, name)
      expect(scan.shell).toBe('/bin/bash --noprofile --norc -e {0}')
      expect(scan.env).toMatchObject({ PATH: '/usr/bin:/bin', BASH_ENV: '', ENV: '', LD_PRELOAD: '' })
      expect(scan.run).toContain('/usr/bin/grep')
      expect(scan.run).not.toMatch(/(^|[\s;|{(])grep /)
    }
  })

  test("the fix job's key leaves with the scan right after the session, before any agent code runs outside it", () => {
    const fix = indexOf('fix', 'Fix')
    expect(steps('fix')[fix + 1].name).toBe("Check the agent's output for the key")
    expect(mentions('fix', 'secrets.').filter((m) => !m.startsWith('Fix:'))).toEqual([
      "Check the agent's output for the key:env",
    ])
    // node_modules too: the agent can write it and the real-AI build bundles it. Only .git, which it may not edit.
    const keyScan = step('fix', "Check the agent's output for the key").run ?? ''
    expect(keyScan).toContain('/usr/bin/grep -rqsF --exclude-dir=.git -- "$QA_KEY" .')
    expect(keyScan).not.toContain('node_modules')
    expect(step('fix', 'Fix').with?.claude_args).toContain('"Edit(.git/**)"')
    const uploads = steps('fix').filter((s) => s.uses?.startsWith('actions/upload-artifact'))
    for (const upload of uploads) expect(upload.if).toContain("steps.key-scan.outcome == 'success'")
  })
})

describe('native explore', () => {
  test('the canary and the session run from a read-only harness outside the checkout', () => {
    const harness = step('explore-native', 'Prepare the session harness outside the checkout')
    expect(harness.run).toContain('explore.sh harness "$QA_CHARTER" "$RUNNER_TEMP/qa-native-bin"')
    expect(harness.run).toContain('chmod -R a-w "$RUNNER_TEMP/qa-native-bin"')
    const canary = indexOf('explore-native', 'Check that the gate denies a canary session')
    expect(indexOf('explore-native', harness.name ?? '')).toBeLessThan(canary)
    for (const name of ['Check that the gate denies a canary session', 'Explore']) {
      const run = step('explore-native', name).run ?? ''
      expect(run).toContain('"$QA_HARNESS/explore.sh"')
      expect(run).not.toContain('.github/')
    }
  })

  test('no step that holds the key after the session runs repo code', () => {
    const after = steps('explore-native').slice(indexOf('explore-native', 'Explore') + 1)
    const keyed = after.filter((s) => JSON.stringify(s.env ?? {}).includes('secrets.'))
    expect(keyed.map(label)).toEqual(['Check the session output for secrets'])
    for (const s of keyed) expect(s.run ?? '').not.toMatch(/bun |\.github\/|explore\.sh/)
  })
})

describe('fix job', () => {
  test('the dev servers run as another user, checked, and the job user loses root before the agent', () => {
    const start = indexOf('fix', 'Start the stack on the working tree')
    expect(step('fix', 'Start the stack on the working tree').env?.QA_BACKEND_USER).toBe('qa-dev')
    expect(indexOf('fix', 'Install the subprocess sandbox')).toBeLessThan(start)
    const check = indexOf('fix', "Check that no dev server runs as the job's user")
    const lock = indexOf('fix', "Take root away from the job's user")
    expect(check).toBe(start + 1)
    expect(lock).toBe(check + 1)
    expect(lock).toBeLessThan(indexOf('fix', 'Fix'))
    expect(step('fix', "Check that no dev server runs as the job's user").run).toContain('ss -ltnpH')
    // After the lock, sudo is only the narrow rule that signals the dev servers' user.
    const sudo = steps('fix')
      .slice(lock + 1)
      .flatMap((s) => (s.run ?? '').split('\n').filter((line) => line.includes('sudo')))
    expect(sudo.map((line) => line.trim())).toEqual([
      'if pgrep -u "$user" > /dev/null; then sudo -n -u "$user" /usr/bin/kill -TERM -1; fi',
    ])
  })

  test("a stop of another user's servers fails loudly when they keep running", () => {
    const stop = step('fix', 'Stop the stack').run ?? ''
    expect(stop).toContain('echo "::error::The servers of $user did not stop."\n  exit 1')
    expect(stop).not.toMatch(/kill -TERM -1[^\n]*\|\| true/)
  })

  test('stack.sh lets the job user signal the dev user after the lock, and nothing more', async () => {
    const stack = await Bun.file(join(import.meta.dir, 'stack.sh')).text()
    // The exact command the stops run, so a spec cannot send another signal as that user.
    expect(stack).toContain("ALL=($QA_BACKEND_USER) NOPASSWD: /usr/bin/kill -TERM -1, /bin/kill -TERM -1'")
    expect(step('fix', 'Stop the stack').run).toContain('sudo -n -u "$user" /usr/bin/kill -TERM -1;')
    expect(stack).toContain('sudo -n -u "$user" /usr/bin/kill -TERM -1;')
    // sudoers reads the dir in order and the last matching rule wins, so the narrow rule sorts after zz-qa-lock.
    expect(stack).toContain('/etc/sudoers.d/zz-qa-lock-stop')
    expect(stack).toContain('/etc/sudoers.d/zz-qa-lock"')
  })

  test("the agent may not edit git, the pipeline, e2e or the tool configs", () => {
    const args = step('fix', 'Fix').with?.claude_args ?? ''
    for (const rule of ['.git/**', '.github/**', 'e2e/**', '**/vite.config.*', '**/tsconfig*.json', '**/.husky/**'])
      expect(args).toContain(`"Edit(${rule})"`)
  })

  // Runs the collect step's script in a scratch repo, with the outcomes the workflow would pass.
  const collect = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(work, 'collect-'))
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args])
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
    mkdirSync(join(dir, 'qa-out/c2/repro'), { recursive: true })
    writeFileSync(join(dir, 'qa-out/c2/repro/1.spec.ts'), 'spec')
    const proc = Bun.spawnSync(['bash', '-e', '-c', step('fix', 'Collect the patch').run ?? ''], {
      cwd: dir,
      env: { PATH: process.env.PATH, QA_FP: 'fp1', FIX_OUTCOME: 'success', ...env },
    })
    expect(proc.exitCode).toBe(0)
    const diagnosis = join(dir, 'qa-out/fix/fp1.diagnosis.md')
    return existsSync(diagnosis) ? readFileSync(diagnosis, 'utf8') : undefined
  }
  const spec = { SPEC: 'qa-out/c2/repro/1.spec.ts', NEEDS_REPLAY: 'true' }

  test('a check the task needs that did not succeed always leaves a diagnosis', () => {
    for (const outcome of ['failure', 'skipped', 'cancelled', ''])
      expect(collect({ ...spec, REPLAY: outcome })).toContain('The repro spec did not pass')
    expect(collect({ NEEDS_VISUAL: 'true', VISUAL: 'skipped' })).toContain('The visual check did not run')
    expect(collect({ NEEDS_REAL_BUILD: 'true', REAL_BUILD: 'failure' })).toContain('did not build')
    expect(collect({ ...spec, REPLAY: 'success', FIX_OUTCOME: 'failure' })).toContain('did not finish')
  })

  test('a task whose checks all succeeded, or that needs none here, gets no diagnosis', () => {
    expect(collect({ ...spec, REPLAY: 'success' })).toBeUndefined()
    expect(collect({ NEEDS_VISUAL: 'true', VISUAL: 'success' })).toBeUndefined()
    expect(collect({ REPLAY: 'skipped', VISUAL: 'skipped' })).toBeUndefined()
  })
})

describe('publish', () => {
  type Verdict = { passed?: boolean; failsWithout?: boolean; passesWith?: boolean }
  // Runs publish's verdict step on a qa-out holding the plan, the given verdicts and the fix job's diagnosis.
  const verdicts = (files: Record<string, Verdict>, env: Record<string, string> = {}, diagnosis?: string) => {
    const dir = mkdtempSync(join(work, 'publish-'))
    mkdirSync(join(dir, 'qa-out/verify'), { recursive: true })
    mkdirSync(join(dir, 'qa-out/fix'), { recursive: true })
    const verifyNative = ['ios', 'android'].map((platform) => ({ fp: 'fp1', platform }))
    writeFileSync(join(dir, 'qa-out/fix-plan.json'), JSON.stringify({ fixes: [], verifyNative }))
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, 'qa-out', path), JSON.stringify(content))
    if (diagnosis) writeFileSync(join(dir, 'qa-out/fix/fp1.diagnosis.md'), diagnosis)
    const proc = Bun.spawnSync(['bash', '-e', '-c', step('publish', 'Require the native and real-AI checks').run ?? ''], {
      cwd: dir,
      env: { PATH: process.env.PATH, QA_FP: 'fp1', ...env },
    })
    expect(proc.exitCode).toBe(0)
    const read = (path: string) =>
      existsSync(join(dir, 'qa-out', path)) ? readFileSync(join(dir, 'qa-out', path), 'utf8') : undefined
    return { diagnosis: read('fix/fp1.diagnosis.md'), verify: read('fix/fp1.verify.json') }
  }
  const passed = { passed: true, failsWithout: true, passesWith: true }

  test('needs passed: true from every native platform of the bug', () => {
    expect(verdicts({ 'verify/fp1.ios.json': passed, 'verify/fp1.android.json': passed }).diagnosis).toBeUndefined()
    const missing = verdicts({ 'verify/fp1.ios.json': passed })
    expect(missing.diagnosis).toContain('still fails on the native platform (android)')
    const failed = verdicts({ 'verify/fp1.ios.json': passed, 'verify/fp1.android.json': { passed: false } })
    expect(failed.diagnosis).toContain('(android)')
  })

  test("needs the real-AI verdict for a web real-AI task", () => {
    const both = { 'verify/fp1.ios.json': passed, 'verify/fp1.android.json': passed }
    expect(verdicts(both, { REAL: 'true' }).diagnosis).toContain('real AI providers')
    expect(verdicts({ ...both, 'verify/fp1.real.json': { passed: true } }, { REAL: 'true' }).diagnosis).toBeUndefined()
  })

  test("a native visual task's verify.json is the native verdict, never the agent's copy", () => {
    const forged = { 'fix/fp1.verify.json': { failsWithout: true, passesWith: true } }
    const both = { 'verify/fp1.ios.json': passed, 'verify/fp1.android.json': { ...passed, passesWith: false } }
    expect(JSON.parse(verdicts({ ...forged, ...both }, { NATIVE_VISUAL: 'android' }).verify ?? '{}').passesWith).toBe(
      false,
    )
    expect(verdicts({ ...forged, 'verify/fp1.ios.json': passed }, { NATIVE_VISUAL: 'android' }).verify).toBeUndefined()
  })

  test("leaves the fix job's own diagnosis alone", () => {
    expect(verdicts({}, {}, 'gave up\n').diagnosis).toBe('gave up\n')
  })
})

test('every job but the reusable notify call has a timeout and read-only permissions', () => {
  for (const [name, job] of Object.entries(jobs).filter(([, job]) => !job.uses)) {
    expect({ name, timeout: (job['timeout-minutes'] ?? 0) > 0 }).toEqual({ name, timeout: true })
    expect({ name, permissions: job.permissions }).toEqual({ name, permissions: { contents: 'read' } })
  }
})
