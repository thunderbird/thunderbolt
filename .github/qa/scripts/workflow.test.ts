/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The workflow's trust boundaries, read from the resolved YAML, and the steps that gate a fix PR.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import platforms from '../platforms.json'
import { reviewNotice } from './fix'
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
  'continue-on-error'?: boolean
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
  with?: Record<string, string>
  'runs-on'?: string
  strategy?: unknown
}

const workflow = join(import.meta.dir, '../../workflows/qa-weekly.yml')
const ciWorkflow = join(import.meta.dir, '../../workflows/ci.yml')
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

describe('runner images', () => {
  const linuxImage = 'ubuntu-24.04'
  /**
   * Every runner label a job can pick: a plain `runs-on`, the results of an `a && 'x' || 'y'` expression (not the
   * literals it compares), and matrix `runner` fields.
   */
  const runnerLabels = (job: Job) => {
    const runsOn = job['runs-on'] ?? ''
    const fromRunsOn = runsOn.includes('${{')
      ? [...runsOn.matchAll(/(?:&&|\|\|)\s*'([^']+)'/g)].map((m) => m[1])
      : [runsOn]
    const fromMatrix = [...JSON.stringify(job.strategy ?? {}).matchAll(/"runner":"([^"]+)"/g)].map((m) => m[1])
    return [...fromRunsOn, ...fromMatrix].filter(Boolean)
  }

  test('every Linux job of the QA workflow runs on the image the stack was built for', () => {
    const picks = Object.entries(jobs).flatMap(([job, spec]) => runnerLabels(spec).map((runner) => ({ job, runner })))
    // The extraction must see the expression and matrix forms, or the check below passes on nothing.
    expect(picks).toContainEqual({ job: 'verify-native-run', runner: linuxImage })
    expect(picks).toContainEqual({ job: 'native-control', runner: linuxImage })
    expect(picks.filter(({ runner }) => runner !== 'macos-latest' && runner !== linuxImage)).toEqual([])
  })

  test("CI's qa job runs on the same image, since it starts the same dev stack", () => {
    const { jobs: ciJobs } = Bun.YAML.parse(readFileSync(ciWorkflow, 'utf8')) as { jobs: Record<string, Job> }
    expect(runnerLabels(ciJobs.qa)).toEqual([linuxImage])
  })

  test('every Linux runner in platforms.json is that image', () => {
    const runners = platforms.map((p) => p.runner)
    expect(runners).toContain(linuxImage)
    expect(runners.filter((runner) => runner !== 'macos-latest' && runner !== linuxImage)).toEqual([])
  })
})

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

  test('explore-native has the QA key only in the env of the real stack, the session and the scan, never the canary', () => {
    expect(mentions('explore-native', qaKey)).toEqual([
      'Start the stack:env',
      'Explore:env',
      'Check the session output for secrets:env',
    ])
    // The canary calls the hook and the gate itself, so it has nothing to spend a key on.
    expect(step('explore-native', 'Check that the gate denies the forbidden calls').env).toBeUndefined()
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
    const canary = indexOf('explore-native', 'Check that the gate denies the forbidden calls')
    expect(indexOf('explore-native', harness.name ?? '')).toBeLessThan(canary)
    for (const name of ['Check that the gate denies the forbidden calls', 'Explore']) {
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

test("route gets the Linear key for each ticket's branch and state, and a token that lists the open PRs", () => {
  expect(step('file', 'Route fixable tickets').env).toEqual({
    LINEAR_API_KEY: '${{ secrets.LINEAR_API_KEY }}',
    GH_TOKEN: '${{ github.token }}',
  })
})

describe('preview-deploy', () => {
  const previewWorkflow = join(import.meta.dir, '../../workflows/preview-deploy.yml')
  const preview = Bun.YAML.parse(readFileSync(previewWorkflow, 'utf8')) as { jobs: Record<string, Job> }
  const resolve = preview.jobs.resolve.steps?.find((s) => s.id === 'r')
  const proceeds = (headRef: string, body: string) => {
    const output = join(mkdtempSync(join(work, 'preview-')), 'output')
    const env = {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: output,
      EVENT_NAME: 'pull_request',
      EVENT_PR_NUMBER: '9',
      EVENT_HEAD_SHA: 'abc',
      EVENT_HEAD_REPO: 'o/r',
      EVENT_BASE_REPO: 'o/r',
      EVENT_HEAD_REF: headRef,
      EVENT_PR_BODY: body,
      QA_FIX_NOTICE: resolve?.env?.QA_FIX_NOTICE ?? '',
    }
    expect(Bun.spawnSync(['bash', '-c', resolve?.run ?? ''], { env }).exitCode).toBe(0)
    return /^proceed=(\w+)$/m.exec(readFileSync(output, 'utf8'))?.[1]
  }

  test("matches the fix PR's sentence exactly, and reads the description only through the environment", () => {
    expect(resolve?.env?.QA_FIX_NOTICE).toBe(reviewNotice)
    expect(resolve?.env?.EVENT_PR_BODY).toBe('${{ github.event.pull_request.body }}')
    expect(resolve?.run).not.toContain('${{')
  })

  test('deploys no automatic preview for a QA fix PR, on its Linear branch or on qa-fix/*', () => {
    const body = `Draft fix by the weekly QA agent.\n\n${reviewNotice}`
    expect(proceeds('jane/thb-42-code-entry', body)).toBe('false')
    expect(proceeds('qa-fix/thb-42', '')).toBe('false')
    expect(proceeds('jane/thb-42-code-entry', 'Fixes the code entry label.')).toBe('true')
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
    expect(collect({ NEEDS_VISUAL: 'true', VISUAL: 'skipped' })).toContain('The visual check did not pass')
    expect(collect({ NEEDS_REAL_BUILD: 'true', REAL_BUILD: 'failure' })).toContain('did not build')
    expect(collect({ ...spec, REPLAY: 'success', FIX_OUTCOME: 'failure' })).toContain('did not finish')
  })

  test('a fix step that never started still leaves a diagnosis, which only the fix status overrides', () => {
    expect(collect({ ...spec, FIX_OUTCOME: 'skipped', REPLAY: 'skipped' })).toContain('step outcome: skipped')
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

  // By default the check always fails, as it should without the patch.
  const baseline = ({ edits = true, failStart = false, stashed = false, checkPasses = false } = {}) => {
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
    writeFileSync(join(bin, 'bunx'), `#!/bin/sh\nexit ${checkPasses ? 0 : 1}\n`, { mode: 0o755 })
    const proc = Bun.spawnSync(['bash', '-e', '-c', step('fix', 'Run the visual check without the patch').run ?? ''], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, QA_FP: 'fp1', HOME: dir },
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
  })

  test('the baseline succeeds only when the check fails every time without the patch, which its pass rests on', () => {
    const passedWithout = baseline({ checkPasses: true })
    expect(passedWithout.code).not.toBe(0)
    expect(passedWithout.read('backend/index.ts')).toBe('patched')
    const withRun = step('fix', 'Run the visual check on the patched tree')
    expect(withRun.run).toContain('--repeat-each=3 --retries=0')
    for (const check of [withRun, step('fix', 'Run the visual check without the patch')])
      expect(check['continue-on-error']).toBe(true)
    expect(step('fix', 'Run the visual check without the patch').if).toBe("steps.visual-with.outcome == 'success'")
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

describe("CI's check of the fix job's dev stack", () => {
  const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, Job & { steps: Step[] }>
  }
  const check = ci.jobs.qa.steps.find((s) => s.name === 'Start the dev stack as another user')
  const ports = JSON.parse(readFileSync(join(import.meta.dir, '../ports.json'), 'utf8')) as Record<string, number>

  const runCheck = (log: string, fail: { screenshot?: boolean; stop?: boolean } = {}) => {
    const dir = mkdtempSync(join(work, 'dev-check-'))
    mkdirSync(join(dir, '.github/qa/scripts'), { recursive: true })
    const stack = `echo "stack $*" >> "$RUNNER_TEMP/calls"\n[ "$1" = start ] && cat "$RUNNER_TEMP/log" > "$RUNNER_TEMP/qa-stack.log"\n[ "$1" = stop ] && [ -n "$FAIL_STOP" ] && exit 1\nexit 0\n`
    writeFileSync(join(dir, '.github/qa/scripts/stack.sh'), stack, { mode: 0o755 })
    writeFileSync(
      join(dir, 'bunx'),
      '#!/bin/sh\necho "bunx $*" >> "$RUNNER_TEMP/calls"\n[ -n "$FAIL_BUNX" ] && exit 1\nexit 0\n',
      {
        mode: 0o755,
      },
    )
    writeFileSync(join(dir, 'log'), log)
    const proc = Bun.spawnSync(['bash', '-e', '-c', check?.run ?? 'exit 99'], {
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        FAIL_BUNX: fail.screenshot ? '1' : '',
        FAIL_STOP: fail.stop ? '1' : '',
      },
    })
    return {
      code: proc.exitCode,
      calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
      out: proc.stdout.toString(),
    }
  }

  test("starts the dev stack as the fix job's user, loads both pages, then stops it", () => {
    expect(check?.env?.QA_BACKEND_USER).toBe(step('fix', 'Start the stack on the working tree').env?.QA_BACKEND_USER)
    const { code, calls } = runCheck('VITE ready\nstack ready\n')
    expect(code).toBe(0)
    expect(calls[0]).toBe('stack start dev')
    expect(calls.at(-1)).toBe('stack stop')
    for (const name of ['QA_FRONTEND_PORT', 'QA_ONBOARDING_PORT'])
      expect(calls.some((c) => c.startsWith('bunx playwright screenshot') && c.includes(`:${ports[name]} `))).toBe(true)
  })

  test('fails on a write error in the stack log, after stopping the stack', () => {
    for (const error of [
      "Error: EACCES: permission denied, mkdir '/repo/node_modules/.cache/storybook'",
      'EPERM: operation not permitted',
      'Permission denied',
    ]) {
      const { code, calls } = runCheck(`${error}\nstack ready\n`)
      expect(code).not.toBe(0)
      expect(calls.at(-1)).toBe('stack stop')
    }
  })

  test('fails when a page does not load or the stack does not stop, still stops it and prints the log', () => {
    for (const fail of [{ screenshot: true }, { stop: true }]) {
      const { code, calls, out } = runCheck('VITE ready\nstack ready\n', fail)
      expect(code).not.toBe(0)
      expect(calls.at(-1)).toBe('stack stop')
      expect(out).toContain('stack ready')
    }
    const { calls } = runCheck('stack ready\n', { screenshot: true })
    expect(calls.filter((c) => c.startsWith('bunx playwright screenshot'))).toHaveLength(2)
  })

  test('reports a write error in the log even when a page did not load', () => {
    const { code, out } = runCheck('EACCES: permission denied\n', { screenshot: true })
    expect(code).not.toBe(0)
    expect(out).toContain('::error::A dev server could not write a file as another user.')
  })

  test('runs on the changes that decide what the dev servers write', () => {
    const filter = ci.jobs['detect-changes'].steps.find((s) => s.id === 'filter')?.with?.filters ?? ''
    const { qa } = Bun.YAML.parse(filter) as Record<string, string[]>
    for (const path of ['vite.config.ts', 'scripts/copy-powersync-assets.ts', 'package.json', 'bun.lock'])
      expect(qa).toContain(path)
    expect(ci.jobs.qa.if).toBe("needs.detect-changes.outputs.qa == 'true'")
  })
})

describe('passes', () => {
  /** Every upload of a check's pass, as `<job> <check>`, with its `if:` and the file it uploads. */
  const passUploads = Object.fromEntries(
    Object.keys(jobs).flatMap((job) =>
      steps(job)
        .filter((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.name?.startsWith('qa-pass-'))
        .map((s) => [`${job} ${s.with?.name?.split('}}-')[1]}`, { if: s.if, path: s.with?.path }]),
    ),
  )
  const outcome = (id: string) => `steps.${id}.outcome == 'success'`
  const fixScans = `always() && ${outcome('key-scan')} && ${outcome('secret-scan')} && `

  test("each check's pass is uploaded only on the outcome of the step that ran the check", () => {
    expect(passUploads).toEqual({
      'fix session': { if: fixScans + outcome('fix'), path: '${{ runner.temp }}/qa-pass.txt' },
      'fix replay': { if: fixScans + outcome('verify'), path: '${{ runner.temp }}/qa-pass.txt' },
      'fix visual': { if: fixScans + outcome('visual'), path: '${{ runner.temp }}/qa-pass.txt' },
      // The native platform is the matrix's, so the name ends in an expression.
      'verify-native-run ${{ matrix.check.platform }}': {
        if: `always() && ${outcome('run')}`,
        path: '${{ runner.temp }}/qa-pass.txt',
      },
      'verify-real real': { if: `always() && ${outcome('replay')}`, path: '${{ runner.temp }}/qa-pass.txt' },
      'verify-tests tests': { if: `always() && ${outcome('tests')}`, path: '${{ runner.temp }}/qa-pass.txt' },
    })
  })

  // Under continue-on-error the outcome still says how the step ended; only the job stays green.
  test('the replays a pass rests on fail on any failed run, and verify-tests runs the check in one process', () => {
    expect(step('fix', 'Replay the spec on the patched code').run).toContain('--repeat-each=3 --retries=0')
    expect(step('verify-real', 'Replay the spec on the patched frontend').run).toContain('--repeat-each=3 --retries=0')
    const tests = step('verify-tests', "Check that the patch's tests fail without the fix and pass with it")
    expect(tests.run).toBe('bun .github/qa/scripts/fix.ts tests --out qa-out --fp "$QA_FP"')
    expect(tests['continue-on-error']).toBe(true)
  })

  test('each job writes the uploaded file before any code the agent wrote runs there', () => {
    const marker = 'Write the file a passed check uploads'
    expect(indexOf('fix', marker)).toBeLessThan(indexOf('fix', 'Fix'))
    expect(indexOf('verify-tests', marker)).toBe(0)
    expect(indexOf('verify-native-run', marker)).toBeLessThan(
      indexOf('verify-native-run', 'Run the flow on the patched app'),
    )
    expect(step('fix', marker).run).toContain('"$RUNNER_TEMP/qa-pass.txt"')
  })

  test('publish reads the passes from the names of the run artifacts, and no verdict from a file', () => {
    const list = step('publish', "List the run's artifacts")
    expect(list.run).toContain('actions/runs/$GITHUB_RUN_ID/artifacts')
    expect(list.run).toContain('--paginate')
    expect(list.run).toContain('> qa-out/artifacts.txt')
    expect(list.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
    expect(indexOf('publish', "List the run's artifacts")).toBeLessThan(indexOf('publish', 'Publish a draft PR'))
    const downloads = steps('publish').filter((s) => s.uses?.startsWith('actions/download-artifact@'))
    for (const download of downloads)
      expect(`${download.with?.name ?? download.with?.pattern}`).not.toMatch(/qa-(pass|verify)-/)
    expect(jobs.publish.needs).toEqual(['build', 'file', 'fix', 'verify-native-run', 'verify-real', 'verify-tests'])
  })
})

describe('verify-tests', () => {
  test('holds no secret, no environment and no write permission, and starts from a fresh checkout', () => {
    const job = jobs['verify-tests']
    expect(JSON.stringify(job)).not.toContain('secrets.')
    expect(job.environment).toBeUndefined()
    expect(job.permissions).toEqual({ contents: 'read' })
    const checkout = steps('verify-tests').find((s) => s.uses?.startsWith('actions/checkout@'))
    expect(String(checkout?.with?.['persist-credentials'])).toBe('false')
    const download = steps('verify-tests').find((s) => s.uses?.startsWith('actions/download-artifact@'))
    expect(download?.with).toEqual({ name: 'qa-fix-${{ matrix.task.fp }}', path: 'qa-out' })
    expect(job.needs).toEqual(['build', 'file', 'fix'])
  })

  test("checks every web task of the plan and no native one, from route's output", () => {
    const route = step('file', 'Route fixable tickets').run ?? ''
    const filter = /tests=\$\(jq --compact-output '([^']+)' qa-out\/fix-plan\.json\)/.exec(route)?.[1] ?? ''
    const plan = {
      fixes: [
        { fp: 'web', kind: 'spec', spec: 'x' },
        { fp: 'visual', kind: 'visual' },
        { fp: 'ios', flow: 'f' },
      ],
    }
    const proc = Bun.spawnSync(['jq', '--compact-output', filter], { stdin: Buffer.from(JSON.stringify(plan)) })
    expect(JSON.parse(proc.stdout.toString()).map((t: { fp: string }) => t.fp)).toEqual(['web', 'visual'])
    expect(jobs['verify-tests'].strategy).toEqual({
      'fail-fast': false,
      matrix: { task: '${{ fromJSON(needs.file.outputs.tests) }}' },
    })
  })
})

describe('publish', () => {
  const runStep = (job: string, name: string, dir: string, env: Record<string, string>) =>
    Bun.spawnSync(['bash', '-e', '-c', step(job, name).run ?? ''], {
      cwd: dir,
      env: { PATH: process.env.PATH, QA_FP: 'fp1', ...env },
    })
  describe('whether the fix session began', () => {
    const timeoutMinutes = 60
    const now = () => Math.floor(Date.now() / 1000)
    const answered = { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the spec.' }] } }
    // The SDK's stand-in for a refused request: an assistant message carrying `error`.
    const refused = { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API' }] } }
    const result = { type: 'result', subtype: 'success', is_error: true }
    const init = { type: 'system', subtype: 'init' }
    const messages = (...list: object[]) => JSON.stringify(list)
    /** The status the fix job records, given the step outcome, the execution file and the session's start. */
    const status = (outcome: string, execution?: string, start = now()) => {
      const temp = mkdtempSync(join(work, 'status-'))
      const executionFile = join(temp, 'claude-execution-output.json')
      if (execution !== undefined) writeFileSync(executionFile, execution)
      const proc = runStep('fix', 'Record whether the fix session began', temp, {
        RUNNER_TEMP: temp,
        FIX_OUTCOME: outcome,
        START: String(start),
        EXECUTION_FILE: executionFile,
        QA_FIX_TIMEOUT_MINUTES: String(timeoutMinutes),
      })
      expect(proc.exitCode).toBe(0)
      return JSON.parse(readFileSync(join(temp, 'qa-status/fp1.json'), 'utf8')).stoppedBeforeSession
    }

    test('a step before Fix failed: the session never began', () => {
      expect(status('skipped')).toBe('setup-failed')
    })

    test('Fix failed before the model first answered: the session never began', () => {
      expect(status('failure')).toBe('no-model-answer')
      expect(status('failure', messages(init, refused, result))).toBe('no-model-answer')
      expect(status('failure', messages())).toBe('no-model-answer')
    })

    test('a session the model answered began, however it ended', () => {
      for (const outcome of ['failure', 'cancelled', 'success'])
        expect(status(outcome, messages(init, answered, refused, result))).toBeNull()
      expect(status('success')).toBeNull()
    })

    test('a timed-out session began, though the action wrote no execution file', () => {
      expect(status('failure', undefined, now() - timeoutMinutes * 60)).toBeNull()
      expect(status('failure', undefined, now() - timeoutMinutes * 60 + 120)).toBe('no-model-answer')
    })

    test('an unreadable execution file counts as begun, so the ticket still reaches a person', () => {
      expect(status('failure', '[{"type": "assis')).toBeNull()
    })

    test('the status goes up with every fix outcome, before agent code runs outside the sandbox', () => {
      // Fix, then the key scan (no agent code), then these two: every later step may run code the agent wrote.
      const fix = indexOf('fix', 'Fix')
      expect(steps('fix')[fix + 1].id).toBe('key-scan')
      const record = steps('fix')[fix + 2]
      const upload = steps('fix')[fix + 3]
      expect(record.name).toBe('Record whether the fix session began')
      expect(record.if).toBe('always()')
      expect(record.env?.PATH).toBe('/usr/bin:/bin')
      expect(upload.with?.name).toBe('qa-fix-status-${{ matrix.task.fp }}')
      // The key scan's verdict only: it reads no fix outcome, and it passes in every run that uploads the fix output.
      expect(upload.if).toBe("always() && steps.key-scan.outcome == 'success'")
      expect(upload.with?.path).toBe('${{ runner.temp }}/qa-status/')
      expect(upload.with?.['if-no-files-found']).toBe('error')
    })

    test("publish reads the status from its own artifact, which the agent's fix artifact cannot carry", () => {
      const download = steps('publish').find((s) => s.with?.name === 'qa-fix-status-${{ matrix.task.fp }}')
      expect(download?.with?.path).toBe('qa-out/status')
      expect(download?.['continue-on-error']).toBeUndefined()
      // The fix artifact lands in qa-out too, so none of its paths may reach qa-out/status.
      const fixUpload = steps('fix').find((s) => s.with?.name === 'qa-fix-${{ matrix.task.fp }}')
      const paths = (fixUpload?.with?.path ?? '').split('\n').filter(Boolean)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) expect(path).toMatch(/^qa-out\/fix(-\$\{\{ matrix\.task\.fp \}\})?\//)
    })
  })

  test('no fix-pipeline download may miss: a missing name is an error even under continue-on-error', () => {
    const jobNames = ['fix', 'verify-native-build', 'verify-native-run', 'verify-real', 'verify-tests', 'publish']
    const optional = jobNames.flatMap((job) =>
      steps(job)
        .filter((s) => s.uses?.startsWith('actions/download-artifact@') && s['continue-on-error'])
        .map((s) => `${job}: ${s.with?.name ?? s.with?.pattern}`),
    )
    expect(optional).toEqual([])
  })

  test('verify-native-run boots no device when the fix built no patched app', () => {
    const run = (withApp: boolean) => {
      const temp = mkdtempSync(join(work, 'patched-'))
      mkdirSync(join(temp, 'apps/patched'), { recursive: true })
      if (withApp) writeFileSync(join(temp, 'apps/patched/app.tar'), '')
      const githubEnv = join(temp, 'env')
      writeFileSync(githubEnv, '')
      const env = { RUNNER_TEMP: temp, GITHUB_ENV: githubEnv }
      expect(runStep('verify-native-run', 'Note a missing patched app', temp, env).exitCode).toBe(0)
      return readFileSync(githubEnv, 'utf8')
    }
    expect(run(false)).toBe('QA_NO_DEVICE=true\n')
    expect(run(true)).toBe('')
    expect(step('verify-native-run', 'Start the stack').if).toBe("env.QA_NO_DEVICE != 'true'")
    expect(step('verify-native-run', 'Run the flow on the patched app').if).toBe("env.QA_NO_DEVICE != 'true'")
  })

  test('verify-real replays only on a patched frontend it downloaded', () => {
    const download = steps('verify-real').find((s) => s.with?.pattern === 'qa-fix-dist-${{ matrix.task.fp }}')
    const present = `hashFiles('${download?.with?.path}/**') != ''`
    for (const name of [
      'Start the stack on the real providers',
      "Take root away from the job's user",
      'Replay the spec on the patched frontend',
    ])
      expect(step('verify-real', name).if).toBe(present)
  })

  test("says in the run summary, in the workflow's own words, that a ticket was left for a later run", () => {
    const dir = mkdtempSync(join(work, 'summary-'))
    mkdirSync(join(dir, 'qa-out/status'), { recursive: true })
    writeFileSync(join(dir, 'qa-out/fix-plan.json'), JSON.stringify({ fixes: [{ fp: 'fp1', identifier: 'THB-7' }] }))
    const summary = join(dir, 'summary.md')
    const say = (stoppedBeforeSession: string | null) => {
      writeFileSync(join(dir, 'qa-out/status/fp1.json'), JSON.stringify({ stoppedBeforeSession }))
      return runStep('publish', 'Say when a ticket was left for a later run', dir, { GITHUB_STEP_SUMMARY: summary })
    }
    expect(say(null).exitCode).toBe(0)
    expect(existsSync(summary)).toBe(false)
    expect(say('no-model-answer').exitCode).toBe(0)
    const line = readFileSync(summary, 'utf8')
    expect(line).toBe(
      '- THB-7: the fix job stopped before the fix session began, so the ticket is left for a later run.\n',
    )
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

test('a native fix check outlasts a driver retry and a replaced run, since a timeout leaves its ticket without a PR', () => {
  // The slowest check: boot, install and three runs of the iOS onboarding flow, about 6 minutes a run.
  const checkMinutes = 26
  const runMinutes = 6
  expect(jobs['verify-native-run']['timeout-minutes']).toBeGreaterThan(
    checkMinutes + runMinutes + nativeDriverStartupMinutes,
  )
})

test("the iOS log stream outlasts a replay leg, since a run after it ends sees no line and can't prove a bug", () => {
  const nativeSh = readFileSync(join(import.meta.dir, 'native.sh'), 'utf8')
  const hours = Number(/log stream .* --timeout (\d+)h/.exec(nativeSh)?.[1])
  expect(hours * 60).toBeGreaterThan(jobs['replay-native']['timeout-minutes'] ?? 0)
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
      ['explore-native', 'Check that the gate denies the forbidden calls'],
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

describe('a fix-only run', () => {
  const repo = join(import.meta.dir, '../../..')
  const fromRun = '${{ inputs.fix_from_run }}'
  const replayPattern = 'qa-replay-{weekly,sync,real,ios,android,android-sync,android-real}'
  /** A directory to put first on PATH, holding executable stubs. */
  const stubs = (files: Record<string, string>) => {
    const bin = mkdtempSync(join(work, 'bin-'))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(bin, name), text, { mode: 0o755 })
    return `${bin}:${process.env.PATH}`
  }
  const runStep = (job: string, name: string, cwd: string, env: Record<string, string>) =>
    Bun.spawnSync(['bash', '-e', '-c', step(job, name).run ?? ''], { cwd, env: { PATH: process.env.PATH, ...env } })

  test('takes only a run id of a scheduled or dispatched run of this workflow on main, before anything else', () => {
    const check = steps('build')[0]
    expect(check.name).toBe('Check the run to fix from')
    expect(check.if).toBe('inputs.fix_from_run')
    const args = join(work, 'gh-args')
    // Applies the step's own --jq filter to the API object the path asks for, so the field names are exercised.
    const gh = [
      '#!/bin/sh',
      'echo "$@" >> "$GH_ARGS"',
      'case "$2" in */artifacts*) json=$GH_ARTIFACTS ;; */compare/*) json=$GH_COMPARE ;; *) json=$GH_RUN ;; esac',
      'printf %s "$json" | jq --raw-output "$4"',
    ]
    const PATH = stubs({ gh: `${gh.join('\n')}\n` })
    type ApiRun = {
      path: string
      event: string
      head_branch: string
      head_repository: { full_name: string }
      head_sha: string
    }
    type ApiArtifacts = { artifacts: { name: string; expired: boolean }[] }
    const mainRun: ApiRun = {
      path: '.github/workflows/qa-weekly.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_repository: { full_name: 'owner/repo' },
      head_sha: 'abc123',
    }
    const liveFiled: ApiArtifacts = { artifacts: [{ name: 'qa-filed', expired: false }] }
    const checkRun = (id: string, run = mainRun, status = 'ahead', artifacts = liveFiled) => {
      rmSync(args, { force: true })
      const lookups = {
        GH_ARGS: args,
        GH_RUN: JSON.stringify(run),
        GH_COMPARE: JSON.stringify({ status }),
        GH_ARTIFACTS: JSON.stringify(artifacts),
      }
      const env = { PATH, FIX_FROM_RUN: id, GITHUB_REPOSITORY: 'owner/repo', ...lookups }
      return runStep('build', 'Check the run to fix from', work, env).exitCode
    }

    expect(checkRun('123')).toBe(0)
    const calls = readFileSync(args, 'utf8').split('\n')
    expect(calls[0]).toStartWith('api repos/owner/repo/actions/runs/123 ')
    // The full ref: a bare main would resolve to a tag named main and compare that tag with itself.
    expect(calls[1]).toStartWith('api repos/owner/repo/compare/abc123...refs/heads/main ')
    expect(calls[2]).toStartWith('api repos/owner/repo/actions/runs/123/artifacts?name=qa-filed ')
    expect(checkRun('123', { ...mainRun, event: 'schedule' }, 'identical')).toBe(0)
    const refused = {
      'a pull request': [{ ...mainRun, event: 'pull_request' }],
      'another workflow': [{ ...mainRun, path: '.github/workflows/ci.yml' }],
      'a dispatch on a branch': [{ ...mainRun, head_branch: 'feature' }],
      'a fork': [{ ...mainRun, head_repository: { full_name: 'fork/repo' } }],
      'a tag named main': [mainRun, 'diverged'],
      'an expired qa-filed': [mainRun, 'ahead', { artifacts: [{ name: 'qa-filed', expired: true }] }],
      'no qa-filed': [mainRun, 'ahead', { artifacts: [] }],
    } satisfies Record<string, [ApiRun, string?, ApiArtifacts?]>
    for (const [why, [run, status, artifacts]] of Object.entries(refused))
      expect({ why, exit: checkRun('123', run, status, artifacts) }).toEqual({ why, exit: 1 })
    for (const id of ['12a', '1 2', '123; touch pwned', '../123', '']) {
      expect({ id, exit: checkRun(id) }).toEqual({ id, exit: 1 })
      expect(existsSync(args)).toBe(false)
    }
  })

  test('plans no explore, replay, judge or canary leg, but still builds the native apps', () => {
    const planIn = (temp: string, fixFromRun: string, autofix: string) => {
      const env = { RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'out'), FIX_FROM_RUN: fixFromRun, AUTOFIX: autofix }
      return runStep('build', 'Plan the legs', repo, { ...env, CHARTERS: '', JOURNEY: '' })
    }
    const plan = (fixFromRun: string) => {
      const temp = mkdtempSync(join(work, 'plan-'))
      if (!fixFromRun) writeFileSync(join(temp, 'qa-canaries.json'), '[]')
      expect(planIn(temp, fixFromRun, 'true').exitCode).toBe(0)
      const lines = readFileSync(join(temp, 'out'), 'utf8').trim().split('\n')
      return Object.fromEntries(lines.map((line) => line.split(/=(.*)/s).slice(0, 2)))
    }
    // Off main, or with QA_AUTOFIX_ENABLED unset, route would skip, so the run stops before any build.
    const refused = planIn(mkdtempSync(join(work, 'plan-')), '123', 'false')
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout.toString()).toContain('::error::A fix-only run routes nothing without autofix')
    const frontendBuild = indexOf('build', 'Build the frontend (onboarding off, onboarding on)')
    expect(indexOf('build', 'Plan the legs')).toBeLessThan(frontendBuild)
    const planned = ['legs', 'nativeLegs', 'verify', 'nativeVerify', 'judge']

    const weekly = plan('')
    for (const key of planned) expect({ key, empty: weekly[key] === '[]' }).toEqual({ key, empty: false })
    const fixOnly = plan('123')
    for (const key of [...planned, 'skipped']) expect({ key, value: fixOnly[key] }).toEqual({ key, value: '[]' })
    expect(fixOnly.nativeBuilds).toBe(weekly.nativeBuilds)
    const builds: { platform: string }[] = JSON.parse(fixOnly.nativeBuilds)
    expect(builds.map((b) => b.platform).sort()).toEqual(['android', 'ios'])

    expect(step('build', 'Pick the canaries and build them').if).toBe('${{ !inputs.fix_from_run }}')
    expect(jobs.explore.if).toBe("needs.build.outputs.legs != '[]'")
    expect(jobs['explore-native'].if).toContain("needs.build.outputs.nativeLegs != '[]'")
    expect(jobs.replay.if).toContain("needs.build.outputs.verify != '[]'")
    expect(jobs['replay-native'].if).toContain("needs.build.outputs.nativeVerify != '[]'")
    expect(jobs.judge.if).toContain("needs.build.outputs.judge != '[]'")
    expect(jobs['build-native'].if).toBe("needs.build.outputs.nativeBuilds != '[]'")
  })

  test("files nothing and routes the earlier run's tickets, whose artifacts later jobs find under this run", () => {
    expect(jobs.file.if).toContain("needs.build.outputs.judge != '[]' || inputs.fix_from_run != ''")
    expect(step('file', 'File the confirmed findings').if).toBe('${{ !inputs.fix_from_run }}')
    const at = (match: (s: Step) => boolean) => steps('file').findIndex(match)
    const replays = indexOf('file', 'Download the replays of the run to fix from')
    const tickets = indexOf('file', 'Download the findings and tickets of the run to fix from')
    for (const download of [replays, tickets]) {
      expect(steps('file')[download].if).toBe('inputs.fix_from_run')
      expect(steps('file')[download].with).toMatchObject({ 'run-id': fromRun, 'github-token': '${{ github.token }}' })
    }
    expect(steps('file')[replays].with?.pattern).toBe(replayPattern)
    expect(new Bun.Glob(steps('file')[tickets].with?.pattern ?? '').match('qa-filed')).toBe(true)
    expect(new Bun.Glob(steps('file')[tickets].with?.pattern ?? '').match('qa-verified-weekly')).toBe(true)

    // Uploaded again before the earlier run's verified.json and filed.json reach qa-out.
    const upload = (name: string) =>
      at((s) => !!s.uses?.startsWith('actions/upload-artifact@') && s.with?.name === name)
    const replayUpload = upload('qa-replay-weekly')
    const verifiedUpload = upload('qa-verified-weekly')
    expect(replayUpload).toBeGreaterThan(replays)
    expect(replayUpload).toBeLessThan(tickets)
    expect(verifiedUpload).toBeGreaterThan(tickets)
    for (const index of [replayUpload, verifiedUpload]) expect(steps('file')[index].if).toBe('inputs.fix_from_run')
    for (const job of ['fix', 'verify-native-run', 'verify-real', 'publish']) {
      const downloads = steps(job).filter((s) => s.uses?.startsWith('actions/download-artifact@'))
      for (const s of downloads) expect({ job, runId: s.with?.['run-id'] }).toEqual({ job, runId: undefined })
      const patterns = downloads.flatMap((s) => (s.with?.pattern?.includes('qa-replay') ? [s.with.pattern] : []))
      expect(patterns.length).toBeGreaterThan(0)
      const misses = patterns.filter((pattern) => !new Bun.Glob(pattern).match('qa-replay-weekly'))
      expect({ job, misses }).toEqual({ job, misses: [] })
    }
    expect(
      steps('verify-native-run').some((s) => s.with?.name === 'qa-verified-weekly'),
      'verify-native-run reads the re-uploaded verified findings',
    ).toBe(true)

    const route = indexOf('file', 'Route fixable tickets')
    expect(route).toBeGreaterThan(verifiedUpload)
    expect(step('file', 'Route fixable tickets').if).toBe("needs.build.outputs.autofix == 'true'")
    expect(step('build', 'Plan the legs').env?.AUTOFIX).toContain("inputs.fix_from_run != ''")
    // route() sends every ticket of the earlier run, so a charters filter must not drop a native build.
    expect(step('build', 'Plan the legs').env?.CHARTERS).toBe(
      "${{ inputs.fix_from_run == '' && inputs.charters || '' }}",
    )
  })

  test('publishes only when the run is live, as on any run: main, Linear on and dry_run off', () => {
    expect(step('build', 'Plan the legs').env?.LIVE).toBe(
      "${{ vars.QA_LINEAR_ENABLED == 'true' && !inputs.dry_run && github.ref == 'refs/heads/main' }}",
    )
    for (const name of ['Create the GitHub App token', 'Commit as the app'])
      expect(step('publish', name).if).toBe("needs.build.outputs.live == 'true'")
    const liveFlag = "${{ needs.build.outputs.live == 'true' && '--live' || '' }}"
    expect(step('publish', 'Publish a draft PR').run).toContain(liveFlag)
  })

  test("reports its own fix sessions only, never the earlier run's findings as its own", () => {
    const earlier = ['verified.json', 'filed.json', 'scorecard.json']
    const PATH = stubs({ bun: '#!/bin/sh\nexit 0\n' })
    const report = (fixFromRun: string) => {
      const dir = mkdtempSync(join(work, 'report-'))
      mkdirSync(join(dir, 'qa-out'))
      for (const file of earlier) writeFileSync(join(dir, 'qa-out', file), '{}')
      const summary = join(dir, 'summary.md')
      const env = { PATH, GITHUB_STEP_SUMMARY: summary, FIX_FROM_RUN: fixFromRun, CANARIES: '' }
      expect(runStep('report', 'Report', dir, { ...env, LEGS: '[]', NATIVE_LEGS: '[]' }).exitCode).toBe(0)
      return {
        left: earlier.filter((file) => existsSync(join(dir, 'qa-out', file))),
        summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
      }
    }
    expect(report('')).toEqual({ left: earlier, summary: '' })
    const fixOnly = report('123')
    expect(fixOnly.left).toEqual([])
    expect(fixOnly.summary).toBe('# Fix-only run: fixes the tickets of run 123, explores nothing\n')
    expect(jobs.notify.with?.incident).toBe("${{ inputs.fix_from_run && 'QA weekly fix-only' || '' }}")
  })
})

test('every job but the reusable notify call has a timeout and read-only permissions', () => {
  // A fix-only run looks up the earlier run in build and reads its artifacts in file, where route lists open PRs.
  const permissionsOf = (name: string) => {
    if (name === 'build') return { actions: 'read', contents: 'read' }
    if (name === 'file') return { actions: 'read', contents: 'read', 'pull-requests': 'read' }
    // Publish lists the run's artifacts, whose names carry the checks' passes.
    if (name === 'publish') return { actions: 'read', contents: 'read' }
    return { contents: 'read' }
  }
  for (const [name, job] of Object.entries(jobs).filter(([, job]) => !job.uses)) {
    expect({ name, timeout: (job['timeout-minutes'] ?? 0) > 0 }).toEqual({ name, timeout: true })
    // app-check gets its token from the app, so it asks the runner for no permissions at all (see the next test).
    if (name === 'app-check') continue
    const permissions = permissionsOf(name)
    expect({ name, permissions: job.permissions }).toEqual({ name, permissions })
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
