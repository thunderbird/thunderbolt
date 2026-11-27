/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The device half of the native replay: runs one checked Maestro flow on a fresh install of the app, records
// it, and reads what the WebView and the backend logged meanwhile. `verify.ts replay --native` decides what counts.

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { $ } from 'bun'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { keepsProbeLine, measureNative, parseHierarchy } from '../native-layout'
import { platformOf } from './findings'
import { maestroEnv } from './maestro-flow'
import type { FlowRun, RunFlow } from './verify'

// The probe debounces 250 ms and confirms a problem over 500 ms, as in the gate.
const probeWaitMs = 1200
const nativeSh = join(import.meta.dir, 'native.sh')
const driverTimeout = 'iOS driver not ready in time'
const androidVideo = '/sdcard/qa-replay.mp4'
/** How long adb gets to see a lost emulator again before a new one is booted. */
const reconnectSeconds = 30

/**
 * Thrown by an Android run whose emulator dropped off adb, so the run never counts. With `retry` the emulator is back
 * (or a new one stands in) and the run can start again; that happens once per leg. A second loss, or a recovery that
 * fails or would end past the leg's deadline, ends the leg.
 */
export class DeviceLost extends Error {
  readonly retry: boolean
  constructor(message: string, retry = false) {
    super(message)
    this.retry = retry
  }
}

/** A line still being written is left out. */
const linesFrom = async (file: string, start: number) => {
  const text = await Bun.file(file).slice(start).text()
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .slice(0, -1)
}

/**
 * As in the gate: the Android WebView never sees the keyboard, so a field behind it shows only in
 * `maestro hierarchy`, and a control's accessible name comes from the platform's tree. Undefined when the dump failed.
 */
const treeLines = async (deviceId: string, platform: 'ios' | 'android') => {
  const dump = await $`maestro --udid ${deviceId} hierarchy`
    .env({ ...getDefaultEnvironment(), ...maestroEnv() })
    .quiet()
    .nothrow()
  return dump.exitCode === 0 ? measureNative(parseHierarchy(dump.stdout.toString()), platform).problems : undefined
}

/** The leg and the session keep a video apart: the judge and the file job merge every replay leg into one folder. */
export const videoPath = (outDir: string, leg: string | undefined, session: string, run: number) =>
  join(outDir, 'videos', `${leg ? `${leg}-` : ''}${session}-run-${run}.mp4`)

/**
 * Each run uninstalls and reinstalls the app, so no session or draft from an earlier run is left. Android caps a
 * recording at 3 minutes, and its install goes through `native.sh install`, which warms the app up. `layout` gets the
 * tree's lines for the last screen and loses the probe's lines the tree owns (`keepsProbeLine`), as in the gate.
 * With `recoverBy`, an Android install, flow or tree dump that fails while adb no longer sees the emulator throws
 * `DeviceLost`.
 */
export const createRunFlow = (opts: {
  platform: 'ios' | 'android'
  deviceId: string
  apps: { onboarding: string; plain: string }
  webviewLog: string
  backendLog: string
  /** The replay leg's name, in each video's name. */
  leg?: string
  /**
   * The epoch ms by which a recovery from a lost emulator must end, so the leg still has time to save its results.
   * Unset, as for fix-native (whose patched and original apps would both need the new emulator), nothing is recovered.
   */
  recoverBy?: number
}): RunFlow => {
  const { platform, webviewLog, backendLog, leg, recoverBy } = opts
  const { appId } = platformOf(platform)
  if (!appId) throw new Error(`platforms.json has no app for ${platform}`)
  const ios = platform === 'ios'
  const recovers = !ios && recoverBy !== undefined
  const device = { id: opts.deviceId, recovered: false }
  /** adb answers within 10 s that the emulator is ready, not offline or missing. */
  const online = async () =>
    (await $`timeout 10 adb -s ${device.id} get-state`.quiet().nothrow()).stdout.toString().trim() === 'device'
  /** The seconds left before `recoverBy`, for each recovery step's `timeout`, so a hung step ends there. */
  const left = () => {
    const seconds = Math.floor(((recoverBy ?? 0) - Date.now()) / 1000)
    if (seconds < 1) throw new DeviceLost('emulator dropped off adb, and the leg has no time left to bring it back')
    return seconds
  }
  /** As the job's boot: a new emulator (`native.sh device`), then the warm-up Maestro session the job runs on it. */
  const reboot = async () => {
    device.id = (await $`timeout ${left()} ${nativeSh} device android`).text().trim().split('\n').pop() ?? ''
    // The job's last step saves the emulator's log from QA_DEVICE_ID.
    if (Bun.env.GITHUB_ENV) await appendFile(Bun.env.GITHUB_ENV, `QA_DEVICE_ID=${device.id}\n`)
    await $`timeout ${left()} ${nativeSh} install android ${device.id} ${resolve(opts.apps.plain)}`
    const warmUp = join(tmpdir(), 'qa-warm-up.yaml')
    await Bun.write(warmUp, `appId: ${appId}\n---\n- launchApp\n`)
    await $`timeout ${left()} maestro --udid ${device.id} test ${warmUp}`
      .env({ ...getDefaultEnvironment(), ...maestroEnv() })
      .nothrow()
  }
  const recover = async () => {
    const wait = Math.min(reconnectSeconds, left())
    const back = await $`timeout ${wait} adb -s ${device.id} wait-for-device`.quiet().nothrow()
    if (back.exitCode !== 0) await reboot()
    // An adb reset ends the stream, and a new emulator needs one of its own.
    // Not quiet: `lost` drops the error, so adb's own message is the only reason the job log gets.
    await $`timeout ${left()} ${nativeSh} resume-logs ${device.id} ${webviewLog}`
  }
  /** Prints what may explain the loss and, once per leg, gets the emulator back. Always throws. */
  const lost = async (): Promise<never> => {
    await $`${nativeSh} device-lost ${device.id}`.nothrow()
    if (device.recovered) throw new DeviceLost('emulator dropped off adb a second time in this leg')
    device.recovered = true
    try {
      await recover()
    } catch (error) {
      if (error instanceof DeviceLost) throw error
      throw new DeviceLost('emulator dropped off adb and could not be brought back')
    }
    throw new DeviceLost('emulator dropped off adb', true)
  }
  return async (flowYaml, outDir, run, session, signIn): Promise<FlowRun> => {
    const deviceId = device.id
    // Absolute, because native.sh moves to the repo root before it reads the path.
    const app = resolve(session.startsWith('c1-first-run-') ? opts.apps.onboarding : opts.apps.plain)
    if (ios) {
      await $`xcrun simctl uninstall ${deviceId} ${appId}`.quiet().nothrow()
      await $`xcrun simctl install ${deviceId} ${app}`.quiet()
    } else {
      try {
        await $`${nativeSh} install android ${deviceId} ${app}`.quiet()
      } catch (error) {
        // adb fails the install at once when it has lost the emulator, and may see it again by the time it is asked.
        const notFound = error instanceof $.ShellError && /device '[^']+' not found/.test(error.stderr.toString())
        if (!recovers || (!notFound && (await online()))) throw error
        await lost()
      }
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
    /** The run never counts: what it recorded is dropped before the emulator is brought back. */
    const drop = async () => {
      recorder.kill()
      await recorder.exited
      await rm(dir, { recursive: true, force: true })
      return lost()
    }
    if (recovers && result.exitCode !== 0 && !(await online())) await drop()
    const output = stripVTControlCharacters(`${result.stdout}${result.stderr}`).trim()
    const driverFailed = result.exitCode !== 0 && output.includes(driverTimeout)
    await Bun.sleep(probeWaitMs)
    // A run that never counts skips the dump, which would only eat into the leg's time.
    const tree = signInFailed || driverFailed ? [] : await treeLines(deviceId, platform)
    // A dump that failed because adb lost the emulator would let even a passed run count with no layout evidence.
    if (recovers && !tree && !(await online())) await drop()
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
          .map((line) => line.slice(line.indexOf('[qa-layout]')).trim())
          .filter((line) => keepsProbeLine(line, platform)),
        ...(tree ?? []),
      ],
      logs: [
        ...webview.filter((line) => !line.includes('[qa-layout]')).map((line) => `webview: ${line}`),
        ...(await linesFrom(backendLog, backendStart)).map((line) => `backend: ${line}`),
      ],
    }
  }
}
