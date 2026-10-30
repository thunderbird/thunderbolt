/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The workflow's trust boundaries, read from the resolved YAML, and the steps that gate a fix PR.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nativeDriverStartupMinutes,
  nativeJobMinutes,
  nativeReplayCap,
  nativeRunEstimateMinutes,
  nativeSetupEstimateMinutes,
  nativeWrapUpMinutes,
} from './verify'

type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  'working-directory'?: string
  env?: Record<string, string>
  with?: Record<string, string>
}
type Job = {
  steps?: Step[]
  uses?: string
  'timeout-minutes'?: number
  if?: string
  needs?: string | string[]
  permissions?: unknown
  environment?: string
  env?: Record<string, string>
}

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

test('filed.json is uploaded even when filing fails, so the report lists the tickets that reached Linear', () => {
  const upload = steps('file').find((s) => s.with?.name === 'qa-filed')
  expect(upload?.if).toBe('always()')
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

  test("the fix job's listener check names the default ports", () => {
    // The one literal copy of the defaults: CI runs on them, and this fails when they change without the check.
    const ports = JSON.parse(readFileSync(join(import.meta.dir, '../ports.json'), 'utf8')) as Record<string, number>
    const check = step('fix', "Check that no dev server runs as the job's user").run ?? ''
    for (const name of ['QA_BACKEND_PORT', 'QA_FRONTEND_PORT', 'QA_ONBOARDING_PORT'])
      expect(check).toContain(`sport = :${ports[name]}`)
  })

  test('the agent may not edit git, the pipeline, e2e or the tool configs', () => {
    const args = step('fix', 'Fix').with?.claude_args ?? ''
    for (const rule of ['.git/**', '.github/**', 'e2e/**', '**/vite.config.*', '**/tsconfig*.json', '**/.husky/**'])
      expect(args).toContain(`"Edit(${rule})"`)
  })

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

  test('the visual check runs on the patched tree first, and the steps after the baseline see the patch', () => {
    const at = (name: string) => indexOf('fix', name)
    expect(at('Run the visual check on the patched tree')).toBeLessThan(at('Stop the stack'))
    expect(at('Stop the stack')).toBeLessThan(at('Run the visual check without the patch'))
    expect(at('Run the visual check without the patch')).toBeLessThan(
      at('Build the patched frontend for the real-AI check'),
    )
    expect(at('Build the patched frontend for the real-AI check')).toBeLessThan(at('Collect the patch'))
  })

  // The check always fails, as it should without the patch.
  const baseline = ({ edits = true, failStart = false, stashed = false } = {}) => {
    const dir = mkdtempSync(join(work, 'baseline-'))
    const bin = mkdtempSync(join(work, 'bin-'))
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, ...args]).stdout.toString()
    git('init', '-q')
    mkdirSync(join(dir, 'backend'))
    mkdirSync(join(dir, '.github/qa/scripts'), { recursive: true })
    writeFileSync(join(dir, '.gitignore'), 'qa-out*/\nqa-dist*/\n')
    writeFileSync(join(dir, 'backend/index.ts'), 'base')
    const stack = `if [ "$1" = start ]; then mkdir -p qa-out; cat backend/index.ts > qa-out/served; ls backend > qa-out/files; exit ${failStart ? 1 : 0}; fi\n`
    writeFileSync(join(dir, '.github/qa/scripts/stack.sh'), stack, { mode: 0o755 })
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    if (stashed) {
      writeFileSync(join(dir, 'backend/index.ts'), 'older')
      git('stash', 'push', '--quiet')
    }
    if (edits) {
      writeFileSync(join(dir, 'backend/index.ts'), 'patched')
      writeFileSync(join(dir, 'backend/new.ts'), 'new')
    }
    writeFileSync(join(bin, 'bunx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const proc = Bun.spawnSync(['bash', '-e', '-c', step('fix', 'Run the visual check without the patch').run ?? ''], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, QA_FP: 'fp1', WITH: '3', HOME: dir },
    })
    const read = (path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : undefined)
    return { code: proc.exitCode, read, stashes: git('stash', 'list').trim().split('\n').filter(Boolean).length }
  }

  test('the baseline serves the backend without the patch, then puts the patch back', () => {
    const { code, read, stashes } = baseline()
    expect(code).toBe(0)
    expect(read('qa-out/served')).toBe('base')
    // The untracked file the patch adds is out of the tree during the baseline too.
    expect(read('qa-out/files')).toBe('index.ts\n')
    expect(read('backend/index.ts')).toBe('patched')
    expect(read('backend/new.ts')).toBe('new')
    expect(stashes).toBe(0)
    expect(JSON.parse(read('qa-out/fix/fp1.verify.json') ?? '{}')).toEqual({ failsWithout: true, passesWith: true })
  })

  test('a failed baseline still puts the patch back, and an agent that edited nothing pops no older stash', () => {
    const failed = baseline({ failStart: true })
    expect(failed.code).not.toBe(0)
    expect(failed.read('backend/index.ts')).toBe('patched')
    expect(failed.read('backend/new.ts')).toBe('new')
    const untouched = baseline({ edits: false, stashed: true })
    expect(untouched.code).toBe(0)
    expect(untouched.read('backend/index.ts')).toBe('base')
    expect(untouched.stashes).toBe(1)
  })
})

describe('publish', () => {
  type Verdict = { passed?: boolean; failsWithout?: boolean; passesWith?: boolean }
  const verdicts = (files: Record<string, Verdict>, env: Record<string, string> = {}, diagnosis?: string) => {
    const dir = mkdtempSync(join(work, 'publish-'))
    mkdirSync(join(dir, 'qa-out/verify'), { recursive: true })
    mkdirSync(join(dir, 'qa-out/fix'), { recursive: true })
    const verifyNative = ['ios', 'android'].map((platform) => ({ fp: 'fp1', platform }))
    writeFileSync(join(dir, 'qa-out/fix-plan.json'), JSON.stringify({ fixes: [], verifyNative }))
    for (const [path, content] of Object.entries(files))
      writeFileSync(join(dir, 'qa-out', path), JSON.stringify(content))
    if (diagnosis) writeFileSync(join(dir, 'qa-out/fix/fp1.diagnosis.md'), diagnosis)
    const proc = Bun.spawnSync(
      ['bash', '-e', '-c', step('publish', 'Require the native and real-AI checks').run ?? ''],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, QA_FP: 'fp1', ...env },
      },
    )
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

  test('needs the real-AI verdict for a web real-AI task', () => {
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

test("a native replay leg's base runs fit its timeout, since a timeout loses every finding of the leg", () => {
  // The control's 3 runs and every finding's 3. Extra runs are left out: one starts only while the base runs of
  // every later finding still fit the clock.
  const runs = 3 + nativeReplayCap * 3
  const minutes =
    runs * nativeRunEstimateMinutes + nativeSetupEstimateMinutes + nativeWrapUpMinutes + nativeDriverStartupMinutes
  expect(minutes).toBeLessThan(nativeJobMinutes)
  // verify.ts stops starting runs by this number, so it must be the job's own.
  expect(jobs['replay-native']['timeout-minutes']).toBe(nativeJobMinutes)
  // ...counted from the job's first step, so the setup before the replay step is on the clock.
  expect(steps('replay-native')[0].run).toBe('echo "QA_LEG_START=$(date +%s)" >> "$GITHUB_ENV"')
})

describe('native jobs', () => {
  const maestroJobs = Object.entries(jobs).filter(([, job]) => JSON.stringify(job).includes('MAESTRO_DRIVER_STARTUP'))

  test("every job that runs Maestro turns off its AI banner, which fills a failed run's error", () => {
    expect(maestroJobs.map(([name]) => name).sort()).toEqual([
      'explore-native',
      'native-control',
      'replay-native',
      'verify-native-run',
    ])
    for (const [name, job] of maestroJobs) {
      const value = job.env?.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED
      expect({ name, value }).toEqual({ name, value: 'true' })
    }
  })

  test('the Gradle daemons stop after an Android build and before the emulator boots in the same job', () => {
    const builds = Object.entries(jobs).filter(
      ([name]) => indexOf(name, 'Boot the device') >= 0 && steps(name).some((s) => s.run?.includes('native.sh build')),
    )
    expect(builds.map(([name]) => name)).toEqual(['native-control'])
    const stop = step('native-control', 'Stop the Gradle daemons')
    expect(stop).toMatchObject({
      if: "matrix.target.platform == 'android'",
      'working-directory': 'src-tauri/gen/android',
    })
    expect(stop.run).toBe('./gradlew --stop')
    const at = indexOf('native-control', 'Stop the Gradle daemons')
    expect(at).toBeGreaterThan(indexOf('native-control', 'Build the control app'))
    expect(at).toBeLessThan(indexOf('native-control', 'Boot the device'))
  })

  test('a failed control uploads its logs, an Android replay always does, never a leg whose backend held keys', () => {
    const control = step('native-control', 'Upload the stack log')
    expect(control.if).toBe('failure()')
    expect(control.with?.path).toBe('${{ runner.temp }}/qa-stack.log')
    // The control's own folder, uploaded always, already holds its WebView log.
    expect(steps('native-control').find((s) => s.with?.path === '${{ runner.temp }}/qa-control/')?.if).toBe('always()')
    const upload = 'Upload the stack, device and Maestro logs'
    const save = "Save the emulator's, adb's and Maestro's logs"
    const replayLogs = step('replay-native', upload)
    // On Android also after a replay that passed, to show whether the console stream lasted the leg.
    expect(replayLogs.if).toBe("(failure() || matrix.leg.platform == 'android') && !matrix.leg.real")
    expect(step('replay-native', save).if).toBe("always() && matrix.leg.platform == 'android' && !matrix.leg.real")
    expect(replayLogs.with?.path?.split('\n').filter(Boolean)).toEqual([
      '${{ runner.temp }}/qa-stack.log',
      '${{ runner.temp }}/qa-webview.log',
      '${{ runner.temp }}/qa-logcat.log',
      '${{ runner.temp }}/qa-adb.log',
      '${{ runner.temp }}/qa-maestro/',
    ])
    expect(indexOf('replay-native', save)).toBeGreaterThan(indexOf('replay-native', 'Replay the repro flows and specs'))
    expect(indexOf('replay-native', upload)).toBeGreaterThan(indexOf('replay-native', save))
  })

  test("Android's replay starts Maestro's driver once, before the console stream that a reset there would end", () => {
    const warmUp = "Start Maestro's driver on the emulator"
    expect(step('replay-native', warmUp).if).toBe("matrix.leg.platform == 'android'")
    expect(indexOf('replay-native', warmUp)).toBeGreaterThan(indexOf('replay-native', 'Boot the device'))
    expect(indexOf('replay-native', warmUp)).toBeLessThan(indexOf('replay-native', 'Stream the WebView console'))
  })

  test("iOS's console stream starts right after the boot, before the app installs and the stack starts", () => {
    const early = 'Stream the WebView console on iOS'
    for (const job of ['explore-native', 'replay-native']) {
      expect(step(job, early).if).toBe("matrix.leg.platform == 'ios'")
      expect(indexOf(job, early)).toBe(indexOf(job, 'Boot the device') + 1)
      expect(indexOf(job, early)).toBeLessThan(indexOf(job, 'Start the stack'))
    }
    expect(indexOf('explore-native', early)).toBeLessThan(indexOf('explore-native', 'Install the app'))
    // The wait comes after the install and the stack start, before the first step that reads the log.
    const wait = 'Wait for the console stream'
    for (const [job, first] of [
      ['explore-native', 'Check that the gate denies a canary session'],
      ['replay-native', 'Replay the repro flows and specs'],
    ]) {
      expect(step(job, wait).if).toBe("matrix.leg.platform == 'ios'")
      expect(step(job, wait).run).toBe('.github/qa/scripts/native.sh wait-logs "$QA_DEVICE_ID" "$QA_WEBVIEW_LOG"')
      expect(indexOf(job, wait)).toBeGreaterThan(indexOf(job, 'Start the stack'))
      expect(indexOf(job, wait)).toBeLessThan(indexOf(job, first))
    }
    expect(indexOf('explore-native', 'Wait for the console stream')).toBeGreaterThan(
      indexOf('explore-native', 'Install the app'),
    )
    // Android's stream stays after the install, whose launches would otherwise fill the log.
    const late = step('explore-native', 'Stream the WebView console')
    expect(late.if).toBe("matrix.leg.platform == 'android'")
    expect(indexOf('explore-native', 'Stream the WebView console')).toBeGreaterThan(
      indexOf('explore-native', 'Install the app'),
    )
  })

  test('the checkout check runs only after its checksums were recorded, so one failure shows once', () => {
    for (const job of ['explore', 'explore-native']) {
      expect(step(job, 'Record the checksums of the tracked files').id).toBe('tracked')
      expect(step(job, 'Check that the checkout is unchanged').if).toBe(
        "always() && steps.tracked.outcome == 'success'",
      )
    }
  })
})

describe('caches', () => {
  const cacheSteps = (job: string, action: RegExp) =>
    steps(job)
      .filter((s) => action.test(s.uses ?? ''))
      .map((s) => JSON.stringify({ path: s.with?.path, key: s.with?.key }))
  const saving = /^actions\/cache(\/save)?@/

  test('only build and cache-system-image save caches, and every cache another job restores is one of theirs', () => {
    const savers = ['build', 'cache-system-image']
    expect(Object.keys(jobs).filter((job) => cacheSteps(job, saving).length > 0)).toEqual(savers)
    const saved = savers.flatMap((job) => cacheSteps(job, saving))
    for (const job of Object.keys(jobs))
      for (const restored of cacheSteps(job, /^actions\/cache\/restore@/))
        expect({ job, restored, saved: saved.includes(restored) }).toEqual({ job, restored, saved: true })
  })

  test("setup-bun's own cache is off, since its post step would save after the job's steps", () => {
    const setups = Object.entries(jobs).flatMap(([job, { steps = [] }]) =>
      steps
        .filter((s) => s.uses?.startsWith('oven-sh/setup-bun@'))
        .map((s) => ({ job, noCache: s.with?.['no-cache'] })),
    )
    expect(setups.length).toBeGreaterThan(0)
    for (const { job, noCache } of setups) expect({ job, noCache: String(noCache) }).toEqual({ job, noCache: 'true' })
  })

  test('cache-system-image caches the image native.sh installs, before untrusted code, and device jobs restore it', async () => {
    const fill = 'cache-system-image'
    const native = await Bun.file(join(import.meta.dir, 'native.sh')).text()
    const image = native.match(/^android_image="(system-images;[^"$]+);\$android_abi"$/m)?.[1] ?? '?'
    // CI's runners are x86_64.
    expect(step(fill, 'Look up the Android system image').with?.path).toEndWith(`/${image.replaceAll(';', '/')}/x86_64`)
    expect(jobs[fill].needs).toBe('build')
    expect(jobs[fill].if).toBe("contains(needs.build.outputs.nativeBuilds, 'android')")
    // The first Android job to restore waits for the save; the later ones wait on it.
    expect(jobs['explore-native'].needs).toContain(fill)
    const download = step(fill, 'Download the Android system image')
    expect(download.run).toBe('.github/qa/scripts/native.sh system-image')
    expect(download.if).toBe("steps.system-image.outputs.cache-hit != 'true'")
    // A failed install can leave half an image, which would then reach every Android job.
    expect(step(fill, 'Save the Android system image').if).toBe("steps.system-image-install.outcome == 'success'")
    const deviceJobs = Object.keys(jobs).filter((job) => indexOf(job, 'Install Maestro and the device') >= 0)
    expect(deviceJobs.length).toBeGreaterThan(0)
    for (const job of deviceJobs) {
      expect(step(job, 'Install Maestro and the device').run).toContain('.github/qa/scripts/native.sh system-image')
      const restore = indexOf(job, 'Restore the Android system image')
      expect(restore).toBe(indexOf(job, 'Install Maestro and the device') - 1)
      expect(steps(job)[restore].if).toBe("env.QA_PLATFORM == 'android' && env.QA_NO_DEVICE != 'true'")
    }
  })

  test("the MCP's Chromium installs before the repo's, whose install would delete it otherwise", () => {
    const [first, second] = (step('build', 'Install browsers').run ?? '').trim().split('\n')
    expect(first).toStartWith('npx --yes --package @playwright/mcp@')
    expect(second).toBe('bunx playwright install chromium')
  })
})

test('every job but the reusable notify call has a timeout and read-only permissions', () => {
  for (const [name, job] of Object.entries(jobs).filter(([, job]) => !job.uses)) {
    expect({ name, timeout: (job['timeout-minutes'] ?? 0) > 0 }).toEqual({ name, timeout: true })
    // app-check gets its token from the app, so it asks the runner for no permissions at all (see the next test).
    if (name === 'app-check') continue
    expect({ name, permissions: job.permissions }).toEqual({ name, permissions: { contents: 'read' } })
  }
})

describe('the GitHub App token', () => {
  test('publish and app-check mint the same narrowed token, and nothing else', () => {
    const mint = (job: string) => step(job, 'Create the GitHub App token')
    expect(mint('publish').with).toEqual({
      'client-id': '${{ secrets.QA_APP_CLIENT_ID }}',
      'private-key': '${{ secrets.QA_APP_PRIVATE_KEY }}',
      repositories: 'thunderbolt',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    })
    expect(mint('app-check')).toEqual({ ...mint('publish'), if: undefined })
  })

  test('app-check runs by hand only and holds the two app secrets and nothing else', () => {
    expect(jobs['app-check'].if).toBe("github.event_name == 'workflow_dispatch' && inputs.app_check")
    expect(jobs['app-check'].permissions).toEqual({})
    expect(jobs['app-check'].environment).toBe('qa-agent')
    expect(JSON.stringify(jobs['app-check']).match(/secrets\.\w+/g)).toEqual([
      'secrets.QA_APP_CLIENT_ID',
      'secrets.QA_APP_PRIVATE_KEY',
    ])
  })

  test('a check run skips every other job: each one depends on build, or checks the input itself', () => {
    const dependsOnBuild = (name: string): boolean =>
      [jobs[name].needs ?? []].flat().some((need) => need === 'build' || dependsOnBuild(need))
    const loose = Object.keys(jobs).filter((name) => name !== 'build' && !dependsOnBuild(name))
    expect(loose.sort()).toEqual(['app-check', 'native-control'])
    for (const name of ['build', 'native-control']) expect(jobs[name].if).toContain('!inputs.app_check')
  })
})
