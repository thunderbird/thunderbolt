/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTinfoilAttestationRequest } from '../../e2e/tinfoil-isolation'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { getChromeLaunchOptions } from '../chrome'
import { collectPageErrors } from '../../e2e/helpers'
import { performanceStreamMetadata } from '../../e2e/streaming-fixture'
import { installProbe, type PerformanceWindow } from './probe'
import { percentile, summarizeSample } from './metrics'
import { fixtureVersion, prepare } from './scenarios'
import { defaultJourneyNames, journeyNames, runJourney, type Journey } from './journeys'
import { chromeMetrics, finishTrace, retainedChromeMetrics, traceCategories } from './recording'
import { collectCleanupErrors, finalizeReport, type CleanupStep } from './cleanup'
import { localOrigin, positiveInteger, validateLabel } from './options'

const { values } = parseArgs({
  options: {
    before: { type: 'string', default: 'http://localhost:1436' },
    after: { type: 'string', default: 'http://localhost:1437' },
    label: { type: 'string', default: 'paired' },
    out: { type: 'string', default: 'qa-out-performance' },
    pairs: { type: 'string', default: '3' },
    cpu: { type: 'string', default: '4' },
    profile: { type: 'string', default: 'mobile' },
    journeys: { type: 'string', default: defaultJourneyNames.join(',') },
    stream: { type: 'string', default: 'long' },
    trace: { type: 'boolean', default: false },
  },
})
const pairs = positiveInteger('--pairs', values.pairs)
const cpu = Number(values.cpu)
const journeys = values.journeys.split(',') as Journey[]
if (!Number.isFinite(cpu) || cpu < 1) {
  throw new Error('Invalid --cpu')
}
if (!['desktop', 'mobile'].includes(values.profile)) {
  throw new Error('Invalid --profile')
}
if (!['long', 'short'].includes(values.stream)) {
  throw new Error('Invalid --stream')
}
if (journeys.some((journey) => !journeyNames.includes(journey)) || new Set(journeys).size !== journeys.length) {
  throw new Error('Invalid --journeys')
}
if (journeys.includes('first-token') && values.stream !== 'long') {
  throw new Error('The first-token journey requires --stream long')
}
validateLabel(values.label)
values.before = localOrigin(values.before)
values.after = localOrigin(values.after)
const output = resolve(values.out)
await mkdir(output, { recursive: true })
const runnerRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runnerDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
const cleanup: CleanupStep[] = []
const samples: (ReturnType<typeof summarizeSample> & {
  pair: number
  variant: string
  name: string
  taskMs: number
  scriptMs: number
  layoutMs: number
  heapBytes: number
  nodes: number
  listeners: number
})[] = []
const report = {
  schemaVersion: 3,
  measurement: 'paired-targeted-v1',
  label: values.label,
  runnerRevision,
  runnerDirty,
  attestationDisabled: true,
  capturedAt: new Date().toISOString(),
  browser: '',
  platform: `${process.platform}/${process.arch}`,
  cpuThrottle: cpu,
  profile: values.profile,
  pairs,
  journeys,
  firstTokenMilestone: journeys.includes('first-token')
    ? 'Coordinate send to the first visible heading in the new assistant reply; stream completion is outside the window'
    : undefined,
  diagnosticTrace: values.trace,
  fixtureVersion,
  stream: values.stream === 'long' ? performanceStreamMetadata : { name: 'short-word-stream-v1', delayMs: 150 },
  urls: { before: values.before, after: values.after },
  attempts: [] as { pair: number; variant: string; appScripts: string[] }[],
  retentionSnapshots: [] as ({ pair: number; variant: string; phase: 'prepared' | 'finished' } & Awaited<
    ReturnType<typeof retainedChromeMetrics>
  >)[],
  completed: false,
  failure: null as string | null,
  cleanupErrors: [] as string[],
  samples,
}
// Alternating AB/BA controls for warm caches, temperature, and run order without overlapping browsers.
const attempts = Array.from({ length: pairs }, (_, index) => index + 1).flatMap((pair) =>
  (pair % 2 ? (['before', 'after'] as const) : (['after', 'before'] as const)).map((variant) => ({ pair, variant })),
)
try {
  const browser = await chromium.launch(getChromeLaunchOptions())
  cleanup.push({ name: 'browser', run: () => browser.close() })
  report.browser = browser.version()
  for (const { pair, variant } of attempts) {
    const mobile = values.profile === 'mobile'
    const context = await browser.newContext({
      baseURL: values[variant],
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: 1,
      locale: 'en-US',
    })
    await context.route(isTinfoilAttestationRequest, (route) => route.fulfill({ status: 503, body: '{}' }))
    await context.addInitScript(installProbe)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    const errors = collectPageErrors(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const path = `${output}/${values.label}-${pair}-${variant}`
    let tracing = false
    try {
      await prepare(page)
      const attempt = {
        pair,
        variant,
        appScripts: await page
          .locator('script[src]')
          .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src)),
      }
      const previous = report.attempts.find((attempt) => attempt.variant === variant)
      if (previous && JSON.stringify(previous.appScripts) !== JSON.stringify(attempt.appScripts)) {
        throw new Error(`The ${variant} build changed between pairs`)
      }
      report.attempts.push(attempt)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
      await page.waitForTimeout(500)
      report.retentionSnapshots.push({ pair, variant, phase: 'prepared', ...(await retainedChromeMetrics(cdp)) })
      if (values.trace) {
        await cdp.send('Tracing.start', { categories: traceCategories, transferMode: 'ReturnAsStream' })
        tracing = true
      }
      for (const journey of journeys) {
        await runJourney(
          page,
          journey,
          async (name, action, settleMs = 250) => {
            if (values.trace) {
              await page.evaluate((name) => performance.mark(`${name}:start`), name)
            }
            const before = await chromeMetrics(cdp)
            await page.evaluate(() => (window as unknown as PerformanceWindow).__thunderboltPerformance.start())
            await action()
            await page.waitForTimeout(settleMs)
            // A paint and subsequent task let Event Timing deliver even for an immediate first-send observation.
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
            const sample = {
              pair,
              variant,
              name,
              ...summarizeSample(raw),
              taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
              scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
              layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
              heapBytes: after.JSHeapUsedSize,
              nodes: after.Nodes,
              listeners: after.JSEventListeners,
              raw,
            }
            samples.push(sample)
            console.log(
              `${pair}/${pairs} ${variant} ${name}: window ${sample.windowMs.toFixed(1)}ms, task ${sample.taskMs.toFixed(1)}ms, frame ${sample.frameMaxMs?.toFixed(1)}ms, ${sample.reactCommits} commits, ${sample.listeners} listeners`,
            )
            if (values.trace) {
              await page.evaluate((name) => {
                performance.mark(`${name}:end`)
                performance.measure(name, `${name}:start`, `${name}:end`)
              }, name)
            }
          },
          values.stream === 'long',
        )
      }
      report.retentionSnapshots.push({ pair, variant, phase: 'finished', ...(await retainedChromeMetrics(cdp)) })
      if (errors.length) {
        throw new Error(`Uncaught page errors: ${errors.join('\n')}`)
      }
    } finally {
      report.cleanupErrors.push(
        ...(await collectCleanupErrors([
          ...(tracing ? [{ name: 'trace', run: () => finishTrace(cdp, `${path}.trace.json`) }] : []),
          { name: 'screenshot', run: () => page.screenshot({ path: `${path}.png` }) },
          { name: 'context', run: () => context.close() },
        ])),
      )
    }
  }
  report.completed = true
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await finalizeReport(`${output}/${values.label}.json`, report, cleanup)
}
if (!values.trace) {
  for (const name of new Set(samples.map((sample) => sample.name))) {
    const differences = Array.from({ length: pairs }, (_, index) => {
      const before = samples.find(
        (sample) => sample.pair === index + 1 && sample.variant === 'before' && sample.name === name,
      )!
      const after = samples.find(
        (sample) => sample.pair === index + 1 && sample.variant === 'after' && sample.name === name,
      )!
      return { taskMs: after.taskMs - before.taskMs, windowMs: after.windowMs - before.windowMs }
    })
    console.log(
      `${name}: median paired task change ${percentile(
        differences.map((sample) => sample.taskMs),
        0.5,
      )!.toFixed(1)}ms, window change ${percentile(
        differences.map((sample) => sample.windowMs),
        0.5,
      )!.toFixed(1)}ms`,
    )
  }
}
console.log(`Saved ${output}/${values.label}.json`)
