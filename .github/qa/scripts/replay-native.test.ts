/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // The run 39373388149 control tree, with the focused Email field moved under the keyboard.
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
      apps: { onboarding: '/apps/onboarding.apk', plain: '/apps/plain.apk' },
      webviewLog: ${JSON.stringify(webviewLog)},
      backendLog: ${JSON.stringify(backendLog)},
    })
    const run = await runFlow('- launchApp\\n', ${JSON.stringify(join(work, 'out'))}, 1, 'c2-chat-power-user-android')
    console.log(JSON.stringify(run.layout))
  `
  const proc = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

  expect(proc.stderr.toString()).toBe('')
  expect(JSON.parse(proc.stdout.toString())).toEqual(['[qa-layout] behind-keyboard textbox "Email"'])
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  expect(log.slice(0, 3)).toEqual([
    'adb -s emulator-5554 uninstall net.thunderbird.thunderbolt',
    'adb -s emulator-5554 install -r /apps/plain.apk',
    'adb -s emulator-5554 shell monkey -p net.thunderbird.thunderbolt -c android.intent.category.LAUNCHER 1',
  ])
  const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line))
  expect(at(/^maestro .* test /)).toBeGreaterThan(at(/am force-stop net\.thunderbird\.thunderbolt$/))
  expect(at(/^maestro .* hierarchy$/)).toBeGreaterThan(at(/^maestro .* test /))
})
