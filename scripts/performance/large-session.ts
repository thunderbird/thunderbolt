/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTinfoilAttestationRequest } from '../../e2e/tinfoil-isolation'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { chromium, expect, type Browser } from '@playwright/test'
import { getChromeLaunchOptions } from '../chrome'
import { collectPageErrors } from '../../e2e/helpers'
import { installProbe, type BrowserSample, type PerformanceWindow } from './probe'
import { summarizeSample } from './metrics'
import { chromeMetrics, finishTrace, retainedChromeMetrics, traceCategories } from './recording'
import { prepareLargeAccount, validateLargeFixtureOptions } from './large-fixture'
import { runLargeCycle } from './large-journeys'
import { collectCleanupErrors, finalizeReport } from './cleanup'
import { localOrigin, positiveInteger, validateLabel } from './options'

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:1436' },
    label: { type: 'string', default: 'large-session' },
    out: { type: 'string', default: 'qa-out-performance' },
    profile: { type: 'string', default: 'mobile' },
    cpu: { type: 'string', default: '4' },
    chats: { type: 'string', default: '2000' },
    'messages-per-chat': { type: 'string', default: '4' },
    'long-chats': { type: 'string', default: '6' },
    'long-messages': { type: 'string', default: '240' },
    cycles: { type: 'string', default: '12' },
    blocks: { type: 'string', default: '3' },
    trace: { type: 'boolean', default: false },
  },
})
const cpu = Number(values.cpu)
const cycles = positiveInteger('--cycles', values.cycles)
const blocks = positiveInteger('--blocks', values.blocks)
const fixtureOptions = {
  chats: Number(values.chats),
  messagesPerChat: Number(values['messages-per-chat']),
  longChats: Number(values['long-chats']),
  longMessages: Number(values['long-messages']),
}
if (!['desktop', 'mobile'].includes(values.profile)) {
  throw new Error('Invalid --profile')
}
if (!Number.isFinite(cpu) || cpu < 1) {
  throw new Error('Invalid --cpu')
}
validateLargeFixtureOptions(fixtureOptions)
validateLabel(values.label)
values.url = localOrigin(values.url)
const output = resolve(values.out)
await mkdir(output, { recursive: true })
const mobile = values.profile === 'mobile'
const contextOptions = {
  baseURL: values.url,
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  isMobile: mobile,
  hasTouch: mobile,
  deviceScaleFactor: 1,
  locale: 'en-US',
}
type Sample = ReturnType<typeof summarizeSample> & {
  block: number
  cycle: number
  name: string
  taskMs: number
  scriptMs: number
  layoutMs: number
  raw: BrowserSample
}
const report = {
  schemaVersion: 2,
  measurement: 'large-session-v1',
  runnerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runnerDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  capturedAt: new Date().toISOString(),
  label: values.label,
  url: values.url,
  engine: 'chromium',
  browser: '',
  platform: `${process.platform}/${process.arch}`,
  profile: values.profile,
  browserContext: 'ephemeral',
  cpuThrottle: cpu,
  cycles,
  blocks,
  warmupCycles: fixtureOptions.longChats,
  warmupCpuThrottle: 1,
  diagnosticTrace: values.trace,
  attestationDisabled: true,
  httpCacheDisabledByRouting: true,
  driver:
    'Real pointer/keyboard events and scoped DOM predicates polled at 50ms; correctness assertions outside windows',
  retentionScope: 'Chromium renderer GC; dedicated page workers are counted but worker/GPU memory is not measured',
  fixture: null as Awaited<ReturnType<typeof prepareLargeAccount>>['metadata'] | null,
  environment: {} as Record<string, unknown>,
  samples: [] as Sample[],
  snapshots: [] as Record<string, unknown>[],
  pageErrors: [] as string[],
  databaseLogs: [] as string[],
  failure: null as string | null,
  cleanupErrors: [] as string[],
  completed: false,
}

/** Keep one browser context alive through warmup, measured blocks and the final reload. */
const runSession = async (browser: Browser) => {
  const context = await browser.newContext(contextOptions)
  report.browser = browser.version()
  await context.route(isTinfoilAttestationRequest, (route) => route.fulfill({ status: 503, body: '{}' }))
  await context.addInitScript(installProbe)
  const page = context.pages()[0] ?? (await context.newPage())
  page.setDefaultTimeout(60_000)
  const errors = collectPageErrors(page)
  report.pageErrors = errors
  const databaseLogs = report.databaseLogs
  page.on('console', (message) => {
    if (message.type() === 'error' || /Database|SQLite|OPFS|IndexedDB|SharedWorker/i.test(message.text())) {
      databaseLogs.push(message.text())
    }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')

  /** Record comparable neutral-route states; a fresh document is a separate reset observation, not a leak assertion. */
  const snapshot = async (phase: string, neutralPath: string) => {
    await expect(page).toHaveURL(new URL(neutralPath, values.url).href)
    await expect(page.locator('[data-quotable-message-id]')).toHaveCount(0)
    const retained = await retainedChromeMetrics(cdp)
    const dom = await page.evaluate(() => ({
      elements: document.querySelectorAll('*').length,
      canvases: document.querySelectorAll('canvas').length,
      iframes: document.querySelectorAll('iframe').length,
      messageRows: document.querySelectorAll('[data-message-id]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
    }))
    const targets = (
      (await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string }[] }
    ).targetInfos
      .filter(({ type }) => type === 'worker' || type === 'shared_worker')
      .map(({ type, url }) => ({ type, url }))
    report.snapshots.push({
      phase,
      url: page.url(),
      rendererGc: true,
      retained,
      dom,
      dedicatedPageWorkers: page.workers().map((worker) => worker.url()),
      serviceWorkers: context.serviceWorkers().map((worker) => worker.url()),
      chromiumWorkerTargets: targets,
    })
    await page.screenshot({ path: `${output}/${values.label}-${phase}.png` })
    console.log(
      `${phase}: ${retained.heapBytes} heap bytes, ${retained.nodes} nodes, ${retained.listeners} listeners, ${page.workers().length} dedicated workers`,
    )
  }

  let tracing = false
  try {
    const fixture = await prepareLargeAccount(page, fixtureOptions)
    report.fixture = fixture.metadata
    report.environment = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      navigatorPlatform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
      scripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((script) => script.src),
    }))
    const neutralPath = `/chats/${fixture.checkpoint.id}`
    await page.waitForTimeout(1_000)
    await snapshot('prepared', neutralPath)
    for (let cycle = 0; cycle < fixture.longChats.length; cycle++) {
      await runLargeCycle(page, fixture, cycle, async (_name, action, settleMs = 250) => {
        await action()
        await page.waitForTimeout(settleMs)
      })
      console.log(`Warm-up ${cycle + 1}/${fixture.longChats.length} complete`)
    }
    await page.waitForTimeout(1_000)
    await snapshot('warmed', neutralPath)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    if (values.trace) {
      await cdp.send('Tracing.start', { categories: traceCategories, transferMode: 'ReturnAsStream' })
      tracing = true
    }
    for (let block = 1; block <= blocks; block++) {
      for (let cycle = 1; cycle <= cycles; cycle++) {
        await runLargeCycle(page, fixture, cycle - 1, async (name, action, settleMs = 250) => {
          const marker = `block-${block}:cycle-${cycle}:${name}`
          if (values.trace) {
            await page.evaluate((marker) => performance.mark(`${marker}:start`), marker)
          }
          const before = await chromeMetrics(cdp)
          await page.evaluate(() => (window as unknown as PerformanceWindow).__thunderboltPerformance.start())
          await action()
          await page.waitForTimeout(settleMs)
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
              ),
          )
          const raw = await page.evaluate(() =>
            (window as unknown as PerformanceWindow).__thunderboltPerformance.stop(),
          )
          const after = await chromeMetrics(cdp)
          const summary = summarizeSample(raw)
          report.samples.push({
            block,
            cycle,
            name,
            ...summary,
            taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
            layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
            raw,
          })
          if (values.trace) {
            await page.evaluate((marker) => {
              performance.mark(`${marker}:end`)
              performance.measure(marker, `${marker}:start`, `${marker}:end`)
            }, marker)
          }
        })
        console.log(`Block ${block}/${blocks}, cycle ${cycle}/${cycles} complete`)
      }
      await snapshot(`block-${block}`, neutralPath)
    }
    await page.reload()
    await expect(page.locator('textarea')).toBeEditable()
    await page.waitForTimeout(1_500)
    await snapshot('fresh-document', neutralPath)
    if (errors.length) {
      throw new Error(`Uncaught page errors: ${errors.join('\n')}`)
    }
    report.completed = true
  } finally {
    report.cleanupErrors.push(
      ...(await collectCleanupErrors([
        ...(tracing
          ? [
              {
                name: 'trace',
                run: () => finishTrace(cdp, `${output}/${values.label}.trace.json`),
              },
            ]
          : []),
        { name: 'screenshot', run: () => page.screenshot({ path: `${output}/${values.label}-final.png` }) },
      ])),
    )
  }
}

try {
  const browser = await chromium.launch(getChromeLaunchOptions())
  try {
    await runSession(browser)
  } finally {
    report.cleanupErrors.push(...(await collectCleanupErrors([{ name: 'browser', run: () => browser.close() }])))
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await finalizeReport(`${output}/${values.label}.json`, report)
}
console.log(`Saved ${output}/${values.label}.json`)
