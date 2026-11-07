/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chromium, firefox, type Browser, type Page } from 'playwright'
import { INIT_SCRIPT, READ_SNAPSHOT, RESET_RENDERS } from './inject'
import type {
  BrowserName,
  ConsoleSample,
  HeapDelta,
  InitTimingMark,
  LoafSample,
  LongTaskSample,
  NetworkSample,
  RenderStat,
  ScenarioReport,
  WebVitalSample,
} from './types'
import type { ScenarioDef } from './scenarios'
import { collectA11y } from '../probes/a11y'
import { collectHeapDelta } from '../probes/heap'
import { collectNetwork } from './network'

const NAV_TIMEOUT = 45_000
const TAURI_NOISE = ['__TAURI__', 'tauri', '__TAURI_INTERNALS__', 'convertFileSrc']

type SnapshotShape = {
  vitals: WebVitalSample[]
  loaf: LoafSample[]
  longTasks: LongTaskSample[]
  renders: RenderStat[]
  commits: number
}

export const launchBrowser = (name: BrowserName): Promise<Browser> =>
  (name === 'firefox' ? firefox : chromium).launch({ headless: true })

/** Retain failures before the biggest unique requests so the report cap cannot hide network errors. */
const dedupeNetwork = (samples: NetworkSample[]): NetworkSample[] => {
  const seen = new Set<string>()
  const unique = samples.filter((s) => {
    const key = `${s.method} ${s.url} ${s.status}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique
    .sort((a, b) => {
      const aFailed = a.status === 0 || a.status >= 400
      const bFailed = b.status === 0 || b.status >= 400
      return Number(bFailed) - Number(aFailed) || b.transferSizeBytes - a.transferSizeBytes
    })
    .slice(0, 60)
}

const readSnapshot = async (page: Page): Promise<SnapshotShape> => (await page.evaluate(READ_SNAPSHOT)) as SnapshotShape

/** Drive one scenario in one browser and return its structured report. */
export const collectScenario = async (
  browser: Browser,
  browserName: BrowserName,
  baseUrl: string,
  scenario: ScenarioDef,
  runDir: string,
): Promise<ScenarioReport> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  let networkRecorder: ReturnType<typeof collectNetwork> | undefined
  try {
    const url = baseUrl + scenario.path
    // Warm Vite's transforms and lazy route chunks in a separate document; the
    // measured page still gets fresh startup instrumentation and render counters.
    const warmup = await context.newPage()
    try {
      await warmup.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
    } finally {
      await warmup.close()
    }
    const page = await context.newPage()
    await page.addInitScript({ content: INIT_SCRIPT })

    const consoleSamples: ConsoleSample[] = []
    const pageErrors: string[] = []
    const network = collectNetwork(page)
    networkRecorder = network

    page.on('console', (msg) => {
      const level = msg.type()
      if (level !== 'error' && level !== 'warning') return
      const text = msg.text()
      if (TAURI_NOISE.some((n) => text.includes(n))) return
      consoleSamples.push({ level, text: text.slice(0, 500), location: msg.location()?.url })
    })
    page.on('pageerror', (err) => {
      if (TAURI_NOISE.some((n) => err.message.includes(n))) return
      pageErrors.push(err.message.slice(0, 500))
    })

    const startedAt = new Date().toISOString()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    await page.locator('textarea, main, [role="main"]').first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT })

    await page.waitForTimeout(500)

    if (scenario.interact) await scenario.interact(page)
    await page.waitForTimeout(400)

    // Read the cumulative snapshot (load + interaction) BEFORE resetting — the
    // reset below would otherwise wipe the render tallies we want here.
    const snapshot = await readSnapshot(page)

    // Scan the state produced by the scenario, including any open dialog or menu.
    const a11y = await collectA11y(page)

    // Return to a truly idle tree BEFORE measuring noise renders. A scenario's
    // interaction may leave a Radix overlay (dialog/popover/menu) open; the probe's
    // own Escape below would then CLOSE it, recording a legitimate exit-animation
    // (framer-motion/Radix `Presence` re-rendering per frame across the whole
    // portal tree) as "idle" re-renders — a false-positive storm. Dismiss any open
    // overlay and let exit animations settle so the counters zero from idle.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-state="open"]'), undefined, { timeout: 1_000 })
    await page.waitForTimeout(400)

    // Noise-render probe: zero the counters, perform an interaction unrelated to
    // any specific component, and see which components re-render anyway. Anything
    // that commits here is a strong unnecessary-render candidate.
    await page.evaluate(RESET_RENDERS)
    await page.mouse.move(640, 400)
    await page.keyboard.press('Escape')
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(300)
    const noise = await readSnapshot(page)

    const initTiming = (await page.evaluate(
      `(() => performance.getEntriesByType('mark').map((m) => ({ name: m.name, startTime: Math.round(m.startTime) })))()`,
    )) as InitTimingMark[]

    const heap: HeapDelta[] = []
    if (browserName === 'chromium') {
      const delta = await collectHeapDelta(page, `${scenario.name}-renav`, async () => {
        await page.goto(baseUrl + '/chats/new', { waitUntil: 'domcontentloaded' })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
      })
      if (delta) heap.push(delta)
    }

    const screenshotPath = `${runDir}/${scenario.name}.${browserName}.png`
    await page.screenshot({ path: screenshotPath })

    const snap = snapshot
    return {
      scenario: scenario.name,
      browser: browserName,
      url,
      startedAt,
      vitals: snap.vitals,
      loaf: snap.loaf,
      longTasks: snap.longTasks,
      renders: snap.renders,
      noiseRenders: noise.renders,
      network: dedupeNetwork(await network.finish()),
      console: consoleSamples,
      heap,
      a11y,
      initTiming,
      pageErrors,
      screenshotPath,
    }
  } finally {
    networkRecorder?.dispose()
    await context.close()
  }
}
