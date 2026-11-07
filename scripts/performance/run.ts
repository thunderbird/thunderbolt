/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { getChromeLaunchOptions } from '../chrome'
import { collectPageErrors } from '../../e2e/helpers'
import { installProbe, type PerformanceWindow } from './probe'
import { summarizeSample } from './metrics'
import { measureOverlayRetention } from './memory'
import { fixtureVersion, prepare, runScenarios } from './scenarios'
import { chromeMetrics, finishTrace, traceCategories } from './recording'
import { collectCleanupErrors, finalizeReport } from './cleanup'
import { localOrigin, positiveInteger, validateLabel } from './options'

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:1436' },
    label: { type: 'string', default: 'current' },
    out: { type: 'string', default: 'qa-out-performance' },
    runs: { type: 'string', default: '3' },
    cpu: { type: 'string', default: '4' },
    profile: { type: 'string', default: 'both' },
    trace: { type: 'boolean', default: false },
  },
})
const runs = positiveInteger('--runs', values.runs)
const cpu = Number(values.cpu)
if (!Number.isFinite(cpu) || cpu < 1) {
  throw new Error('Invalid --cpu')
}
if (!['desktop', 'mobile', 'both'].includes(values.profile)) {
  throw new Error('Invalid --profile')
}
validateLabel(values.label)
values.url = localOrigin(values.url)
const output = resolve(values.out)
await mkdir(output, { recursive: true })

const profiles = values.profile === 'both' ? ['desktop', 'mobile'] : [values.profile]
const runnerRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runnerDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
const browser = await chromium.launch(getChromeLaunchOptions())
const samples: Record<string, unknown>[] = []
const retentionSamples: {
  profile: string
  run: number
  measurement: Awaited<ReturnType<typeof measureOverlayRetention>>
}[] = []
const report = {
  schemaVersion: 3,
  measurement: 'assertion-inclusive-v1',
  fixtureVersion,
  label: values.label,
  runnerRevision,
  runnerDirty,
  capturedAt: new Date().toISOString(),
  browser: browser.version(),
  platform: `${process.platform}/${process.arch}`,
  cpuThrottle: cpu,
  diagnosticTrace: values.trace,
  runs,
  url: values.url,
  completed: false,
  failure: null as string | null,
  cleanupErrors: [] as string[],
  appScripts: [] as string[],
  samples,
  retentionSamples,
}
/** Own each context through setup, measurements and failure artifact capture. */
const runAttempt = async (profile: string, run: number) => {
  const mobile = profile === 'mobile'
  const context = await browser.newContext({
    baseURL: values.url,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 1,
    locale: 'en-US',
  })
  try {
    await context.addInitScript(installProbe)
    const page = await context.newPage()
    const errors = collectPageErrors(page)
    page.setDefaultTimeout(30_000)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    let tracing = false
    try {
      await prepare(page)
      const scripts = await page
        .locator('script[src]')
        .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src))
      if (report.appScripts.length && JSON.stringify(report.appScripts) !== JSON.stringify(scripts)) {
        throw new Error('The served build changed between runs')
      }
      report.appScripts = scripts
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
      await page.waitForTimeout(500)
      if (values.trace) {
        await cdp.send('Tracing.start', { categories: traceCategories, transferMode: 'ReturnAsStream' })
        tracing = true
      }
      await runScenarios(page, async (name, action, settleMs = 350) => {
        if (values.trace) {
          await page.evaluate((label) => performance.mark(`${label}:start`), name)
        }
        const before = await chromeMetrics(cdp)
        await page.evaluate(() => (window as unknown as PerformanceWindow).__thunderboltPerformance.start())
        const started = performance.now()
        await action()
        const actionMs = performance.now() - started
        await page.waitForTimeout(settleMs)
        const raw = await page.evaluate(() => (window as unknown as PerformanceWindow).__thunderboltPerformance.stop())
        const after = await chromeMetrics(cdp)
        const sample = {
          profile,
          run,
          name,
          actionMs,
          ...summarizeSample(raw),
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
          layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
          layoutCount: after.LayoutCount - before.LayoutCount,
          heapBytes: after.JSHeapUsedSize,
          nodes: after.Nodes,
          listeners: after.JSEventListeners,
          raw,
        }
        samples.push(sample)
        console.log(
          `${profile} ${run}/${runs} ${name}: task ${sample.taskMs.toFixed(1)}ms, frame max ${sample.frameMaxMs?.toFixed(1)}ms, ${sample.reactCommits} commits`,
        )
        if (values.trace) {
          await page.evaluate((label) => {
            performance.mark(`${label}:end`)
            performance.measure(label, `${label}:start`, `${label}:end`)
          }, name)
          await page.screenshot({ path: `${output}/${values.label}-${profile}-${run}-${name}.png` })
        }
      })
      retentionSamples.push({ profile, run, measurement: await measureOverlayRetention(page, cdp) })
      if (errors.length) {
        throw new Error(`Uncaught page errors: ${errors.join('\n')}`)
      }
    } finally {
      report.cleanupErrors.push(
        ...(await collectCleanupErrors([
          ...(tracing
            ? [
                {
                  name: 'trace',
                  run: () => finishTrace(cdp, `${output}/${values.label}-${profile}-${run}.trace.json`),
                },
              ]
            : []),
          {
            name: 'screenshot',
            run: () => page.screenshot({ path: `${output}/${values.label}-${profile}-${run}.png` }),
          },
        ])),
      )
    }
  } finally {
    report.cleanupErrors.push(...(await collectCleanupErrors([{ name: 'context', run: () => context.close() }])))
  }
}
try {
  const attempts = profiles.flatMap((profile) =>
    Array.from({ length: runs }, (_, index) => ({ profile, run: index + 1 })),
  )
  for (const { profile, run } of attempts) {
    await runAttempt(profile, run)
  }
  report.completed = true
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await finalizeReport(`${output}/${values.label}.json`, report, [{ name: 'browser', run: () => browser.close() }])
}
console.log(`Saved ${output}/${values.label}.json`)
