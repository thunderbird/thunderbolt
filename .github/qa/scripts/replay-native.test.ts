/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoPath } from './replay-native'

test('no two replay legs write the same video, though each counts its runs from 1', () => {
  // The judge and the file job merge every leg into one qa-out; each leg runs the control flow first.
  const paths = ['ios', 'android', 'android-sync', 'android-real'].flatMap((leg) =>
    [1, 2, 3].map((run) => videoPath('qa-out', leg, 'control', run)),
  )
  expect(new Set(paths).size).toBe(paths.length)
  expect(videoPath('qa-out', 'android', 'c2-chat-power-user-android', 4)).toBe(
    'qa-out/videos/android-c2-chat-power-user-android-run-4.mp4',
  )
  // A fix's check runs alone in its own folder, with no leg.
  expect(videoPath('out', undefined, 'c1-first-run-ios', 1)).toBe('out/videos/c1-first-run-ios-run-1.mp4')
})

const work = mkdtempSync(join(tmpdir(), 'qa-replay-native-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

test('an Android run reinstalls and warms the app first, and adds the tree line for a field behind the keyboard', () => {
  const bin = join(work, 'bin')
  const calls = join(work, 'calls.log')
  // The focused Email field moved under the keyboard.
  const hierarchy = join(work, 'hierarchy.json')
  const tree = readFileSync(join(import.meta.dir, '../fixtures/native/hier-android-control.json'), 'utf8')
  writeFileSync(hierarchy, tree.replace('[84,1131][1000,1281]', '[84,1700][1000,1850]'))
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash
echo "adb $*" >> '${calls}'
case "$*" in
  *"shell pidof "*) echo 4129 ;;
  *"logcat -d --pid=4129"*) echo 'I Tauri/Console: Msg: [init] step1_create_app_dir: 399ms' ;;
esac
exit 0
`,
  )
  writeFileSync(
    join(bin, 'maestro'),
    `#!/bin/bash\necho "maestro $*" >> '${calls}'\n[ "$3" = hierarchy ] && cat '${hierarchy}'\nexit 0\n`,
  )
  for (const tool of ['adb', 'maestro']) chmodSync(join(bin, tool), 0o755)
  const webviewLog = join(work, 'webview.log')
  const backendLog = join(work, 'backend.log')
  for (const file of [webviewLog, backendLog]) writeFileSync(file, '')
  // A child process, because Bun 1.3.14's shell keeps the PATH it started with.
  const script = `
    import { createRunFlow } from ${JSON.stringify(join(import.meta.dir, 'replay-native.ts'))}
    const runFlow = createRunFlow({
      platform: 'android',
      deviceId: 'emulator-5554',
      apps: { onboarding: 'apps/onboarding.apk', plain: 'apps/plain.apk' },
      webviewLog: ${JSON.stringify(webviewLog)},
      backendLog: ${JSON.stringify(backendLog)},
    })
    const run = await runFlow('- launchApp\\n', ${JSON.stringify(join(work, 'out'))}, 1, 'c2-chat-power-user-android')
    console.log(JSON.stringify(run.layout))
  `
  // Relative app paths, as a caller may pass them, from a folder other than the one native.sh moves to.
  const proc = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

  expect(proc.stderr.toString()).toBe('')
  expect(JSON.parse(proc.stdout.toString())).toEqual(['[qa-layout] behind-keyboard textbox "Email"'])
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  expect(log.slice(0, 2)).toEqual([
    'adb -s emulator-5554 uninstall net.thunderbird.thunderbolt',
    `adb -s emulator-5554 install -r ${join(realpathSync(work), 'apps/plain.apk')}`,
  ])
  const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line))
  // Then the stack's ports again, which a reset of adb's connection to the emulator drops, and the first launch.
  const firstLaunch = at(/ shell monkey -p net\.thunderbird\.thunderbolt /)
  expect(firstLaunch).toBeGreaterThan(2)
  expect(
    log.slice(2, firstLaunch).filter((line) => !/^adb -s emulator-5554 reverse tcp:\d+ tcp:\d+$/.test(line)),
  ).toEqual([])
  expect(at(/^maestro .* test /)).toBeGreaterThan(at(/am force-stop net\.thunderbird\.thunderbolt$/))
  expect(at(/^maestro .* hierarchy$/)).toBeGreaterThan(at(/^maestro .* test /))
})

// What the probe logs on that step: the checkbox the tree also reports, and a button the iOS tree cannot see.
const probeCheckbox = '[qa-layout] unnamed-control checkbox "#terms-agreement"'
const probeButton = '[qa-layout] unnamed-control button "arrow-left icon after Connect Google"'

/** Ends on the privacy step with the checkbox unlabeled; `failure` fails the sign-in or times out the flow's driver. */
const iosRun = (failure: '' | 'sign-in' | 'driver') => {
  const dir = mkdtempSync(join(work, 'ios-'))
  const bin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  const hierarchy = join(dir, 'hierarchy.json')
  const consent = readFileSync(join(import.meta.dir, '../fixtures/native/hier-consent.json'), 'utf8')
  const label = '"accessibilityText" : "I agree to the Privacy Policy and Terms of Service ."'
  writeFileSync(hierarchy, consent.replace(label, '"accessibilityText" : ""'))
  mkdirSync(bin)
  writeFileSync(join(bin, 'xcrun'), `#!/bin/bash\necho "xcrun $*" >> '${calls}'\nexit 0\n`)
  writeFileSync(
    join(bin, 'maestro'),
    `#!/bin/bash
echo "maestro $3" >> '${calls}'
[ "$3" = hierarchy ] && { cat '${hierarchy}'; exit 0; }
if grep -q 'Check your email' "$6"; then [ '${failure}' = sign-in ] && exit 1; exit 0; fi
[ '${failure}' = driver ] && { echo 'iOS driver not ready in time'; exit 1; }
echo 'tauri://localhost:1:2: CONSOLE ERROR ${probeCheckbox}' >> '${join(dir, 'webview.log')}'
echo 'tauri://localhost:1:2: CONSOLE ERROR ${probeButton}' >> '${join(dir, 'webview.log')}'
exit 0
`,
  )
  for (const tool of ['xcrun', 'maestro']) chmodSync(join(bin, tool), 0o755)
  const logs = [join(dir, 'webview.log'), join(dir, 'backend.log')]
  for (const file of logs) writeFileSync(file, '')
  const script = `
    import { createRunFlow } from ${JSON.stringify(join(import.meta.dir, 'replay-native.ts'))}
    const runFlow = createRunFlow({
      platform: 'ios',
      deviceId: 'SIM-1',
      apps: { onboarding: 'on.app', plain: 'plain.app' },
      webviewLog: ${JSON.stringify(logs[0])},
      backendLog: ${JSON.stringify(logs[1])},
    })
    const run = await runFlow('- assertVisible: x\\n', ${JSON.stringify(join(dir, 'out'))}, 1, 'c1-first-run-ios',
      '- extendedWaitUntil: Check your email\\n')
    console.log(JSON.stringify(run.layout))
  `
  const proc = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  expect(proc.stderr.toString()).toBe('')
  const maestro = readFileSync(calls, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('maestro'))
  return { layout: JSON.parse(proc.stdout.toString()), maestro }
}

test('an iOS run adds the tree line of the screen it ends on, read once after the flow', () =>
  // Only the last screen is read, and the tree's line stands for the checkbox, so the probe's own line is left out.
  expect(iosRun('')).toEqual({
    layout: [probeButton, '[qa-layout] unnamed-control checkbox "after Data is stored securely on your device."'],
    maestro: ['maestro test', 'maestro test', 'maestro hierarchy'],
  }))

test('an iOS run whose sign-in failed skips the tree, since it never counts', () =>
  expect(iosRun('sign-in')).toEqual({ layout: [], maestro: ['maestro test'] }))

test('an iOS run whose driver never started skips the tree, since it never counts', () =>
  expect(iosRun('driver')).toEqual({ layout: [], maestro: ['maestro test', 'maestro test'] }))

test("the harness's sign-in runs first in the same install, and when it fails the flow never runs", () => {
  const dir = mkdtempSync(join(work, 'sign-in-'))
  const bin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  mkdirSync(bin)
  const fail = join(dir, 'fail-sign-in')
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash
case "$*" in
  *"shell pidof "*) echo 4129 ;;
  *"logcat -d --pid=4129"*) echo 'I Tauri/Console: Msg: [init] step1_create_app_dir: 399ms' ;;
  *" get-state") echo device ;;
esac
exit 0
`,
  )
  // Fails the sign-in while the flag file exists.
  writeFileSync(
    join(bin, 'maestro'),
    `#!/bin/bash
[ "$3" = test ] || exit 1
if grep -q 'Check your email' "$6"; then
  echo "maestro sign-in" >> '${calls}'
  [ -f '${fail}' ] && { echo 'Assertion is false: "Check your email" is visible'; exit 1; }
  exit 0
fi
echo "maestro flow" >> '${calls}'
`,
  )
  for (const tool of ['adb', 'maestro']) chmodSync(join(bin, tool), 0o755)
  const logs = [join(dir, 'webview.log'), join(dir, 'backend.log')]
  for (const file of logs) writeFileSync(file, '')
  const script = `
    import { createRunFlow } from ${JSON.stringify(join(import.meta.dir, 'replay-native.ts'))}
    const runFlow = createRunFlow({
      platform: 'android',
      deviceId: 'emulator-5554',
      apps: { onboarding: 'on.apk', plain: 'plain.apk' },
      webviewLog: ${JSON.stringify(logs[0])},
      backendLog: ${JSON.stringify(logs[1])},
    })
    const run = await runFlow('- assertVisible: x\\n', ${JSON.stringify(join(dir, 'out'))}, 1, 'c2-chat-power-user-android',
      '- extendedWaitUntil: Check your email\\n')
    console.log(JSON.stringify({ passed: run.passed, signInFailed: run.signInFailed, error: run.error }))
  `
  const runs = [false, true].map((failSignIn) => {
    writeFileSync(calls, '')
    if (failSignIn) writeFileSync(fail, '')
    const proc = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    expect(proc.stderr.toString()).toBe('')
    const maestro = readFileSync(calls, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('maestro'))
    return { result: JSON.parse(proc.stdout.toString()), maestro }
  })

  expect(runs[0]).toEqual({
    result: { passed: true, signInFailed: false },
    maestro: ['maestro sign-in', 'maestro flow'],
  })
  expect(runs[1]).toEqual({
    result: { passed: false, signInFailed: true, error: 'Assertion is false: "Check your email" is visible' },
    maestro: ['maestro sign-in'],
  })
})

/**
 * Runs the Android flow once per entry of `flags`, after creating the files that entry names: `lost-<serial>` makes
 * adb lose that emulator, `drop-<serial>` makes adb lose it during Maestro's flow, `drop-tree-<serial>` during the
 * tree dump until the next `adb devices`, `flap-<serial>` makes adb lose it until the next `adb devices`,
 * `blip-<serial>` fails one install with adb's "not found" while adb still sees it, `other-<serial>` puts another AVD
 * on that serial, `full` fails the install on a device adb still sees, `fail-flow` fails Maestro's flow, `hang` hangs
 * the warm-up session, `hang-adb` hangs `adb get-state`, `dead-stream` makes the new WebView stream exit at once. An
 * unrelated emulator-5558 is always online; a new boot of our AVD comes up as emulator-5556. A recovery must end
 * `recoverIn` ms after the start (a negative value puts the deadline before the runs), and `never` passes no
 * deadline, as fix-native does. Maestro's tree dump always fails. Returns each run's result or what it threw, the
 * calls with paths cut to file names, stderr, what the WebView log and $GITHUB_ENV hold, how many ms past the
 * deadline the runs ended, and the pids of the `adb get-state` calls that hung.
 */
const androidRuns = (flags: (string | undefined)[], recoverIn: number | 'never' = 600_000) => {
  const dir = mkdtempSync(join(work, 'lost-'))
  const bin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash
echo "adb $*" >> '${calls}'
serial=$2
lost() { [ -f "${dir}/lost-$serial" ] || [ -f "${dir}/flap-$serial" ]; }
case "$*" in
  devices)
    rm -f '${dir}'/flap-*
    printf 'List of devices attached\\nemulator-5558\\tdevice\\n'
    [ -f '${dir}/lost-emulator-5554' ] || printf 'emulator-5554\\tdevice\\n'
    [ -f '${dir}/qa-emulator.pid' ] && printf 'emulator-5556\\tdevice\\n' ;;
  *" getprop ro.boot.qemu.avd_name")
    if [ "$serial" = emulator-5558 ] || [ -f "${dir}/other-$serial" ]; then echo pixel-other; else echo qa-android; fi ;;
  *" get-state")
    [ -f '${dir}/hang-adb' ] && { echo $$ >> '${dir}/hung'; exec sleep 30; }
    lost && { echo "error: device '$2' not found" >&2; exit 1; }
    echo device ;;
  *" logcat -v epoch -T 1 "*) [ -f '${dir}/dead-stream' ] && { echo 'error: device offline'; exit 1; }; exec sleep 20 ;;
  *" install -r "*)
    lost && { echo "adb: device '$2' not found" >&2; exit 1; }
    [ -f "${dir}/blip-$serial" ] && { rm "${dir}/blip-$serial"; echo "adb: device '$2' not found" >&2; exit 1; }
    [ -f '${dir}/full' ] && { echo 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'; exit 1; } ;;
  *"shell pidof "*) echo 4129 ;;
  *"logcat -d --pid=4129"*) echo 'I Tauri/Console: Msg: [init] step1_create_app_dir: 399ms' ;;
  *"getprop sys.boot_completed" | *"settings get global hide_error_dialogs") echo 1 ;;
esac
exit 0
`,
  )
  writeFileSync(
    join(bin, 'maestro'),
    `#!/bin/bash
echo "maestro $*" >> '${calls}'
if [ "$3" = hierarchy ]; then
  [ -f "${dir}/drop-tree-$2" ] && { rm "${dir}/drop-tree-$2"; : > "${dir}/flap-$2"; }
  exit 1
fi
[ "$3" = test ] || exit 1
[ -f '${dir}/hang' ] && [ "$4" != -e ] && exec sleep 60
[ -f "${dir}/drop-$2" ] && [ "$4" = -e ] && { : > "${dir}/lost-$2"; echo "device '$2' not found"; exit 1; }
[ -f '${dir}/fail-flow' ] && [ "$4" = -e ] && { echo 'Element not found: Continue'; exit 1; }
exit 0
`,
  )
  writeFileSync(join(bin, 'avdmanager'), '#!/bin/bash\necho qa-android\n')
  // Runs until it is stopped, like an emulator.
  writeFileSync(join(bin, 'emulator'), `#!/bin/bash\necho "emulator $*" >> '${calls}'\nexec sleep 20\n`)
  for (const tool of ['adb', 'maestro', 'avdmanager', 'emulator']) chmodSync(join(bin, tool), 0o755)
  const logs = [join(dir, 'webview.log'), join(dir, 'backend.log')]
  writeFileSync(logs[0], 'I Tauri/Console: before the loss\n')
  writeFileSync(logs[1], '')
  const githubEnv = join(dir, 'github-env')
  const script = `
    import { writeFileSync } from 'node:fs'
    import { createRunFlow } from ${JSON.stringify(join(import.meta.dir, 'replay-native.ts'))}
    const recoverBy = ${recoverIn === 'never' ? 'undefined' : `Date.now() + ${recoverIn}`}
    const runFlow = createRunFlow({
      platform: 'android',
      deviceId: 'emulator-5554',
      apps: { onboarding: 'on.apk', plain: 'plain.apk' },
      webviewLog: ${JSON.stringify(logs[0])},
      backendLog: ${JSON.stringify(logs[1])},
      recoverBy,
    })
    const results = []
    for (const [index, flag] of ${JSON.stringify(flags)}.entries()) {
      for (const name of flag?.split(' ') ?? []) writeFileSync(${JSON.stringify(dir)} + '/' + name, '')
      try {
        const run = await runFlow('- launchApp\\n', ${JSON.stringify(join(dir, 'out'))}, index + 1, 'c2-chat-power-user-android')
        // Left out when empty, as error is when the run passed.
        const layout = run.layout.length > 0 ? run.layout : undefined
        results.push({ passed: run.passed, error: run.error, inconclusive: run.inconclusive, layout })
      } catch (error) {
        results.push({ threw: error.constructor.name, message: error.message, retry: error.retry })
      }
    }
    console.log(JSON.stringify({ results, overrun: Date.now() - recoverBy }))
  `
  const proc = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ANDROID_AVD_HOME: join(dir, 'avd'),
      TMPDIR: dir,
      GITHUB_ENV: githubEnv,
    },
  })
  for (const pidFile of [join(dir, 'qa-emulator.pid'), `${logs[0]}.pid`]) {
    if (existsSync(pidFile)) Bun.spawnSync(['kill', readFileSync(pidFile, 'utf8').trim()])
  }
  // The boot and the warm-up print to stdout too, as they do in the job's log.
  const { results, overrun } = JSON.parse(proc.stdout.toString().trim().split('\n').at(-1) ?? '')
  return {
    results,
    calls: readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(/EMAIL=\S+/, 'EMAIL').replace(/\S*\//g, '')),
    stderr: proc.stderr.toString(),
    webview: readFileSync(logs[0], 'utf8'),
    githubEnv: existsSync(githubEnv) ? readFileSync(githubEnv, 'utf8') : '',
    overrun,
    hung: existsSync(join(dir, 'hung')) ? readFileSync(join(dir, 'hung'), 'utf8').trim().split('\n') : [],
  }
}

/** The call that starts the WebView stream again on `serial`, with its path cut as `androidRuns` cuts it. */
const resumed = (serial: string) => `adb -s ${serial} logcat -v epoch -T 1 -s Console:*`
// The tests that recover get 15 s: a recovery adds native.sh's device step, the warm-up and the stream's 1 s check
// to the runs' probe waits.

test('an Android run on an emulator adb lost boots a new one once, and the runs after it use that one', () => {
  // The first loss fails the install, the second the flow.
  const { results, calls, stderr, webview, githubEnv } = androidRuns([
    'lost-emulator-5554',
    undefined,
    'drop-emulator-5556',
  ])

  expect(results).toEqual([
    { threw: 'DeviceLost', message: 'emulator dropped off adb', retry: true },
    { passed: true },
    { threw: 'DeviceLost', message: 'emulator dropped off adb a second time in this leg', retry: false },
  ])
  // The new emulator gets the job's warm-up session and the WebView stream before the run starts over on it.
  expect(calls.filter((line) => / install -r | logcat -v epoch |^maestro .* test /.test(line))).toEqual([
    'adb -s emulator-5554 install -r plain.apk',
    'adb -s emulator-5556 install -r plain.apk',
    'maestro --udid emulator-5556 test qa-warm-up.yaml',
    resumed('emulator-5556'),
    'adb -s emulator-5556 install -r plain.apk',
    'maestro --udid emulator-5556 test -e EMAIL flow.yaml',
    'adb -s emulator-5556 install -r plain.apk',
    'maestro --udid emulator-5556 test -e EMAIL flow.yaml',
  ])
  // Our AVD cold-boots although another emulator is online, and the leg's last step reads the new serial.
  expect(calls.filter((line) => line.startsWith('emulator '))).toEqual([
    'emulator -avd qa-android -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect',
  ])
  expect(githubEnv).toBe('QA_DEVICE_ID=emulator-5556\n')
  // The lost run stops before its video is pulled.
  expect(calls.filter((line) => line.includes(' pull '))).toHaveLength(1)
  // Only the first loss got a recovery.
  expect(calls.filter((line) => line.endsWith(' -G 64M'))).toHaveLength(1)
  expect(calls.filter((line) => line.endsWith(' logcat -c'))).toEqual([])
  expect(webview).toBe('I Tauri/Console: before the loss\n')
  expect(stderr).toContain('adb lost emulator-5554;')
  expect(stderr).toContain('adb lost emulator-5556;')
}, 15_000)

test('an Android run on an emulator adb sees again by the recovery starts over on it, with no boot', () => {
  const { results, calls, webview, githubEnv } = androidRuns(['flap-emulator-5554', undefined])

  expect(results).toEqual([{ threw: 'DeviceLost', message: 'emulator dropped off adb', retry: true }, { passed: true }])
  // The device step and the warm-up run on the same emulator, the stream starts again on it, keeping what it held,
  // and the next run uses it.
  expect(calls.filter((line) => / install -r | logcat -v epoch | -G 64M$|^emulator /.test(line))).toEqual([
    'adb -s emulator-5554 install -r plain.apk',
    'adb -s emulator-5554 logcat -b main,system,crash,events -G 64M',
    'adb -s emulator-5554 install -r plain.apk',
    resumed('emulator-5554'),
    'adb -s emulator-5554 install -r plain.apk',
  ])
  expect(webview).toBe('I Tauri/Console: before the loss\n')
  expect(githubEnv).toBe('QA_DEVICE_ID=emulator-5554\n')
}, 15_000)

test("an install that failed on adb's not found counts as a loss, though adb sees the emulator again at once", () => {
  const { results, calls } = androidRuns(['blip-emulator-5554', undefined])

  expect(results).toEqual([{ threw: 'DeviceLost', message: 'emulator dropped off adb', retry: true }, { passed: true }])
  expect(calls.filter((line) => / install -r |^emulator /.test(line))).toEqual([
    'adb -s emulator-5554 install -r plain.apk',
    'adb -s emulator-5554 install -r plain.apk',
    'adb -s emulator-5554 install -r plain.apk',
  ])
}, 15_000)

test('a recovery never reuses a serial that now runs another AVD, and boots ours instead', () => {
  const { results, calls } = androidRuns(['blip-emulator-5554 other-emulator-5554', undefined])

  expect(results).toEqual([{ threw: 'DeviceLost', message: 'emulator dropped off adb', retry: true }, { passed: true }])
  expect(calls.filter((line) => / install -r |^emulator /.test(line))).toEqual([
    'adb -s emulator-5554 install -r plain.apk',
    'emulator -avd qa-android -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect',
    'adb -s emulator-5556 install -r plain.apk',
    'adb -s emulator-5556 install -r plain.apk',
  ])
}, 15_000)

test('a recovery whose new WebView stream exits at once fails, and the loss ends the leg', () => {
  const { results } = androidRuns(['lost-emulator-5554 dead-stream'])

  expect(results).toEqual([
    { threw: 'DeviceLost', message: 'emulator dropped off adb and could not be brought back', retry: false },
  ])
}, 15_000)

test('a passed run whose tree dump fails on an emulator adb lost does not count, and starts over', () => {
  const { results, calls } = androidRuns(['drop-tree-emulator-5554', undefined])

  expect(results).toEqual([{ threw: 'DeviceLost', message: 'emulator dropped off adb', retry: true }, { passed: true }])
  // The lost run's video is never pulled.
  expect(calls.filter((line) => line.includes(' pull '))).toHaveLength(1)
}, 15_000)

test('a recovery that would end past the deadline is cut there, and the loss ends the leg', () => {
  // The warm-up session hangs for 60 s; the leg has 3 s left.
  const { results, overrun } = androidRuns(['lost-emulator-5554 hang'], 3_000)

  expect(results).toEqual([
    { threw: 'DeviceLost', message: expect.stringMatching(/^emulator dropped off adb/), retry: false },
  ])
  expect(overrun).toBeLessThan(0)
}, 20_000)

test('the diagnostics after a loss end by the deadline, their own adb call too, and the loss ends the leg', () => {
  // `adb get-state` hangs for 30 s in the diagnostics after an install adb did not find; the leg has 3 s left.
  const { results, overrun, hung } = androidRuns(['lost-emulator-5554 hang-adb'], 3_000)

  expect(results).toEqual([
    {
      threw: 'DeviceLost',
      message: 'emulator dropped off adb, and the leg has no time left to bring it back',
      retry: false,
    },
  ])
  expect(overrun).toBeLessThan(0)
  // The adb call gets the same hard kill as the step around it, which ends 1 s after the deadline at the latest.
  Bun.sleepSync(Math.max(0, 1_500 - overrun))
  expect(hung).toHaveLength(1)
  expect(Bun.spawnSync(['kill', '-0', ...hung]).exitCode).not.toBe(0)
})

// In the next three tests the deadline passes during a run the leg clock admitted in time.
test('a run that ends late on an emulator adb still sees keeps its outcome, a pass with no tree line too', () => {
  const { results, calls } = androidRuns([undefined, 'fail-flow'], -1_000)

  expect(results).toEqual([{ passed: true }, { passed: false, error: 'Element not found: Continue' }])
  // Each failed tree dump, and the failed flow, asked adb once.
  expect(calls.filter((line) => line.endsWith(' get-state'))).toHaveLength(3)
  expect(calls.filter((line) => line.includes(' pull '))).toHaveLength(2)
})

test('a run that ends late on an emulator adb lost ends the leg, after asking adb', () => {
  const { results, calls } = androidRuns(['drop-emulator-5554'], -1_000)

  expect(results).toEqual([
    {
      threw: 'DeviceLost',
      message: 'emulator dropped off adb, and the leg has no time left to bring it back',
      retry: false,
    },
  ])
  expect(calls).toContain('adb -s emulator-5554 get-state')
}, 15_000)

test('a run that ends late while adb never answers is inconclusive, and the leg goes on', () => {
  const { results, overrun } = androidRuns(['fail-flow hang-adb'], -1_000)

  expect(results).toEqual([
    { passed: false, error: "adb never answered about the emulator after the leg's deadline", inconclusive: true },
  ])
  // The probe gets its 10 s past the deadline, and no more.
  expect(overrun).toBeLessThan(15_000)
}, 20_000)

test('a run with no recovery deadline, as fix-native has, fails on a lost emulator without probing adb', () => {
  const { results, calls } = androidRuns(['lost-emulator-5554'], 'never')

  expect(results).toEqual([{ threw: 'ShellError', message: expect.any(String) }])
  expect(calls.filter((line) => / get-state$| devices$/.test(line))).toEqual([])
})

test('a failed flow or install on an emulator adb still sees keeps its own outcome, with nothing recovered', () => {
  const { results, calls, stderr } = androidRuns(['fail-flow', 'full'])

  expect(results).toEqual([
    { passed: false, error: 'Element not found: Continue' },
    { threw: 'ShellError', message: expect.any(String) },
  ])
  expect(calls.filter((line) => / devices$| logcat -v epoch /.test(line))).toEqual([])
  expect(stderr).not.toContain('adb lost')
})
