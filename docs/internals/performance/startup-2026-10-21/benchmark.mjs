// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Synthetic startup benchmark and real-browser recorder.
 * Run explicitly with --execute to start isolated browser contexts and recording.
 *
 * Build BOTH input directories with VITE_SKIP_ONBOARDING=true, then run:
 *   node docs/internals/performance/startup-2026-10-21/benchmark.mjs --execute \
 *     --before /tmp/thunderbolt-review-before --after /tmp/thunderbolt-review-after \
 *     --out /tmp/thunderbolt-review-benchmark-results
 *
 * Dedicated headless contexts contain only synthetic data. It never attaches to
 * an existing browser/profile, sends a chat, accepts terms, or contacts real APIs.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    execute: { type: 'boolean', default: false },
    before: { type: 'string', default: '/tmp/thunderbolt-review-before' },
    after: { type: 'string', default: '/tmp/thunderbolt-review-after' },
    out: { type: 'string', default: '/tmp/thunderbolt-review-benchmark-results' },
  },
})
if (!values.execute) {
  console.log('No browser started. Run with --execute to measure and record.')
  process.exit(0)
}

const origin = 'http://127.0.0.1:1431'
const viewport = { width: 1280, height: 800 }
const returningRuns = 30
const freshRuns = 10
const warmupsPerCondition = 2
const analyticsDelays = [0, 1500]
const builds = { before: resolve(values.before), after: resolve(values.after) }
const outputDir = resolve(values.out)
if (!outputDir.startsWith('/tmp/') && !outputDir.startsWith('/private/tmp/')) {
  throw new Error('Benchmark artifacts must be saved under /tmp.')
}
for (const directory of Object.values(builds)) await access(join(directory, 'index.html'))
await mkdir(outputDir, { recursive: false })
const rawPath = join(outputDir, 'raw-runs.ndjson')
const records = []
const fixture = {
  user: {
    id: 'synthetic-startup-review',
    name: 'Startup Review',
    email: 'startup-review@example.invalid',
    emailVerified: true,
    isAnonymous: false,
  },
  session: {
    id: 'synthetic-startup-review-session',
    userId: 'synthetic-startup-review',
    expiresAt: '2099-01-01T00:00:00.000Z',
    token: 'synthetic-startup-review-token',
  },
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const deferred = () => {
  let resolveDeferred
  const promise = new Promise((resolvePromise) => {
    resolveDeferred = resolvePromise
  })
  return { promise, resolve: resolveDeferred }
}
const withTimeout = async (promise, ms, label) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
}
let selectedBuild = 'before'
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cache-Control', 'no-store')
  try {
    const pathname = decodeURIComponent(new URL(request.url, origin).pathname)
    if (pathname.startsWith('/v1/')) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Synthetic API interception required' }))
      return
    }
    const directory = builds[selectedBuild]
    const candidate = resolve(directory, `.${pathname}`)
    if (candidate !== directory && !candidate.startsWith(`${directory}${sep}`)) {
      response.writeHead(403).end()
      return
    }
    const candidateStat = await stat(candidate).catch(() => null)
    const isFile = candidateStat?.isFile()
    // Missing assets must fail visibly; only extensionless routes use SPA fallback.
    if (!isFile && extname(pathname)) {
      response.writeHead(404).end('Missing build asset')
      return
    }
    const file = isFile ? candidate : join(directory, 'index.html')
    const metadata = isFile ? candidateStat : await stat(file)
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Content-Length': metadata.size,
    })
    if (request.method === 'HEAD') response.end()
    else
      createReadStream(file)
        .on('error', () => response.destroy())
        .pipe(response)
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end(String(error))
  }
})

const buildMetadata = {}
for (const [name, directory] of Object.entries(builds)) {
  const html = await readFile(join(directory, 'index.html'), 'utf8')
  const entryPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
  const entry = entryPath ? await readFile(join(directory, entryPath.replace(/^\//, ''))) : null
  buildMetadata[name] = {
    directory,
    htmlSha256: createHash('sha256').update(html).digest('hex'),
    entryPath,
    entryBytes: entry?.byteLength,
    entrySha256: entry ? createHash('sha256').update(entry).digest('hex') : null,
  }
}

const manifest = {
  startedAt: new Date().toISOString(),
  origin,
  buildMetadata,
  viewport,
  browser: 'Playwright Chromium, headless, fresh isolated browser contexts',
  requiredBuildFlag: 'VITE_SKIP_ONBOARDING=true for BOTH builds',
  returningRunsPerBuildPerDelay: returningRuns,
  freshRunsPerBuild: freshRuns,
  freshAnalyticsDelayMs: 0,
  warmupsPerCondition,
  analyticsDelaysMs: analyticsDelays,
  conditions: {
    session: 'synthetic cached signed-in session',
    syncEnabled: false,
    deviceKeys: 'none',
    config: 'empty object',
    analyticsConfig: 'empty object after specified delay',
    allOtherApis: 'intercepted 503; no real service requests',
    serviceWorkers: 'blocked',
    browserHttpCache: 'disabled by Playwright routing; server also sends no-store',
    returningProfile: 'same isolated context per build, persisted local DB; page closed between samples',
    freshProfile: 'new isolated context for every sample',
    ordering: 'rounds alternate before/after and reverse delay order; only one app page active at a time',
  },
  metric:
    'requestAnimationFrame DOM visibility + hit testing: visible, enabled textarea and model-selector; no open dialog; confirmed on next frame. These are rendering opportunities, not compositor timestamps.',
  video:
    'separate representative returning 1500ms-delay runs after two warmups, actual browser frames; recordings excluded from performance distribution',
  limitation:
    'Synthetic Chromium measurements do not establish cold native, real sign-in, encrypted-device, network, or multi-device sync improvements.',
}
await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

let browser
const returningContexts = new Map()
const createIsolatedContext = async (recordVideo = false) => {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    serviceWorkers: 'block',
    ...(recordVideo ? { recordVideo: { dir: join(outputDir, 'video-raw'), size: viewport } } : {}),
  })
  const owner = { context, activeRun: null }
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin && !url.pathname.startsWith('/v1/')) {
      await route.continue()
      return
    }
    const run = owner.activeRun
    const requestInfo = { url: `${url.origin}${url.pathname}`, method: route.request().method(), status: 503 }
    run?.apiRequests.push(requestInfo)
    if (url.origin === origin && url.pathname.endsWith('/posthog/config')) {
      requestInfo.status = 200
      requestInfo.delayMs = run?.analyticsDelayMs ?? 0
      await sleep(requestInfo.delayMs)
      try {
        await route.fulfill({ json: {} })
      } finally {
        run?.analyticsSettled.resolve()
      }
      return
    }
    if (url.origin === origin && url.pathname.endsWith('/api/auth/get-session')) {
      requestInfo.status = 200
      await route.fulfill({ json: fixture })
      return
    }
    if (url.origin === origin && url.pathname === '/v1/config') {
      requestInfo.status = 200
      await route.fulfill({ json: {} })
      return
    }
    await route.fulfill({ status: 503, json: { error: 'Real services disabled in isolated startup benchmark' } })
  })
  // The app has no sync credentials/keys and should never open a socket. Block
  // unexpected page-created WebSockets as a second barrier against real services.
  await context.addInitScript(
    ({ session, appOrigin }) => {
      if (location.origin !== appOrigin) return
      localStorage.setItem(
        'thunderbolt-local-settings',
        JSON.stringify({
          state: {
            cloudUrl: `${appOrigin}/v1`,
            syncEnabled: false,
            hapticsEnabled: false,
            theme: 'light',
          },
          version: 0,
        }),
      )
      localStorage.setItem('thunderbolt_auth_token', session.session.token)
      localStorage.setItem('thunderbolt_session_cache', JSON.stringify(session))
      window.WebSocket = class BlockedBenchmarkWebSocket {
        constructor() {
          throw new Error('WebSocket connections disabled in isolated startup benchmark')
        }
      }
      const measurement = {
        spinnerFirstVisibleMs: null,
        composerFirstVisibleMs: null,
        composerConfirmedVisibleMs: null,
        framesObserved: 0,
        visibleDialogObserved: false,
      }
      window.__startupBenchmark = measurement
      const visible = (element) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= innerHeight ||
          rect.left >= innerWidth
        )
          return false
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || current.inert)
            return false
        }
        const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2))
        const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
        const hit = document.elementFromPoint(x, y)
        return hit !== null && (element === hit || element.contains(hit))
      }
      let firstReadyFrame = null
      const observe = () => {
        measurement.framesObserved += 1
        if (
          measurement.spinnerFirstVisibleMs === null &&
          [...document.querySelectorAll('svg.animate-spin')].some(visible)
        ) {
          measurement.spinnerFirstVisibleMs = performance.now()
        }
        const dialogVisible = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(visible)
        measurement.visibleDialogObserved ||= dialogVisible
        const modelSelector = document.querySelector('[data-testid="model-selector-trigger"]')
        const textarea = document.querySelector('textarea')
        const ready =
          !dialogVisible && visible(modelSelector) && visible(textarea) && !modelSelector.disabled && !textarea.disabled
        if (ready) {
          if (firstReadyFrame === null) firstReadyFrame = performance.now()
          else {
            measurement.composerFirstVisibleMs = firstReadyFrame
            measurement.composerConfirmedVisibleMs = performance.now()
            measurement.spinnerToVisibleComposerMs =
              measurement.spinnerFirstVisibleMs === null ? null : firstReadyFrame - measurement.spinnerFirstVisibleMs
            measurement.spinnerToConfirmedComposerMs =
              measurement.spinnerFirstVisibleMs === null
                ? null
                : measurement.composerConfirmedVisibleMs - measurement.spinnerFirstVisibleMs
            return
          }
        } else firstReadyFrame = null
        requestAnimationFrame(observe)
      }
      requestAnimationFrame(observe)
    },
    { session: fixture, appOrigin: origin },
  )
  return owner
}

let sampleNumber = 0
const measure = async (owner, build, analyticsDelayMs, phase, round, video = false) => {
  selectedBuild = build
  const record = {
    sample: ++sampleNumber,
    build,
    phase,
    round,
    analyticsDelayMs,
    startedAt: new Date().toISOString(),
    logs: [],
    errors: [],
    apiRequests: [],
  }
  const analyticsSettled = deferred()
  owner.activeRun = { ...record, analyticsSettled }
  const page = await owner.context.newPage()
  const videoHandle = page.video()
  page.on('console', (message) => {
    const text = message.text()
    if (text.startsWith('[init]') || text.startsWith('[startup]') || message.type() === 'error') record.logs.push(text)
  })
  page.on('pageerror', (error) => record.errors.push(error.message))
  try {
    await page.goto(`${origin}/chats/new`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForFunction(
      () => typeof window.__startupBenchmark?.composerConfirmedVisibleMs === 'number',
      undefined,
      { timeout: 20000 },
    )
    record.timing = await page.evaluate(() => ({
      ...window.__startupBenchmark,
      navigation: performance.getEntriesByType('navigation')[0]?.toJSON() ?? null,
      paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
      documentVisibility: document.visibilityState,
    }))
    if (record.timing.visibleDialogObserved)
      throw new Error('An onboarding/other dialog appeared; verify both builds use VITE_SKIP_ONBOARDING=true')
    if (record.errors.length > 0) throw new Error(`Browser page error: ${record.errors[0]}`)
    await withTimeout(analyticsSettled.promise, 10000, 'analytics request settlement')
    if (video) {
      await page.waitForTimeout(2000)
      record.screenshot = join(outputDir, `${build}-delayed-visible-composer.png`)
      await page.screenshot({ path: record.screenshot, fullPage: false })
    } else await page.waitForTimeout(100)
    record.success = true
  } catch (error) {
    record.success = false
    record.failure = String(error)
    record.bodyText = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 2000)
    record.screenshot = join(outputDir, `failure-${record.sample}-${build}.png`)
    await page.screenshot({ path: record.screenshot, fullPage: false }).catch(() => {})
    throw error
  } finally {
    await page.close()
    if (videoHandle) {
      if (video) {
        record.video = join(outputDir, `${build}-returning-analytics-1500ms.webm`)
        await videoHandle.saveAs(record.video)
      }
      await videoHandle.delete()
    }
    records.push(record)
    await appendFile(rawPath, `${JSON.stringify(record)}\n`)
    owner.activeRun = null
  }
  return record
}

const summarize = () => {
  const summaries = []
  const quantile = (numbers, fraction) => {
    const sorted = [...numbers].sort((a, b) => a - b)
    const position = (sorted.length - 1) * fraction
    const lower = Math.floor(position)
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
  }
  for (const phase of ['returning', 'fresh'])
    for (const build of Object.keys(builds)) {
      for (const delay of phase === 'fresh' ? [0] : analyticsDelays) {
        const rows = records.filter(
          (row) => row.phase === phase && row.build === build && row.analyticsDelayMs === delay && row.success,
        )
        if (!rows.length) continue
        const metric = (key) => {
          const numbers = rows.map((row) => row.timing[key]).filter((value) => typeof value === 'number')
          return numbers.length
            ? {
                n: numbers.length,
                median: quantile(numbers, 0.5),
                p90: quantile(numbers, 0.9),
                min: Math.min(...numbers),
                max: Math.max(...numbers),
              }
            : null
        }
        summaries.push({
          phase,
          build,
          analyticsDelayMs: delay,
          n: rows.length,
          navigationToVisibleComposerMs: metric('composerFirstVisibleMs'),
          spinnerToVisibleComposerMs: metric('spinnerToVisibleComposerMs'),
          navigationToConfirmedComposerMs: metric('composerConfirmedVisibleMs'),
          spinnerToConfirmedComposerMs: metric('spinnerToConfirmedComposerMs'),
          missingSpinnerSamples: rows.filter((row) => row.timing.spinnerFirstVisibleMs === null).length,
        })
      }
    }
  return summaries
}

let fatalError = null
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(1431, '127.0.0.1', resolveListen)
  })
  browser = await chromium.launch({ headless: true })
  manifest.chromiumVersion = browser.version()
  for (const build of Object.keys(builds)) {
    const owner = await createIsolatedContext()
    returningContexts.set(build, owner)
    for (const delay of analyticsDelays)
      for (let warmup = 1; warmup <= warmupsPerCondition; warmup += 1) {
        await measure(owner, build, delay, 'warmup', warmup)
      }
  }
  for (let round = 1; round <= returningRuns; round += 1) {
    const order = round % 2 === 1 ? ['before', 'after'] : ['after', 'before']
    const delays = round % 2 === 1 ? analyticsDelays : [...analyticsDelays].reverse()
    for (const delay of delays)
      for (const build of order) {
        await measure(returningContexts.get(build), build, delay, 'returning', round)
      }
    console.log(`Returning profiles: ${round}/${returningRuns} rounds complete`)
  }
  for (const owner of returningContexts.values()) await owner.context.close()
  returningContexts.clear()
  for (let round = 1; round <= freshRuns; round += 1) {
    const order = round % 2 === 1 ? ['before', 'after'] : ['after', 'before']
    for (const build of order) {
      const owner = await createIsolatedContext()
      try {
        await measure(owner, build, 0, 'fresh', round)
      } finally {
        await owner.context.close()
      }
    }
  }
  console.log(`Fresh profiles: ${freshRuns} per build complete`)
  for (const build of Object.keys(builds)) {
    const owner = await createIsolatedContext(true)
    try {
      for (let warmup = 1; warmup <= 2; warmup += 1) await measure(owner, build, 1500, 'video-warmup', warmup)
      await measure(owner, build, 1500, 'video', 1, true)
    } finally {
      await owner.context.close()
    }
  }
} catch (error) {
  fatalError = String(error)
  process.exitCode = 1
  console.error(`Benchmark stopped: ${fatalError}`)
} finally {
  for (const owner of returningContexts.values()) await owner.context.close().catch(() => {})
  await browser?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
  manifest.finishedAt = new Date().toISOString()
  const summary = summarize()
  await writeFile(join(outputDir, 'results.json'), JSON.stringify({ manifest, fatalError, summary, records }, null, 2))
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ outputDir, fatalError, summary }, null, 2))
}
