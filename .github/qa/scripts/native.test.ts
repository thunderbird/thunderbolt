/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = join(import.meta.dir, 'native.sh')
const work = mkdtempSync(join(tmpdir(), 'qa-native-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

// The port variables are unset so a caller's shell cannot change the defaults a test expects.
const noPorts = {
  QA_FRONTEND_PORT: '',
  QA_ONBOARDING_PORT: '',
  QA_BACKEND_PORT: '',
  QA_PROVIDER_PORT: '',
  QA_MCP_PORT: '',
  QA_GOOGLE_PORT: '',
}

test.each(['', '8105'])('native Cloud sign-in uses the QA backend port %s', (port) => {
  // Execute the native script's real shared environment setup without starting a build or simulator.
  const setup = readFileSync(native, 'utf8').split('\nfixtures=')[0]
  const proc = Bun.spawnSync(['bash', '-e', '-c', `${setup}\nprintf '%s\\n' "\${frontend_env[@]}"`, native], {
    env: { ...process.env, ...noPorts, QA_BACKEND_PORT: port },
  })
  expect(proc.exitCode).toBe(0)
  const values = proc.stdout.toString().trim().split('\n')
  const backend = `http://localhost:${port || '8005'}/v1`
  expect(values).toContain(`VITE_THUNDERBOLT_CLOUD_URL=${backend}`)
  expect(values).toContain(`VITE_THUNDERBOLT_CLOUD_SERVICE_URL=${backend}`)
})

/** `/sdcard` resolves only from the second check on, and Android 16 refuses the push of sample.png. */
const fakeAdb = ({ ignoresSettings = false, refusesBroadcast = false } = {}) => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  const script = `#!/bin/bash
echo "$*" >> '${calls}'
case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  # CRLF, and a trailing OK as adb's emulator console prints, must not hide the name.
  *"getprop ro.boot.qemu.avd_name") printf 'qa-android\\r\\nOK\\r\\n' ;;
  *"getprop sys.boot_completed") echo 1 ;;
  *"test -d /sdcard/Android")
    [ -f '${bin}/mounted' ] && exit 0
    touch '${bin}/mounted'
    exit 1 ;;
  *"settings put global hide_error_dialogs 1")
    ${ignoresSettings ? 'exit 0' : `touch '${bin}/hidden'`} ;;
  *"settings get global hide_error_dialogs")
    [ -f '${bin}/hidden' ] && echo 1 || echo null ;;
  *"am broadcast "*)
    ${refusesBroadcast ? 'echo "java.lang.SecurityException: permission denied" >&2; exit 1' : 'exit 0'} ;;
  *"push "*sample.png*) echo "adb: error: failed to copy: Operation not permitted" >&2; exit 1 ;;
esac
exit 0
`
  writeFileSync(join(bin, 'adb'), script)
  writeFileSync(join(bin, 'avdmanager'), '#!/bin/bash\necho qa-android\n')
  for (const tool of ['adb', 'avdmanager']) chmodSync(join(bin, tool), 0o755)
  return { env: { PATH: `${bin}:${process.env.PATH}`, ANDROID_AVD_HOME: join(work, 'avd') }, calls }
}

test('verify-run hands verify.ts the app, the fp from the result name and the original app, then stops its log stream', () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const args = join(bin, 'bun-args')
  writeFileSync(join(bin, 'xcrun'), "#!/bin/bash\necho 'Filtering the log data'\nsleep 3\n")
  // Exits 3, an inconclusive verdict, which the workflow tells apart from a failure.
  writeFileSync(join(bin, 'bun'), `#!/bin/bash\nprintf '%s\\n' "$@" "$QA_WEBVIEW_LOG" > '${args}'\nexit 3\n`)
  for (const tool of ['xcrun', 'bun']) chmodSync(join(bin, tool), 0o755)
  const result = join(work, 'out', 'ab12cd34.ios.verify.json')
  const proc = Bun.spawnSync(
    [
      'bash',
      native,
      'verify-run',
      'ios',
      'UDID-1',
      '/apps/patched.app',
      'qa-out/s/repro/1.yaml',
      's',
      result,
      '/apps/original.app',
    ],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_BACKEND_LOG: '/dev/null' } },
  )
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(3)
  const passed = readFileSync(args, 'utf8').trim().split('\n')
  const after = (flag: string) => passed[passed.indexOf(flag) + 1]
  expect(passed.slice(0, 2)).toEqual(['.github/qa/scripts/verify.ts', 'fix-native'])
  expect([after('--app'), after('--fp'), after('--original'), after('--result')]).toEqual([
    '/apps/patched.app',
    'ab12cd34',
    '/apps/original.app',
    result,
  ])
  expect(Bun.spawnSync(['pgrep', '-f', `${bin}/xcrun`]).stdout.toString()).toBe('')
  // The stream's log stays beside the result, which the workflow uploads, so a dead stream shows.
  const webviewLog = join(work, 'out', 'ab12cd34.ios.verify.webview.log')
  expect(passed.at(-1)).toBe(webviewLog)
  expect(readFileSync(webviewLog, 'utf8')).toContain('Filtering the log data')
})

// The pipeline's failure before the patched app runs, so the workflow must read it as inconclusive, and every other
// `die` (2) as a failure.
test('verify-run exits with the inconclusive code when the iOS stream never attaches, before verify.ts runs', () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const ran = join(bin, 'bun-ran')
  writeFileSync(join(bin, 'xcrun'), '#!/bin/bash\nexec /bin/sleep 30\n')
  writeFileSync(join(bin, 'bun'), `#!/bin/bash\ntouch '${ran}'\n`)
  // The first call stamps the stream's start, every later one is long past its budget; the waits do not wait.
  const clock = join(bin, 'clock')
  writeFileSync(join(bin, 'date'), `#!/bin/bash\n[ -f '${clock}' ] && echo 1000 || { touch '${clock}'; echo 0; }\n`)
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n')
  for (const tool of ['xcrun', 'bun', 'date', 'sleep']) chmodSync(join(bin, tool), 0o755)
  const result = join(work, 'never', 'ab12cd34.ios.json')
  const args = ['verify-run', 'ios', 'UDID-1', '/apps/patched.app', 'qa-out/s/repro/1.yaml', 's', result]
  const proc = Bun.spawnSync(['bash', native, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_BACKEND_LOG: '/dev/null' },
  })

  expect(proc.stderr.toString()).toContain('the log stream never attached')
  expect(proc.exitCode).toBe(3)
  expect(existsSync(ran)).toBe(false)
  expect(Bun.spawnSync(['pgrep', '-f', `${bin}/xcrun`]).stdout.toString()).toBe('')
})

test('device android waits for /sdcard, pushes each fixture alone and only warns when a push is refused', () => {
  const { env, calls } = fakeAdb()
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...noPorts, ...env } })
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line))

  expect(proc.stderr.toString()).toContain('sample.png')
  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString()).toBe('emulator-5554\n')
  // Not mounted, then mounted in the wait loop, then the check after it.
  expect(log.filter((line) => line.endsWith('test -d /sdcard/Android'))).toHaveLength(3)
  const pushes = log.filter((line) => line.includes(' push '))
  expect(pushes.map((line) => line.split(' ').at(-2)?.split('/').at(-1)).sort()).toEqual(['sample.pdf', 'sample.png'])
  expect(at(/ push /)).toBeGreaterThan(log.lastIndexOf('-s emulator-5554 shell test -d /sdcard/Android'))
  expect(at(/ push /)).toBeGreaterThan(at(/mkdir -p \/sdcard\/Download/))
  // c7's PowerSync too, so the app on the emulator can sync.
  expect(log).toContain('-s emulator-5554 reverse tcp:18081 tcp:18081')
})

test('device android hides system error dialogs and closes a showing one before it maps ports or pushes files', () => {
  const { env, calls } = fakeAdb()
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...noPorts, ...env } })
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  const at = (text: string) => log.findIndex((line) => line.endsWith(text))
  const put = at('settings put global hide_error_dialogs 1')

  expect(proc.exitCode).toBe(0)
  const readBack = at('settings get global hide_error_dialogs')
  expect(put).toBeGreaterThan(at('getprop sys.boot_completed'))
  expect(at('am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS')).toBeGreaterThan(put)
  expect(readBack).toBeGreaterThan(put)
  expect(readBack).toBeLessThan(log.findIndex((line) => line.includes(' reverse ')))
})

test('device android goes on with a warning when the system refuses the dialog-closing broadcast', () => {
  const { env, calls } = fakeAdb({ refusesBroadcast: true })
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...noPorts, ...env } })
  const log = readFileSync(calls, 'utf8')

  expect(proc.exitCode).toBe(0)
  expect(proc.stderr.toString()).toContain('could not close a system dialog')
  expect(log).toContain('settings get global hide_error_dialogs')
  expect(log).toContain(' reverse ')
})

test('device android fails when the emulator does not keep hide_error_dialogs, before anything else runs on it', () => {
  const { env, calls } = fakeAdb({ ignoresSettings: true })
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...noPorts, ...env } })
  const log = readFileSync(calls, 'utf8')

  expect(proc.exitCode).not.toBe(0)
  expect(proc.stderr.toString()).toContain('ignored hide_error_dialogs')
  expect(log).not.toContain(' reverse ')
  expect(log).not.toContain(' push ')
})

test('device android reverses the stack ports it is configured with', () => {
  const { env, calls } = fakeAdb()
  const ports = { QA_BACKEND_PORT: '8105', QA_PROVIDER_PORT: '9978', QA_MCP_PORT: '9979', QA_GOOGLE_PORT: '9980' }
  Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...noPorts, ...env, ...ports } })
  const reversed = readFileSync(calls, 'utf8')
    .split('\n')
    .filter((line) => line.includes(' reverse '))
  expect(reversed).toEqual(
    ['8105', '9978', '9979', '9980', '18081'].map((port) => `-s emulator-5554 reverse tcp:${port} tcp:${port}`),
  )
})

/** Runs until it is stopped, like an emulator. */
const emulatorStub = "#!/bin/bash\nsleep 20 &\ntrap 'kill $!; exit 0' TERM\nwait\n"
/** Starts `command` in the background of a shell that exits, as an earlier step leaves the emulator, and returns its pid. */
const detached = (command: string) =>
  Bun.spawnSync(['bash', '-c', `${command} > /dev/null 2>&1 & echo $!`])
    .stdout.toString()
    .trim()
/** Sends SIGTERM to each pid a test started, so nothing outlives the test. */
const stop = (...pids: string[]) => Bun.spawnSync(['kill', ...pids])

/** The command line `pid` runs. */
const commandLine = (pid: string) => Bun.spawnSync(['ps', '-ww', '-o', 'args=', '-p', pid]).stdout.toString()

/**
 * adb lists emulator-5554, the emulator it lost, as offline, and a new boot as emulator-5556 once the pid file no
 * longer names `previous`.
 */
const offlineEmulator = () => {
  const dir = mkdtempSync(join(work, 'offline-'))
  const bin = join(dir, 'bin')
  const pidFile = join(dir, 'qa-emulator.pid')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash
case "$*" in
  devices)
    printf 'List of devices attached\\nemulator-5554\\toffline\\n'
    [ "$(cat '${pidFile}')" = "$(cat '${dir}/previous')" ] || printf 'emulator-5556\\tdevice\\n' ;;
  *"getprop ro.boot.qemu.avd_name") printf 'qa-android\\r\\nOK\\r\\n' ;;
  *"getprop sys.boot_completed" | *"settings get global hide_error_dialogs") echo 1 ;;
esac
exit 0
`,
  )
  writeFileSync(join(bin, 'avdmanager'), '#!/bin/bash\necho qa-android\n')
  writeFileSync(join(bin, 'emulator'), emulatorStub)
  for (const tool of ['adb', 'avdmanager', 'emulator']) chmodSync(join(bin, tool), 0o755)
  const boot = (previous: string) => {
    for (const file of [pidFile, join(dir, 'previous')]) writeFileSync(file, `${previous}\n`)
    const proc = Bun.spawnSync(['bash', native, 'device', 'android'], {
      env: {
        ...process.env,
        ...noPorts,
        PATH: `${bin}:${process.env.PATH}`,
        ANDROID_AVD_HOME: join(dir, 'avd'),
        TMPDIR: dir,
      },
    })
    return { proc, booted: readFileSync(pidFile, 'utf8').trim() }
  }
  return { bin, boot }
}

test('device android stops our emulator adb lost and boots a new one on the next console port, taking its serial', () => {
  const { bin, boot } = offlineEmulator()
  const ours = detached(`bash '${bin}/emulator' -avd qa-android -no-window`)

  const { proc, booted } = boot(ours)

  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString()).toBe('emulator-5556\n')
  expect(running(ours)).toBe(false)
  expect(booted).not.toBe(ours)
  expect(running(booted)).toBe(true)
  expect(commandLine(booted)).toContain(' -avd qa-android -port 5556 ')
  stop(booted)
})

test('device android leaves alone a recorded pid that now runs another program', () => {
  const { boot } = offlineEmulator()
  const other = detached('sleep 10')

  const { proc, booted } = boot(other)

  expect(proc.exitCode).toBe(0)
  expect(running(other)).toBe(true)
  stop(other, booted)
})

type OtherEmulator = { serial: string; name: string; console?: string; booting?: boolean }

/**
 * Boots our AVD beside `others`, emulators that run another AVD. Each one's name probe reads `name` (empty for an
 * image that does not set it) and its console answers `console` (nothing when unset). It is online from the start
 * or, with `booting`, from the boot's first poll. adb lists our boot as `ours` from its second poll, and its name
 * probe reads empty. `sleep` returns at once. Returns how the boot ended and the emulator's arguments.
 */
const bootBeside = (ours: string, others: OtherEmulator[] = []) => {
  const dir = mkdtempSync(join(work, 'boot-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const booted = `[ -f '${dir}/qa-emulator.pid' ]`
  const rows = others.map(({ serial, booting }) => `${booting ? `${booted} && ` : ''}printf '${serial}\\tdevice\\n'`)
  for (const { serial, name, console } of others) {
    writeFileSync(join(dir, `name-${serial}`), name)
    if (console) writeFileSync(join(dir, `console-${serial}`), `${console}\r\nOK\r\n`)
  }
  writeFileSync(
    join(bin, 'adb'),
    `#!/bin/bash
case "$*" in
  devices)
    printf 'List of devices attached\\n'
    ${rows.join('\n    ')}
    if ${booted}; then
      [ -f '${dir}/polled' ] && printf '${ours}\\tdevice\\n'
      : > '${dir}/polled'
    fi ;;
  *"getprop ro.boot.qemu.avd_name") cat "${dir}/name-$2" 2> /dev/null; printf '\\r\\n' ;;
  *" emu avd name") cat "${dir}/console-$2" 2> /dev/null ;;
  *"getprop sys.boot_completed" | *"settings get global hide_error_dialogs") echo 1 ;;
esac
exit 0
`,
  )
  writeFileSync(join(bin, 'avdmanager'), '#!/bin/bash\necho qa-android\n')
  writeFileSync(join(bin, 'emulator'), `#!/bin/bash\necho "$*" > '${dir}/emulator-args'\nexec /bin/sleep 20\n`)
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n')
  for (const tool of ['adb', 'avdmanager', 'emulator', 'sleep']) chmodSync(join(bin, tool), 0o755)
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], {
    env: {
      ...process.env,
      ...noPorts,
      PATH: `${bin}:${process.env.PATH}`,
      ANDROID_AVD_HOME: join(dir, 'avd'),
      TMPDIR: dir,
    },
  })
  stop(readFileSync(join(dir, 'qa-emulator.pid'), 'utf8').trim())
  return { proc, args: readFileSync(join(dir, 'emulator-args'), 'utf8') }
}

test('device android boots our AVD on console port 5554 and takes emulator-5554, though its name reads empty', () => {
  const { proc, args } = bootBeside('emulator-5554')

  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString()).toBe('emulator-5554\n')
  expect(args).toStartWith('-avd qa-android -port 5554 ')
})

test('device android boots on the first free console port and never takes another AVD, named or not', () => {
  const { proc, args } = bootBeside('emulator-5558', [
    { serial: 'emulator-5554', name: '' },
    { serial: 'emulator-5556', name: 'pixel-other', console: 'pixel-other' },
    // What a boot once took: an emulator that came online during it, with no name and a console that answers KO.
    { serial: 'emulator-5560', name: '', console: 'KO: unknown command', booting: true },
  ])

  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString()).toBe('emulator-5558\n')
  expect(args).toStartWith('-avd qa-android -port 5558 ')
})

test("device-lost prints adb's state, whether the emulator runs and only counts from its log", () => {
  const dir = mkdtempSync(join(work, 'lost-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'adb'), `#!/bin/bash\necho "error: device '$2' not found" >&2\nexit 1\n`, { mode: 0o755 })
  const gone = Bun.spawnSync(['true']).pid
  writeFileSync(join(dir, 'qa-emulator.pid'), `${gone}\n`)
  const crashes = [
    'ERROR        | Failed to open the gRPC port',
    'qemu-system-x86_64: terminating on signal 15 from pid 2319',
  ]
  const log = [
    'INFO         | Android emulator version 36.1.9.0',
    crashes[0],
    'WARNING      | Your GPU may have a bug',
    crashes[1],
  ]
  writeFileSync(join(dir, 'qa-emulator.log'), `${log.join('\n')}\nINFO         | Boot completed in 41237 ms\n`)

  const proc = Bun.spawnSync(['bash', native, 'device-lost', 'emulator-5554', '10'], {
    env: { ...process.env, ...noPorts, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir },
  })
  const out = proc.stderr.toString()

  expect(proc.exitCode).toBe(0)
  expect(proc.stdout.toString()).toBe('')
  expect(out).toStartWith("adb lost emulator-5554; adb's state for it now: error: device 'emulator-5554' not found\n")
  expect(out).toContain(`the emulator (pid ${gone}) is gone\n`)
  expect(out.split("lines of the emulator's log per crash signature:\n")[1]).toBe(
    '  error: 1\n  terminating on signal: 1\n',
  )
  for (const line of crashes) expect(out).not.toContain(line)
})

test('a boot whose emulator exits prints only counts from its log, never its lines', () => {
  const dir = mkdtempSync(join(work, 'exited-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'adb'), '#!/bin/bash\n[ "$1" = devices ] && echo "List of devices attached"\nexit 0\n')
  writeFileSync(join(bin, 'avdmanager'), '#!/bin/bash\necho qa-android\n')
  const fatal = 'FATAL        | KVM is not available for the user who asked: /dev/kvm'
  writeFileSync(join(bin, 'emulator'), `#!/bin/bash\necho '${fatal}'\nexit 1\n`)
  for (const tool of ['adb', 'avdmanager', 'emulator']) chmodSync(join(bin, tool), 0o755)

  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], {
    env: {
      ...process.env,
      ...noPorts,
      PATH: `${bin}:${process.env.PATH}`,
      ANDROID_AVD_HOME: join(dir, 'avd'),
      TMPDIR: dir,
    },
  })

  expect(proc.exitCode).toBe(2)
  expect(proc.stderr.toString()).toBe(
    "lines of the emulator's log per crash signature:\n  fatal: 1\n  kvm: 1\nthe emulator exited\n",
  )
})

test('resume-logs appends a new stream and stops the old one only while its pid still writes the log', () => {
  const dir = mkdtempSync(join(work, 'resume-'))
  const bin = join(dir, 'bin')
  const calls = join(dir, 'calls.log')
  mkdirSync(bin)
  // A stream runs until it is stopped.
  const stream = `#!/bin/bash\necho "$*" >> '${calls}'\nsleep 20 &\ntrap 'kill $!; exit 0' TERM\nwait\n`
  writeFileSync(join(bin, 'adb'), stream, { mode: 0o755 })
  const file = join(dir, 'webview.log')
  const before = '1764200000.123  4129  4129 I Tauri/Console: before the loss\n'
  writeFileSync(file, before)
  /** Records `old` as the stream's pid, resumes, and returns the new stream's pid. */
  const resume = (old: string) => {
    writeFileSync(`${file}.pid`, `${old}\n`)
    const proc = Bun.spawnSync(['bash', native, 'resume-logs', 'emulator-5556', file], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    expect(proc.exitCode).toBe(0)
    return readFileSync(`${file}.pid`, 'utf8').trim()
  }
  // Its arguments name logcat, but it writes elsewhere.
  const other = detached("exec -a 'adb logcat -v epoch' sleep 10")

  const first = resume(other)
  const second = resume(first)

  expect(running(other)).toBe(true)
  // Only Linux has /proc to tell which file a pid writes; elsewhere the old stream is left running.
  expect(running(first)).toBe(process.platform !== 'linux')
  expect(running(second)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(readFileSync(calls, 'utf8')).toBe('-s emulator-5556 logcat -v epoch -T 1 -s Tauri/Console:*\n'.repeat(2))
  stop(other, first, second)
})

/**
 * An SDK whose sdkmanager fails its first `failures` installs the way a corrupt download does, leaving a partial
 * download and a half-written image behind. Each install logs whether the previous attempt's leftovers are still there.
 */
const systemImage = (failures: number) => {
  const sdk = mkdtempSync(join(work, 'sdk-'))
  const bin = join(sdk, 'cmdline-tools/latest/bin')
  mkdirSync(bin, { recursive: true })
  const calls = join(sdk, 'calls.log')
  const script = `#!/bin/bash
[ "$1" = --licenses ] && exit 0
image='${sdk}/'"\${3//;//}"
leftovers=$(ls -A '${sdk}/.downloadIntermediates' "$image" 2>/dev/null | tr -d '\\n')
echo "$* leftovers=$leftovers" >> '${calls}'
[ "$(wc -l < '${calls}')" -gt ${failures} ] && exit 0
mkdir -p '${sdk}/.downloadIntermediates' "$image"
touch '${sdk}/.downloadIntermediates/image.zip' "$image/system.img"
echo 'Warning: An error occurred while preparing SDK package Google APIs Intel x86_64 Atom System Image: Error on ZipFile unknown archive.' >&2
exit 1
`
  writeFileSync(join(bin, 'sdkmanager'), script, { mode: 0o755 })
  const proc = Bun.spawnSync(['bash', native, 'system-image'], { env: { ...process.env, ANDROID_HOME: sdk } })
  return { proc, installs: readFileSync(calls, 'utf8').trim().split('\n') }
}

test('system-image clears a corrupt download and installs once more', () => {
  const { proc, installs } = systemImage(1)
  expect(proc.exitCode).toBe(0)
  expect(installs).toHaveLength(2)
  expect(installs[0]).toMatch(/^--install emulator system-images;android-36;google_apis;\S+ leftovers=$/)
  // The retry starts from nothing: neither the partial zip nor the half-written image is left.
  expect(installs[1]).toBe(installs[0])
})

test('system-image fails after the second failed install', () => {
  const { proc, installs } = systemImage(2)
  expect(proc.exitCode).not.toBe(0)
  expect(installs).toHaveLength(2)
})

// What weekly run 45888816735 logged when the runner's DNS dropped during the iOS build.
const swiftpmFetchError =
  "  error: Git command 'git -C /Users/runner/Library/Caches/org.swift.swiftpm/repositories/swift-rs-16819c90 config --get remote.origin.url' failed: fatal: cannot change to '/Users/runner/Library/Caches/org.swift.swiftpm/repositories/swift-rs-16819c90': No such file or directory"

/**
 * An iOS build whose first `failures` runs print `error` to stderr and exit 64 + their run number, so the first
 * exits 65 and the second 66. `sleep` returns at once.
 */
const iosBuild = (error: string, failures: number) => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  writeFileSync(join(bin, 'error.txt'), `${error}\n`)
  const script = `#!/bin/bash
echo "$*" >> '${calls}'
run=$(grep -c '^tauri' '${calls}')
[ "$run" -gt ${failures} ] && exit 0
cat '${bin}/error.txt' >&2
exit $((64 + run))
`
  writeFileSync(join(bin, 'bun'), script, { mode: 0o755 })
  writeFileSync(join(bin, 'sleep'), `#!/bin/bash\necho "sleep $*" >> '${calls}'\n`, { mode: 0o755 })
  const setup = readFileSync(native, 'utf8').split('\nusage=')[0]
  const log = join(bin, 'build.log')
  const proc = Bun.spawnSync(['bash', '-c', `${setup}\nretry_swiftpm_fetch "$1" bun tauri ios build`, native, log], {
    env: { ...process.env, ...noPorts, PATH: `${bin}:${process.env.PATH}` },
  })
  return { proc, log, calls: readFileSync(calls, 'utf8').trim().split('\n') }
}

test('the iOS build runs once more after a SwiftPM fetch lost the network, and passes when that build does', () => {
  const { proc, log, calls } = iosBuild(swiftpmFetchError, 1)
  expect(proc.exitCode).toBe(0)
  expect(calls).toEqual(['tauri ios build', 'sleep 10', 'tauri ios build'])
  // The first build's output still reaches the job log, and the saved log has it too.
  expect(proc.stdout.toString()).toContain(swiftpmFetchError)
  expect(readFileSync(log, 'utf8')).toContain(swiftpmFetchError)
})

test('the iOS build fails at once with its own exit code on any other error', () => {
  const { proc, calls } = iosBuild('error[E0425]: cannot find value `device` in this scope', 1)
  expect(proc.exitCode).toBe(65)
  expect(calls).toEqual(['tauri ios build'])
})

test('the iOS build fails with the second exit code when the SwiftPM fetch loses the network twice', () => {
  const { proc, calls } = iosBuild(swiftpmFetchError, 2)
  expect(proc.exitCode).toBe(66)
  expect(calls).toEqual(['tauri ios build', 'sleep 10', 'tauri ios build'])
})

/**
 * Launch n runs as pid 400n. The first pidof look finds no pid and later ones find it, even from launch 2 on when
 * a slow machine spent launch 1's 1 s on one look. Only launch `step1At` reaches `[init] step1_`, and 0 means none.
 */
const warmUp = (step1At: number) => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  const script = `#!/bin/bash
echo "$*" >> '${calls}'
count() { echo x >> '${bin}/'"$1"; wc -l < '${bin}/'"$1" | tr -d ' '; }
launches() { [ -f '${bin}/monkey' ] && wc -l < '${bin}/monkey' | tr -d ' ' || echo 0; }
case "$*" in
  *" shell monkey "*) count monkey > /dev/null ;;
  *"shell pidof net.thunderbird.thunderbolt")
    [ "$(launches)" -gt 1 ] || [ "$(count pidof)" -ge 2 ] && echo "400$(launches)" || exit 1 ;;
  *"logcat -d --pid=400"*)
    echo 'I Tauri/Console: Msg: [init] step0_5_storage_check: 5035ms'
    [ "$(launches)" = ${step1At} ] && echo 'I Tauri/Console: Msg: [init] step1_create_app_dir: 399ms' ;;
esac
exit 0
`
  writeFileSync(join(bin, 'adb'), script)
  chmodSync(join(bin, 'adb'), 0o755)
  const proc = Bun.spawnSync(['bash', native, 'install', 'android', 'emulator-5554', '/apps/app-debug.apk'], {
    env: { ...process.env, ...noPorts, PATH: `${bin}:${process.env.PATH}`, QA_WARM_SECONDS: '1' },
  })
  return { proc, log: readFileSync(calls, 'utf8').trim().split('\n') }
}

const forceStop = '-s emulator-5554 shell am force-stop net.thunderbird.thunderbolt'

test('install android relaunches the app until a launch gets past the storage check, then stops it', () => {
  const { proc, log } = warmUp(2)
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  // A fresh install, so the session sees the first-run screens a replay run sees.
  expect(log.slice(0, 2)).toEqual([
    '-s emulator-5554 uninstall net.thunderbird.thunderbolt',
    '-s emulator-5554 install -r /apps/app-debug.apk',
  ])
  const launches = log.flatMap((line, at) =>
    line.includes(' shell monkey -p net.thunderbird.thunderbolt ') ? [at] : [],
  )
  expect(launches).toHaveLength(2)
  // The stalled first launch is stopped before the second, which reads its own pid's log.
  expect(log.slice(launches[0], launches[1])).toContain(forceStop)
  expect(log.slice(launches[1])).toContain('-s emulator-5554 logcat -d --pid=4002 -s Tauri/Console:*')
  expect(log.at(-1)).toBe(forceStop)
})

test('install android maps the stack ports again before the first launch, since an adb reset drops them', () => {
  const { proc, log } = warmUp(2)
  expect(proc.exitCode).toBe(0)
  const firstLaunch = log.findIndex((line) => line.includes(' shell monkey '))
  expect(log.slice(2, firstLaunch)).toEqual(
    ['8005', '9878', '9879', '9880', '18081'].map((port) => `-s emulator-5554 reverse tcp:${port} tcp:${port}`),
  )
})

test('install ios removes the app first, so the session starts on the first-run screens a replay run sees', () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  // simctl fails to uninstall an app that is not there, which must not stop the install.
  writeFileSync(join(bin, 'xcrun'), `#!/bin/bash\necho "$*" >> '${calls}'\n[ "$2" != uninstall ]\n`)
  chmodSync(join(bin, 'xcrun'), 0o755)
  const proc = Bun.spawnSync(['bash', native, 'install', 'ios', 'SIM-1', '/apps/Thunderbolt Dev.app'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  expect(proc.exitCode).toBe(0)
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
    'simctl uninstall SIM-1 net.thunderbird.thunderbolt.dev',
    'simctl install SIM-1 /apps/Thunderbolt Dev.app',
  ])
})

test('install android fails with the last storage check line when 4 launches never get past it', () => {
  const { proc, log } = warmUp(0)
  expect(proc.exitCode).toBe(2)
  expect(proc.stderr.toString()).toContain('4 launches')
  expect(proc.stderr.toString()).toContain('[init] step0_5_storage_check: 5035ms')
  expect(log.filter((line) => line.includes(' shell monkey '))).toHaveLength(4)
  expect(log.at(-1)).toBe(forceStop)
}, 15_000)

test('a QA build may reach the stack and c7 PowerSync, over HTTP and WebSocket', async () => {
  const out = join(work, 'tauri.conf.json')
  const proc = Bun.spawnSync(['bash', native, 'config', 'android', out], { env: { ...process.env, ...noPorts } })
  expect(proc.exitCode).toBe(0)
  const sources = (await Bun.file(out).json()).app.security.csp['connect-src'].split(' ')
  for (const source of ['http://localhost:8005', 'http://localhost:18081', 'ws://localhost:18081'])
    expect(sources).toContain(source)
})

test('a QA build reaches the backend and fake Google on the ports it is configured with', async () => {
  const out = join(work, 'tauri-ports.conf.json')
  const env = { ...process.env, ...noPorts, QA_BACKEND_PORT: '8105', QA_GOOGLE_PORT: '9980' }
  expect(Bun.spawnSync(['bash', native, 'config', 'android', out], { env }).exitCode).toBe(0)
  const sources = (await Bun.file(out).json()).app.security.csp['connect-src'].split(' ')
  expect(sources).toContain('http://localhost:8105')
  expect(sources).toContain('http://127.0.0.1:9980')
  expect(sources).not.toContain('http://localhost:8005')
})

/**
 * `xcrun` fakes the log stream: it records its pid and prints the header on launch `headerOn` (0 means never). `sleep`
 * returns at once and is counted, so the 60 s and 120 s budgets are counted, not waited. The streams' own idle wait
 * uses /bin/sleep. `date` starts at the time a test sets and moves 1 s per 5 counted sleeps, as the real clock would.
 */
const fakeLogStream = (headerOn: number, attachAfterSleeps = 0) => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const pids = join(bin, 'pids')
  const sleeps = join(bin, 'sleeps')
  // The header waits for that many more counted sleeps, so a stream can attach late in fake time.
  writeFileSync(
    join(bin, 'xcrun'),
    `#!/bin/bash
echo $$ >> '${pids}'
if [ "$(wc -l < '${pids}' | tr -d ' ')" = ${headerOn} ]; then
  if [ ${attachAfterSleeps} -gt 0 ]; then
    seen=$(cat '${sleeps}' 2> /dev/null | wc -l)
    while [ $(($(cat '${sleeps}' 2> /dev/null | wc -l) - seen)) -lt ${attachAfterSleeps} ]; do /bin/sleep 0.01; done
  fi
  echo 'Filtering the log data'
fi
exec /bin/sleep 30
`,
  )
  writeFileSync(join(bin, 'sleep'), `#!/bin/bash\necho x >> '${sleeps}'\n`)
  writeFileSync(join(bin, 'date'), `#!/bin/bash\necho $((FAKE_NOW + $(cat '${sleeps}' 2> /dev/null | wc -l) / 5))\n`)
  for (const tool of ['xcrun', 'sleep', 'date']) chmodSync(join(bin, tool), 0o755)
  const file = join(bin, 'webview.log')
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [])
  const run = (command: 'logs' | 'wait-logs', now = 1000) =>
    Bun.spawnSync(['bash', native, command, ...(command === 'logs' ? ['ios'] : []), 'UDID-1', file], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NOW: String(now) },
    })
  return { run, file, pids: () => lines(pids), sleeps: () => lines(sleeps).filter(Boolean).length }
}

/** A zombie of a stream that was killed counts as gone. */
const running = (pid: string) =>
  !['', 'Z'].includes(Bun.spawnSync(['ps', '-o', 'stat=', '-p', pid]).stdout.toString().trim()[0] ?? '')

test('logs ios creates the replacement log before its background stream is scheduled', () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const file = join(bin, 'webview.log')
  const gate = join(bin, 'start-stream')
  writeFileSync(file, 'Filtering the log data from an old stream\n')
  writeFileSync(join(bin, 'xcrun'), "#!/bin/bash\nprintf 'Filtering the log data from the new stream\\n'\n", {
    mode: 0o755,
  })
  expect(Bun.spawnSync(['mkfifo', gate]).exitCode).toBe(0)
  const setup = readFileSync(native, 'utf8').split('\nusage=')[0]
  const stream = setup.match(/^  xcrun simctl spawn .* &$/m)?.[0]
  expect(stream).toBeDefined()
  // Hold the child before its real redirection, reproducing a scheduler that runs the parent first.
  const paused = setup.replace(stream!, `  ( read -r releaseStream < "$3";\n${stream!.slice(0, -2)}\n  ) &`)
  const proc = Bun.spawnSync(
    [
      'bash',
      '-e',
      '-c',
      `${paused}\nstart_ios_stream UDID-1 "$1" "$2"\nstatus=0\n[[ -f "$1" && ! -s "$1" ]] || status=1\nprintf 'go\\n' > "$2"\nwait "$(cat "$1.pid")"\nexit "$status"\n`,
      native,
      file,
      gate,
    ],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe('Filtering the log data from the new stream\n')
  expect(running(readFileSync(`${file}.pid`, 'utf8').trim())).toBe(false)
})

test('logs ios returns at once, before the header shows, and leaves the stream running', () => {
  const { run, file, pids, sleeps } = fakeLogStream(0)
  const proc = run('logs')
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  expect(sleeps()).toBe(0)
  expect(pids()).toHaveLength(1)
  expect(readFileSync(`${file}.pid`, 'utf8').trim()).toBe(pids()[0])
  expect(readFileSync(`${file}.start`, 'utf8').trim()).toBe('1000')
  expect(running(pids()[0])).toBe(true)
  Bun.spawnSync(['bash', native, 'stop-logs', file])
  expect(running(pids()[0])).toBe(false)
  expect(existsSync(`${file}.start`)).toBe(false)
})

test('wait-logs replaces a stream that is silent after 60 s and keeps the second one running', () => {
  const { run, file, pids, sleeps } = fakeLogStream(2)
  run('logs')
  const proc = run('wait-logs')
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  expect(pids()).toHaveLength(2)
  // The replacement attached before its own 60 s budget ran out (600 sleeps would be the give-up path).
  expect(sleeps()).toBeGreaterThanOrEqual(300)
  expect(sleeps()).toBeLessThan(600)
  expect(readFileSync(`${file}.pid`, 'utf8').trim()).toBe(pids()[1])
  expect(running(pids()[0])).toBe(false)
  expect(running(pids()[1])).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('Filtering the log data')
  Bun.spawnSync(['bash', native, 'stop-logs', file])
  expect(running(pids()[1])).toBe(false)
})

test('wait-logs gives up after 120 s with no header and leaves no stream running', () => {
  const { run, file, pids, sleeps } = fakeLogStream(0)
  run('logs')
  const proc = run('wait-logs')
  expect(proc.stderr.toString()).toBe('the log stream never attached\n')
  expect(proc.exitCode).toBe(2)
  expect(pids()).toHaveLength(2)
  expect(sleeps()).toBe(600)
  expect(pids().some(running)).toBe(false)
  expect(existsSync(`${file}.pid`)).toBe(false)
})

test('wait-logs counts the first stream from its start, but the replacement gets its own 60 s', () => {
  const { run, file, pids, sleeps } = fakeLogStream(0)
  run('logs')
  const proc = run('wait-logs', 1061)
  expect(proc.stderr.toString()).toBe('the log stream never attached\n')
  expect(pids()).toHaveLength(2)
  expect(sleeps()).toBe(300)
  expect(pids().some(running)).toBe(false)
  expect(existsSync(`${file}.pid`)).toBe(false)
})

test('wait-logs still lets a replacement attach after 20 s when setup already took over 120 s', () => {
  const { run, file, pids } = fakeLogStream(2, 100)
  run('logs')
  const proc = run('wait-logs', 1130)
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  expect(pids()).toHaveLength(2)
  expect(running(pids()[1])).toBe(true)
  Bun.spawnSync(['bash', native, 'stop-logs', file])
})
