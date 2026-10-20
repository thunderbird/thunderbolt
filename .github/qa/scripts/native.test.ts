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

/**
 * A stand-in `adb` for a booted emulator that logs every call: `/sdcard` resolves only from the second check on, as
 * after `sys.boot_completed` on the runner, and Android 16 refuses the push of sample.png.
 */
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
  // A log stream that attaches and then waits to be stopped, and a bun that only records its arguments.
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
  const proc = Bun.spawnSync(['bash', native, 'device', 'android'], { env: { ...process.env, ...env } })
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

test('install android opens the app once and stops it when the init got past the storage check', () => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const calls = join(bin, 'calls.log')
  // The process shows up on the second look, and its init logs step1 on the second read of its log.
  const script = `#!/bin/bash
echo "$*" >> '${calls}'
count() { echo x >> '${bin}/'"$1"; wc -l < '${bin}/'"$1"; }
case "$*" in
  *"shell pidof net.thunderbird.thunderbolt") [ "$(count pidof)" -ge 2 ] && echo 4129 || exit 1 ;;
  *"logcat -d --pid=4129"*)
    echo 'I Tauri/Console: Msg: [init] step0_5_storage_check: 5023ms'
    [ "$(count logcat)" -ge 2 ] && echo 'I Tauri/Console: Msg: [init] step1_create_app_dir: 399ms' ;;
esac
exit 0
`
  writeFileSync(join(bin, 'adb'), script)
  chmodSync(join(bin, 'adb'), 0o755)
  const proc = Bun.spawnSync(['bash', native, 'install', 'android', 'emulator-5554', '/apps/app-debug.apk'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  expect(proc.stderr.toString()).toBe('')
  expect(proc.exitCode).toBe(0)
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  expect(log[0]).toBe('-s emulator-5554 install -r /apps/app-debug.apk')
  expect(log[1]).toStartWith('-s emulator-5554 shell monkey -p net.thunderbird.thunderbolt ')
  expect(log.filter((line) => line.includes('logcat -d --pid=4129'))).toHaveLength(2)
  expect(log.at(-1)).toBe('-s emulator-5554 shell am force-stop net.thunderbird.thunderbolt')
})

test('a QA build may reach the stack and c7 PowerSync, over HTTP and WebSocket', async () => {
  const out = join(work, 'tauri.conf.json')
  const proc = Bun.spawnSync(['bash', native, 'config', 'android', out])
  expect(proc.exitCode).toBe(0)
  const sources = (await Bun.file(out).json()).app.security.csp['connect-src'].split(' ')
  for (const source of ['http://localhost:8005', 'http://localhost:18081', 'ws://localhost:18081'])
    expect(sources).toContain(source)
})
