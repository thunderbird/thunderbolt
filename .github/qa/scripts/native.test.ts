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
})
