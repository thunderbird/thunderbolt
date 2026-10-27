/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const native = join(import.meta.dir, 'native.sh')
const work = mkdtempSync(join(tmpdir(), 'qa-native-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

// Unset, so a caller's shell cannot change the defaults a test expects.
const noPorts = {
  QA_FRONTEND_PORT: '',
  QA_ONBOARDING_PORT: '',
  QA_BACKEND_PORT: '',
  QA_PROVIDER_PORT: '',
  QA_MCP_PORT: '',
  QA_GOOGLE_PORT: '',
}

/** `/sdcard` resolves only from the second check on, and Android 16 refuses the push of sample.png. */
const fakeAdb = () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  const script = `#!/bin/bash
echo "$*" >> '${calls}'
case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *"getprop sys.boot_completed") echo 1 ;;
  *"test -d /sdcard/Android")
    [ -f '${bin}/mounted' ] && exit 0
    touch '${bin}/mounted'
    exit 1 ;;
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
  writeFileSync(join(bin, 'bun'), `#!/bin/bash\nprintf '%s\\n' "$@" > '${args}'\n`)
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
  expect(proc.exitCode).toBe(0)
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

/** Launch n runs as pid 400n; only launch `step1At` reaches `[init] step1_`, and 0 means none does. */
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
