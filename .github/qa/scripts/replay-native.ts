/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The device half of the native replay: runs one checked Maestro flow on a fresh install of the app, records
// it, and reads what the WebView and the backend logged meanwhile. `verify.ts replay --native` decides what counts.

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { $ } from 'bun'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { measureNative, parseHierarchy } from '../native-layout'
import { platformOf } from './findings'
import { maestroEnv } from './maestro-flow'
import type { FlowRun, RunFlow } from './verify'

// The probe debounces 250 ms and confirms a problem over 500 ms, as in the gate.
const probeWaitMs = 1200
const nativeSh = join(import.meta.dir, 'native.sh')
const driverTimeout = 'iOS driver not ready in time'
const androidVideo = '/sdcard/qa-replay.mp4'

/** The whole lines appended to `file` from byte `start` on; a line still being written is left out. */
const linesFrom = async (file: string, start: number) => {
  const text = await Bun.file(file).slice(start).text()
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .slice(0, -1)
}

/**
 * The tree's own `[qa-layout]` lines for the screen a run ends on, as the gate adds them in a session: the Android
 * WebView never sees the keyboard, so a field behind it shows only in `maestro hierarchy`, and a control's accessible
 * name comes from the platform's tree. A failed dump adds nothing.
 */
const treeLines = async (deviceId: string, platform: 'ios' | 'android') => {
  const dump = await $`maestro --udid ${deviceId} hierarchy`
    .env({ ...getDefaultEnvironment(), ...maestroEnv() })
    .quiet()
    .nothrow()
  return dump.exitCode === 0 ? measureNative(parseHierarchy(dump.stdout.toString()), platform).problems : []
}

/**
 * A run's video under `<outDir>/videos/`. The leg and the session keep it apart from every other leg's, since the
 * judge and the file job merge every replay leg into one folder.
 */
export const videoPath = (outDir: string, leg: string | undefined, session: string, run: number) =>
  join(outDir, 'videos', `${leg ? `${leg}-` : ''}${session}-run-${run}.mp4`)

/**
 * The real `RunFlow`. Each run uninstalls and reinstalls the app, so no session or draft from an earlier run is left.
 * It installs the onboarding build for a c1 session and the plain one otherwise, the control included. It records
 * the screen into `videoPath` (Android caps a recording at 3 minutes), runs the harness's `signIn` when given and
 * then, if it passed, the flow, both with the same fresh `EMAIL`, waits for the probe to confirm, and
 * splits the new WebView lines into the probe's `layout` lines and the rest; `layout` also gets the tree's lines for
 * the last screen. On Android the install goes through `native.sh install`, which warms the app up.
 */
export const createRunFlow = (opts: {
  platform: 'ios' | 'android'
  deviceId: string
  apps: { onboarding: string; plain: string }
  webviewLog: string
  backendLog: string
  /** The replay leg's name, in each video's name. */
  leg?: string
}): RunFlow => {
  const { platform, deviceId, webviewLog, backendLog, leg } = opts
  const { appId } = platformOf(platform)
  if (!appId) throw new Error(`platforms.json has no app for ${platform}`)
  const ios = platform === 'ios'
  return async (flowYaml, outDir, run, session, signIn): Promise<FlowRun> => {
    // Absolute, because native.sh moves to the repo root before it reads the path.
    const app = resolve(session.startsWith('c1-first-run-') ? opts.apps.onboarding : opts.apps.plain)
    if (ios) {
      await $`xcrun simctl uninstall ${deviceId} ${appId}`.quiet().nothrow()
      await $`xcrun simctl install ${deviceId} ${app}`.quiet()
    } else {
      // The session's install: it removes the app first, then opens it to warm it up.
      await $`${nativeSh} install android ${deviceId} ${app}`.quiet()
    }
    const dir = await mkdtemp(join(tmpdir(), 'qa-flow-'))
    await mkdir(join(outDir, 'videos'), { recursive: true })
    const video = videoPath(outDir, leg, session, run)
    const recorder = Bun.spawn(
      ios
        ? ['xcrun', 'simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', video]
        : ['adb', '-s', deviceId, 'shell', 'screenrecord', '--time-limit', '180', androidVideo],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const webviewStart = Bun.file(webviewLog).size
    const backendStart = Bun.file(backendLog).size
    const email = `qa-replay-${Date.now()}-${run}@thunderbolt.test`
    const maestro = async (name: string, yaml: string) => {
      const file = join(dir, name)
      await Bun.write(file, yaml)
      return $`maestro --udid ${deviceId} test -e EMAIL=${email} ${file}`
        .env({ ...getDefaultEnvironment(), ...maestroEnv() })
        .quiet()
        .nothrow()
    }
    // A separate test in the same launch, so a failed sign-in is known to be the harness's.
    const signedIn = signIn === undefined ? undefined : await maestro('sign-in.yaml', signIn)
    const signInFailed = signedIn !== undefined && signedIn.exitCode !== 0
    const result = signedIn && signInFailed ? signedIn : await maestro('flow.yaml', flowYaml)
    const output = stripVTControlCharacters(`${result.stdout}${result.stderr}`).trim()
    const driverFailed = result.exitCode !== 0 && output.includes(driverTimeout)
    await Bun.sleep(probeWaitMs)
    // A run that never counts skips the dump, which would only eat into the leg's time.
    const tree = signInFailed || driverFailed ? [] : await treeLines(deviceId, platform)
    if (ios) recorder.kill('SIGINT')
    else await $`adb -s ${deviceId} shell pkill -INT screenrecord`.quiet().nothrow()
    await recorder.exited
    if (!ios) {
      await $`adb -s ${deviceId} pull ${androidVideo} ${video}`.quiet().nothrow()
      await $`adb -s ${deviceId} shell rm -f ${androidVideo}`.quiet().nothrow()
    }
    await rm(dir, { recursive: true, force: true })
    const webview = await linesFrom(webviewLog, webviewStart)
    return {
      signInFailed,
      passed: result.exitCode === 0,
      // The whole output, not its tail: a long trace after the driver error must not hide it from the retry.
      error: result.exitCode === 0 ? undefined : driverFailed ? driverTimeout : output.slice(-1_500),
      video,
      layout: [
        ...webview
          .filter((line) => line.includes('[qa-layout]'))
          .map((line) => line.slice(line.indexOf('[qa-layout]')).trim()),
        ...tree,
      ],
      logs: [
        ...webview.filter((line) => !line.includes('[qa-layout]')).map((line) => `webview: ${line}`),
        ...(await linesFrom(backendLog, backendStart)).map((line) => `backend: ${line}`),
      ],
    }
  }
}
