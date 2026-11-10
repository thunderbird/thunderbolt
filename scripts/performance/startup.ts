/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { chromium, expect, type Page } from '@playwright/test'
import { getChromeLaunchOptions } from '../chrome'
import { collectPageErrors } from '../../e2e/helpers'
import { fixtureVersion, prepare } from './scenarios'
import { installProbe, type PerformanceWindow } from './probe'
import { summarizeSample } from './metrics'
import { chromeMetrics, finishTrace, traceCategories } from './recording'
import { collectCleanupErrors, finalizeReport } from './cleanup'
import { localOrigin, positiveInteger, validateLabel } from './options'
import { createTransferRecorder } from './transfers'

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:1436' },
    label: { type: 'string', default: 'startup' },
    out: { type: 'string', default: 'qa-out-performance' },
    runs: { type: 'string', default: '3' },
    cpu: { type: 'string', default: '4' },
    profile: { type: 'string', default: 'mobile' },
    chat: { type: 'string', default: 'new' },
    cache: { type: 'string', default: 'preserve' },
    trace: { type: 'boolean', default: false },
  },
})
const runs = positiveInteger('--runs', values.runs)
const cpu = Number(values.cpu)
if (!Number.isFinite(cpu) || cpu < 1) {
  throw new Error('Invalid --cpu')
}
if (
  !['desktop', 'mobile'].includes(values.profile) ||
  !['new', 'long'].includes(values.chat) ||
  !['preserve', 'cold'].includes(values.cache)
) {
  throw new Error('Invalid --profile, --chat or --cache')
}
validateLabel(values.label)
values.url = localOrigin(values.url)
const output = resolve(values.out)
await mkdir(output, { recursive: true })

/** CDP counters include renderer work only; parser/compiler attribution remains in the diagnostic trace. */
const cpuDelta = (before: Record<string, number>, after: Record<string, number>) => ({
  taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
  scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
  layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
  styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
  layoutCount: after.LayoutCount - before.LayoutCount,
})

/** Measure navigation through real input handling, followed by a separate one-second background-work window. */
const measureStartup = async (page: Page, run: number, phase: 'cold-signed-out' | 'returning', path: string) => {
  const cdp = await page.context().newCDPSession(page)
  const logs: string[] = []
  const errors = collectPageErrors(page)
  const log = (message: { text: () => string }) => {
    const text = message.text()
    if (/^\[(init|startup)\]/.test(text)) {
      logs.push(text)
    }
  }
  page.on('console', log)
  const transfers = createTransferRecorder()
  cdp.on('Network.requestWillBeSent', transfers.request)
  cdp.on('Network.responseReceivedExtraInfo', transfers.extraInfo)
  cdp.on('Network.responseReceived', transfers.response)
  cdp.on('Network.requestServedFromCache', transfers.cached)
  cdp.on('Network.loadingFinished', transfers.finished)
  cdp.on('Network.loadingFailed', transfers.failed)
  await cdp.send('Network.enable')
  // Playwright routing disables the HTTP cache globally; blocking one background service preserves cache behavior.
  await cdp.send('Network.setBlockedURLs', { urls: ['*://atc.tinfoil.sh/*'] })
  if (values.cache === 'cold') {
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  }
  await cdp.send('Performance.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const artifact = `${output}/${values.label}-${run}-${phase}`
  if (values.trace) {
    await cdp.send('Tracing.start', {
      categories: `${traceCategories},loading,disabled-by-default-v8.compile`,
      transferMode: 'ReturnAsStream',
    })
  }
  try {
    const before = await chromeMetrics(cdp)
    await page.goto(path, { waitUntil: 'commit' })
    const selector = phase === 'returning' ? 'textarea' : 'input[placeholder="Email"]'
    const control = await page.waitForFunction(
      (selector) => {
        const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
        if (!element || element.disabled || element.readOnly) {
          return false
        }
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height || rect.top >= innerHeight || rect.bottom <= 0) {
          return false
        }
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          if (Number(style.opacity) === 0 || style.visibility === 'hidden') {
            return false
          }
        }
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        if (document.elementFromPoint(x, y) !== element) {
          return false
        }
        return { x, y, at: performance.now() }
      },
      selector,
      { polling: 'raf' },
    )
    const point = await control.jsonValue()
    if (!point) {
      throw new Error('The ready input did not return its position')
    }
    if (values.profile === 'mobile') {
      await page.touchscreen.tap(point.x, point.y)
    } else {
      await page.mouse.click(point.x, point.y)
    }
    const text = phase === 'returning' ? 'x' : 'startup-probe@thunderbolt.test'
    if (phase === 'returning') {
      await page.keyboard.type(text)
    } else {
      await page.keyboard.insertText(text)
    }
    await page.waitForFunction(
      ({ selector, text, phase }) => {
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
        const submit = document.querySelector<HTMLButtonElement>(
          phase === 'returning' ? 'button[aria-label="Send message"]' : 'button[type="submit"]',
        )
        return input?.value === text && submit && !submit.disabled
      },
      { selector, text, phase },
      { polling: 'raf' },
    )
    const usableMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              performance.mark('harness:startup-usable')
              setTimeout(() => resolve(performance.now()), 0)
            }),
          ),
        ),
    )
    const ready = await chromeMetrics(cdp)
    const boot = await page.evaluate(() => {
      const probe = (window as unknown as PerformanceWindow).__thunderboltPerformance
      const result = probe.stop()
      probe.start()
      return result
    })
    await page.waitForTimeout(1000)
    const tail = await page.evaluate(() => (window as unknown as PerformanceWindow).__thunderboltPerformance.stop())
    const settled = await chromeMetrics(cdp)
    const transferSnapshot = transfers.snapshot()
    const timing = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      navigatorPlatform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      mobilePlatformHint: /Android/.test(navigator.userAgent)
        ? 'android'
        : /iPhone|iPad/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 0)
          ? 'ios'
          : null,
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      paints: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
      marks: performance
        .getEntriesByType('mark')
        .filter((entry) => /^(thunderbolt:|harness:)/.test(entry.name))
        .map((entry) => entry.toJSON()),
      resources: performance.getEntriesByType('resource').map((entry) => entry.toJSON()),
      scripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((script) => script.src),
    }))
    await expect(page.locator(selector)).toHaveValue(text)
    await expect(page.locator(selector)).toBeFocused()
    if (phase === 'returning' && values.chat === 'long') {
      await expect(page.getByRole('heading', { name: 'Performance answer 120', exact: true })).toBeVisible()
    }
    if (errors.length) {
      throw new Error(`Uncaught page errors: ${errors.join('\n')}`)
    }
    const result = {
      run,
      phase,
      controlReadyMs: point.at,
      usableMs,
      boot: { ...summarizeSample(boot), ...cpuDelta(before, ready), raw: boot },
      postReady: { ...summarizeSample(tail), ...cpuDelta(ready, settled), raw: tail },
      timing,
      transfers: transferSnapshot,
      initLogs: [...logs],
      heapBytes: settled.JSHeapUsedSize,
      nodes: settled.Nodes,
      listeners: settled.JSEventListeners,
    }
    console.log(
      `${run}/${runs} ${phase}: usable ${usableMs.toFixed(0)}ms, boot task ${result.boot.taskMs.toFixed(0)}ms, post-ready task ${result.postReady.taskMs.toFixed(0)}ms`,
    )
    return result
  } finally {
    report.cleanupErrors.push(
      ...(await collectCleanupErrors([
        ...(values.trace ? [{ name: 'trace', run: () => finishTrace(cdp, `${artifact}.trace.json`) }] : []),
        { name: 'screenshot', run: () => page.screenshot({ path: `${artifact}.png` }) },
        { name: 'CPU reset', run: () => cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }) },
      ])),
    )
    page.off('console', log)
    // Keep the service block active during untimed fixture setup; closing the context releases this session.
  }
}

/** Persistent profiles retain the real local DB/auth state across a complete browser and SharedWorker shutdown. */
const launchProfile = async (profilePath: string) => {
  const mobile = values.profile === 'mobile'
  const context = await chromium.launchPersistentContext(profilePath, {
    ...getChromeLaunchOptions(),
    baseURL: values.url,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    locale: 'en-US',
  })
  try {
    await context.addInitScript(installProbe, true)
    const page = context.pages()[0] ?? (await context.newPage())
    if (page.url() !== 'about:blank') {
      throw new Error('The browser restored a page before startup instrumentation was installed')
    }
    page.setDefaultTimeout(30_000)
    return { context, page }
  } catch (error) {
    report.cleanupErrors.push(...(await collectCleanupErrors([{ name: 'context', run: () => context.close() }])))
    throw error
  }
}

const report = {
  schemaVersion: 2,
  measurement: 'startup-v1',
  capturedAt: new Date().toISOString(),
  runnerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runnerDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  browser: '',
  platform: `${process.platform}/${process.arch}`,
  url: values.url,
  profile: values.profile,
  cpuThrottle: cpu,
  runs,
  returningChat: values.chat,
  httpCache: values.cache,
  network: 'unshaped-loopback',
  attestationBlocked: true,
  diagnosticTrace: values.trace,
  fixtureVersion,
  postReadyWindowMs: 1000,
  resourceScope: 'Page-target CDP and Resource Timing; worker-internal requests may be absent',
  completed: false,
  failure: null as string | null,
  cleanupErrors: [] as string[],
  samples: [] as Awaited<ReturnType<typeof measureStartup>>[],
}
try {
  for (const run of Array.from({ length: runs }, (_, index) => index + 1)) {
    const profilePath = await mkdtemp(join(tmpdir(), 'thunderbolt-startup-'))
    try {
      const cold = await launchProfile(profilePath)
      const fixture = await (async () => {
        try {
          report.browser = cold.context.browser()!.version()
          report.samples.push(await measureStartup(cold.page, run, 'cold-signed-out', '/'))
          return await prepare(cold.page)
        } finally {
          report.cleanupErrors.push(
            ...(await collectCleanupErrors([{ name: 'cold context', run: () => cold.context.close() }])),
          )
        }
      })()
      const returning = await launchProfile(profilePath)
      try {
        report.samples.push(
          await measureStartup(
            returning.page,
            run,
            'returning',
            values.chat === 'long' ? `/chats/${fixture.longChatId}` : '/chats/new',
          ),
        )
        // Verify the fixture survived the complete browser shutdown; setup and this check are outside timing.
        await returning.page.goto(`/chats/${fixture.longChatId}`)
        await expect(returning.page.getByRole('heading', { name: 'Performance answer 120', exact: true })).toBeVisible()
      } finally {
        report.cleanupErrors.push(
          ...(await collectCleanupErrors([{ name: 'returning context', run: () => returning.context.close() }])),
        )
      }
    } finally {
      report.cleanupErrors.push(
        ...(await collectCleanupErrors([
          { name: 'profile', run: () => rm(profilePath, { recursive: true, force: true }) },
        ])),
      )
    }
  }
  report.completed = true
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await finalizeReport(`${output}/${values.label}.json`, report, [])
}
console.log(`Saved ${output}/${values.label}.json`)
