/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layout sweep on a device: signs in once, then reaches each state of `nativeStatesFor` with its flow from
// control/sweep/ and checks it two ways, as the web sweep does. The layout probe the QA build carries (its lines in
// the WebView log) and the tree's own rules (`measureNative`) must report nothing, and the screen must match the
// baseline a person approved in sweep-baselines/<platform>/, compared by Maestro's assertScreenshot. A state without
// a baseline only saves its screen under <out>/candidates/. Exits 1 when a state shows a problem, differs from its
// baseline or cannot be reached.
//
//   bun .github/qa/scripts/sweep-native.ts --platform <ios|android> --device <id> --out <dir>
//
// Needs the plain QA build installed on <device>, `stack.sh start native`, and the WebView console streaming into
// $QA_WEBVIEW_LOG (`native.sh logs`, and on iOS `native.sh wait-logs`).
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { keepsProbeLine, measureNative, parseHierarchy } from '../native-layout'
import platforms from '../platforms.json'
import { nativeStatesFor, type NativeSweepState } from './sweep'

const qaDir = resolve(import.meta.dirname, '..')

/** The probe's problem lines in a stretch of the WebView log, once each, minus the ones the tree reports itself. */
export const probeLines = (log: string, platform: 'ios' | 'android') => [
  ...new Set(
    log
      .split('\n')
      .filter((line) => line.includes('[qa-layout]'))
      .map((line) => line.slice(line.indexOf('[qa-layout]')).trim())
      .filter((line) => line !== '[qa-layout] ready' && keepsProbeLine(line, platform)),
  ),
]

// shortcut: a screen-wide similarity threshold, so a change smaller than 3% of the screen (one word of the chat's
// greeting, which follows the hour) passes; crop per state once Maestro's cropOn can name a WebView region.
/**
 * A state's problems: the probe's lines, the tree's rules, and whatever kept them from measuring, so a dead log
 * stream, a failed `maestro hierarchy` or a keyboard that never opened fails the state instead of passing it clean.
 * `tree` is the hierarchy's JSON, undefined when Maestro could not dump it.
 */
export const stateProblems = (opts: {
  log: string
  tree: string | undefined
  platform: 'ios' | 'android'
  keyboard: boolean
}) => {
  const measure = opts.tree === undefined ? undefined : measureNative(parseHierarchy(opts.tree), opts.platform)
  const gaps: [boolean, string][] = [
    [!opts.log.includes('[qa-layout] ready'), '[qa-sweep] the layout probe never reported ready'],
    [measure === undefined, '[qa-sweep] maestro hierarchy failed'],
    [opts.keyboard && measure !== undefined && measure.keyboard === undefined, '[qa-sweep] the keyboard is not open'],
  ]
  return [
    ...probeLines(opts.log, opts.platform),
    ...(measure?.problems ?? []),
    ...gaps.filter(([gap]) => gap).map(([, line]) => line),
  ]
}

const compareFlow = (baseline: string) =>
  `- assertScreenshot:\n    path: ${JSON.stringify(baseline)}\n    thresholdPercentage: 97\n`
// Maestro writes a screenshot only inside the run's --test-output-dir.
const candidateFlow = (name: string) => `- takeScreenshot: ${JSON.stringify(name)}\n`

export type StateResult = {
  state: string
  reached: boolean
  problems: string[]
  screenshot: 'matches' | 'differs' | 'candidate' | 'none'
}

/** One table row per state, and whether the sweep passed. */
export const summarize = (results: StateResult[]) => ({
  ok: results.every((r) => r.problems.length === 0 && (r.screenshot === 'matches' || r.screenshot === 'candidate')),
  lines: [
    '| State | Reached | Layout problems | Screenshot |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.state} | ${r.reached ? 'yes' : '**no**'} | ${r.problems.map((p) => `\`${p}\``).join('<br>') || 'none'} | ${r.screenshot} |`,
    ),
  ],
})

const main = async () => {
  const { values } = parseArgs({
    options: { platform: { type: 'string' }, device: { type: 'string' }, out: { type: 'string' } },
  })
  const { platform, device, out } = values
  if ((platform !== 'ios' && platform !== 'android') || !device || !out) {
    throw new Error('usage: sweep-native.ts --platform <ios|android> --device <id> --out <dir>')
  }
  const webviewLog = Bun.env.QA_WEBVIEW_LOG
  if (!webviewLog) throw new Error('QA_WEBVIEW_LOG must name the WebView console log')
  const appId = platforms.find((entry) => entry.id === platform)?.appId
  const candidates = resolve(out, 'candidates')
  // Per-step screenshots and trees of every run, which show why a flow failed.
  const maestroOut = resolve(out, 'maestro')
  await mkdir(resolve(out, 'flows'), { recursive: true })
  await mkdir(candidates, { recursive: true })
  await mkdir(resolve(out, 'diffs'), { recursive: true })

  const adb = (...args: string[]) => Bun.$`adb -s ${device} shell ${args}`.quiet()
  // A fixed clock and full bars in the status bar, which every screenshot shows.
  const fixStatusBar = async () => {
    if (platform === 'ios') {
      await Bun.$`xcrun simctl status_bar ${device} override --time 9:41 --batteryState charged --batteryLevel 100`
      return
    }
    await adb('settings', 'put', 'global', 'sysui_demo_allowed', '1')
    for (const command of [
      ['enter'],
      ['clock', '-e', 'hhmm', '0941'],
      ['battery', '-e', 'level', '100', '-e', 'plugged', 'false'],
      ['notifications', '-e', 'visible', 'false'],
    ]) {
      await adb('am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', ...command)
    }
  }
  await fixStatusBar()
  // A new font scale redraws the system UI, which leaves demo mode and shows the real clock again.
  const setFontScale = async (scale: string) => {
    await adb('settings', 'put', 'system', 'font_scale', scale)
    await fixStatusBar()
  }

  // The iOS driver sometimes does not start in time, so each flow gets one more try.
  const maestro = async (name: string, body: string, env: string[] = []) => {
    const file = resolve(out, 'flows', `${name}.yaml`)
    await writeFile(file, `appId: ${appId}\n---\n${body}`)
    const attempt = async () => {
      const run = await Bun.$`maestro --udid ${device} test --test-output-dir ${maestroOut} ${env} ${file}`
        .nothrow()
        .quiet()
      await writeFile(resolve(out, `${name}.maestro.log`), run.stdout)
      return run.exitCode === 0
    }
    return (await attempt()) || attempt()
  }

  const screenshotOf = async (name: string): Promise<StateResult['screenshot']> => {
    const baseline = resolve(qaDir, 'sweep-baselines', platform, `${name}.png`)
    if (existsSync(baseline)) {
      if (await maestro(`${name}.screenshot`, compareFlow(baseline))) return 'matches'
      // Maestro writes its diff beside the baseline, and only when it compared: a flow that failed before (a driver
      // that never started) left none, and says nothing about the screen.
      const diff = baseline.replace(/\.png$/, '_diff.png')
      if (!existsSync(diff)) return 'none'
      await rename(diff, resolve(out, 'diffs', `${name}.png`))
      return 'differs'
    }
    if (!(await maestro(`${name}.screenshot`, candidateFlow(name)))) return 'none'
    // It lands in <maestro out>/<time>/<flow>/takeScreenshot/<name>.png.
    const [shot] = await Array.fromAsync(
      new Bun.Glob(`*/${name}.screenshot/takeScreenshot/${name}.png`).scan(maestroOut),
    )
    await Bun.write(resolve(candidates, `${name}.png`), Bun.file(resolve(maestroOut, shot)))
    return 'candidate'
  }

  const signIn = await Bun.file(resolve(qaDir, 'control/stack.yaml')).text()
  if (!(await maestro('sign-in', signIn, ['-e', `EMAIL=sweep-${crypto.randomUUID()}@thunderbolt.test`]))) {
    throw new Error(`the sweep could not sign in; see ${out}/sign-in.maestro.log`)
  }

  const sweepState = async (state: NativeSweepState): Promise<StateResult> => {
    const large = 'large' in state
    if (large) await setFontScale('1.3')
    const offset = (await Bun.file(webviewLog).text()).length
    const flow = await Bun.file(resolve(qaDir, `control/sweep/${state.flow}.yaml`)).text()
    const reached = await maestro(state.name, flow)
    // The probe confirms a problem over 500 ms after the screen settles.
    await Bun.sleep(2000)
    const log = (await Bun.file(webviewLog).text()).slice(offset)
    const tree = await Bun.$`maestro --udid ${device} hierarchy`.nothrow().quiet()
    const problems = stateProblems({
      log,
      tree: tree.exitCode === 0 ? tree.stdout.toString() : undefined,
      platform,
      keyboard: 'keyboard' in state,
    })
    const screenshot = reached ? await screenshotOf(state.name) : 'none'
    return { state: state.name, reached, problems, screenshot }
  }

  const results: StateResult[] = []
  for (const state of nativeStatesFor(platform)) {
    // A large-text state must not leave its font scale to the states after it, even when it throws.
    try {
      results.push(await sweepState(state))
    } finally {
      if ('large' in state) await setFontScale('1.0')
    }
  }
  await writeFile(resolve(out, 'sweep-native.json'), JSON.stringify(results, null, 2))
  const { ok, lines } = summarize(results)
  console.log([`## Layout sweep on ${platform}`, '', ...lines].join('\n'))
  process.exit(ok ? 0 : 1)
}

if (import.meta.main) await main()
