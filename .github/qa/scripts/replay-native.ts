/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The device half of the native replay (spec 6.4): runs one checked Maestro flow on a fresh install of the app, records
// it, and reads what the WebView and the backend logged meanwhile. `verify.ts replay --native` decides what counts.

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { $ } from 'bun'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { platformOf } from './findings'
import { maestroEnv } from './maestro-flow'
import type { FlowRun, RunFlow } from './verify'

// The probe debounces 250 ms and confirms a problem over 500 ms, as in the gate.
const probeWaitMs = 1200
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
 * The real `RunFlow`. Each run uninstalls and reinstalls the app, so no session or draft from an earlier run is left
 * (review focus 5): the onboarding build for a c1 session (Ruling 9), the plain one otherwise, the control included.
 * It records the screen into `<outDir>/videos/run-<n>.mp4` (Android caps a recording at 3 minutes), runs the flow with
 * a fresh `EMAIL`, waits for the probe to confirm, and splits the new WebView lines into the probe's `layout` lines and
 * the rest.
 */
export const createRunFlow = (opts: {
  platform: 'ios' | 'android'
  deviceId: string
  apps: { onboarding: string; plain: string }
  webviewLog: string
  backendLog: string
}): RunFlow => {
  const { platform, deviceId, webviewLog, backendLog } = opts
  const appId = platformOf(platform).appId ?? ''
  const ios = platform === 'ios'
  return async (flowYaml, outDir, run, session): Promise<FlowRun> => {
    const app = session.startsWith('c1-first-run-') ? opts.apps.onboarding : opts.apps.plain
    if (ios) {
      await $`xcrun simctl uninstall ${deviceId} ${appId}`.quiet().nothrow()
      await $`xcrun simctl install ${deviceId} ${app}`.quiet()
    } else {
      await $`adb -s ${deviceId} uninstall ${appId}`.quiet().nothrow()
      await $`adb -s ${deviceId} install ${app}`.quiet()
    }
    const dir = await mkdtemp(join(tmpdir(), 'qa-flow-'))
    const flowFile = join(dir, 'flow.yaml')
    await Bun.write(flowFile, flowYaml)
    await mkdir(join(outDir, 'videos'), { recursive: true })
    const video = join(outDir, 'videos', `run-${run}.mp4`)
    const recorder = Bun.spawn(
      ios
        ? ['xcrun', 'simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', video]
        : ['adb', '-s', deviceId, 'shell', 'screenrecord', '--time-limit', '180', androidVideo],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const webviewStart = Bun.file(webviewLog).size
    const backendStart = Bun.file(backendLog).size
    const email = `qa-replay-${Date.now()}-${run}@thunderbolt.test`
    const result = await $`maestro --udid ${deviceId} test -e EMAIL=${email} ${flowFile}`
      .env({ ...getDefaultEnvironment(), ...maestroEnv() })
      .quiet()
      .nothrow()
    await Bun.sleep(probeWaitMs)
    if (ios) recorder.kill('SIGINT')
    else await $`adb -s ${deviceId} shell pkill -INT screenrecord`.quiet().nothrow()
    await recorder.exited
    if (!ios) {
      await $`adb -s ${deviceId} pull ${androidVideo} ${video}`.quiet().nothrow()
      await $`adb -s ${deviceId} shell rm -f ${androidVideo}`.quiet().nothrow()
    }
    await rm(dir, { recursive: true, force: true })
    const webview = await linesFrom(webviewLog, webviewStart)
    const output = stripVTControlCharacters(`${result.stdout}${result.stderr}`).trim()
    return {
      passed: result.exitCode === 0,
      error: result.exitCode === 0 ? undefined : output.slice(-1_500),
      video,
      layout: webview
        .filter((line) => line.includes('[qa-layout]'))
        .map((line) => line.slice(line.indexOf('[qa-layout]')).trim()),
      logs: [
        ...webview.filter((line) => !line.includes('[qa-layout]')).map((line) => `webview: ${line}`),
        ...(await linesFrom(backendLog, backendStart)).map((line) => `backend: ${line}`),
      ],
    }
  }
}
