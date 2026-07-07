#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Curiosity-driven state-graph crawler for functional bug hunting. This is NOT
 * random monkey-testing: it models the app as a graph of "states" (a URL path
 * plus the set of visible interactive-element labels), remembers where it has
 * been, and deliberately steers toward UNVISITED actions. Along the way it
 * listens for uncaught errors, console errors, dead-end navigations, and blank
 * crashes, emitting each as a compact Finding the agentic layer can triage.
 *
 * The only thing printed to stdout is the path to the findings JSON — every
 * other log goes to stderr, mirroring scripts/run.ts.
 *
 * Usage:
 *   bun scripts/explore.ts --browsers chromium --steps 40
 *   bun scripts/explore.ts --browsers chromium,firefox --steps 60 --run-id manual
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import type { Browser, Locator, Page } from 'playwright'
import { REPO_ROOT } from './lib/env'
import { bootStack } from './lib/boot'
import { launchBrowser } from './lib/collect'
import { INIT_SCRIPT } from './lib/inject'
import { applyExclusions, loadCalibration } from './lib/calibration'
import type { BrowserName, Confidence, Finding, FindingCategory, Severity } from './lib/types'

const ROOT_PATH = '/chats/new'
const MAX_STATES = 60
const MAX_ACTIONS_PER_STATE = 25
const SETTLE_TIMEOUT = 2_000
const NAV_TIMEOUT = 30_000
const TAURI_NOISE = ['__TAURI__', 'tauri', '__TAURI_INTERNALS__', 'convertFileSrc']

const flag = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const isTauriNoise = (text: string): boolean => TAURI_NOISE.some((n) => text.includes(n))

/** Stable, order-independent hash of the visible action labels for a state. */
const signature = (path: string, labels: string[]): string => {
  const digest = Bun.hash([...labels].sort().join('\n')).toString(16)
  return `${path}#${digest}`
}

type Action = { label: string; locator: Locator }
type GraphNode = { id: string; signature: string; path: string; labelCount: number; browser: BrowserName }
type GraphEdge = { from: string; to: string; action: string; browser: BrowserName }

/** Path portion of a URL, so states compare on route rather than host/port. */
const pathOf = (page: Page): string => {
  try {
    return new URL(page.url()).pathname
  } catch {
    return page.url()
  }
}

/** Read a short, human-meaningful label for one interactive element. */
const labelFor = async (locator: Locator): Promise<string> => {
  const aria = (await locator.getAttribute('aria-label').catch(() => null))?.trim()
  if (aria) return aria
  const text = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ')
  if (text) return text.slice(0, 60)
  const href = (await locator.getAttribute('href').catch(() => null))?.trim()
  if (href) return `link:${href.slice(0, 60)}`
  return 'unlabeled'
}

/** Enumerate visible, clickable actions in the current state (capped). */
const enumerateActions = async (page: Page): Promise<Action[]> => {
  const raw = [
    ...(await page.getByRole('button').all().catch(() => [])),
    ...(await page.locator('a[href]').all().catch(() => [])),
    ...(await page.locator('[role="menuitem"]').all().catch(() => [])),
  ]
  const actions: Action[] = []
  const seen = new Set<string>()
  for (const locator of raw) {
    if (actions.length >= MAX_ACTIONS_PER_STATE) break
    if (!(await locator.isVisible().catch(() => false))) continue
    if (!(await locator.isEnabled().catch(() => false))) continue
    const label = await labelFor(locator)
    if (seen.has(label)) continue
    seen.add(label)
    actions.push({ label, locator })
  }
  return actions
}

/** After a transition, is the app still showing its shell (vs a blank crash)? */
const appAlive = (page: Page): Promise<boolean> =>
  page
    .locator('main, textarea, [role="main"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false)

const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => {})
  await page.waitForTimeout(250)
}

const gotoRoot = async (page: Page, baseUrl: string): Promise<void> => {
  await page.goto(baseUrl + ROOT_PATH, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {})
  await appAlive(page)
  await page.waitForTimeout(300)
}

type ErrorLog = { pageErrors: string[]; consoleErrors: string[] }

/** Crawl one browser, mutating the shared graph + findings accumulators. */
const crawlBrowser = async (
  browser: Browser,
  browserName: BrowserName,
  baseUrl: string,
  maxSteps: number,
  runDir: string,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  findings: Finding[],
  seenFindingKeys: Set<string>,
): Promise<void> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.addInitScript({ content: INIT_SCRIPT })

  const errors: ErrorLog = { pageErrors: [], consoleErrors: [] }
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (isTauriNoise(text)) return
    errors.consoleErrors.push(text.slice(0, 500))
  })
  page.on('pageerror', (err) => {
    if (isTauriNoise(err.message)) return
    errors.pageErrors.push(err.message.slice(0, 500))
  })

  const triedByState = new Map<string, Set<string>>()
  let screenshotIndex = nodes.size
  let currentPath: string[] = []

  const addFinding = (
    category: FindingCategory,
    severity: Severity,
    confidence: Confidence,
    title: string,
    evidence: string,
    repro: string,
  ): void => {
    const key = `${category}:${title}:${evidence.slice(0, 120)}`
    if (seenFindingKeys.has(key)) return
    seenFindingKeys.add(key)
    findings.push({
      id: `explore-${findings.length + 1}`,
      category,
      title,
      severity,
      confidence,
      status: 'candidate',
      browsers: [browserName],
      scenarios: ['explore'],
      evidence,
      repro,
    })
  }

  const recordNode = async (sig: string, path: string, labels: string[]): Promise<void> => {
    if (nodes.has(sig)) return
    const node: GraphNode = { id: sig, signature: sig, path, labelCount: labels.length, browser: browserName }
    nodes.set(sig, node)
    const shot = `${runDir}/state-${screenshotIndex++}.${browserName}.png`
    await page.screenshot({ path: shot }).catch(() => {})
  }

  await gotoRoot(page, baseUrl)

  for (let step = 0; step < maxSteps && nodes.size < MAX_STATES; step++) {
    const path = pathOf(page)
    const actions = await enumerateActions(page)
    const labels = actions.map((a) => a.label)
    const sig = signature(path, labels)
    await recordNode(sig, path, labels)

    const tried = triedByState.get(sig) ?? new Set<string>()
    triedByState.set(sig, tried)
    const next = actions.find((a) => !tried.has(a.label))

    if (!next) {
      // Fully explored (or empty) state: rewind to root and keep hunting.
      await gotoRoot(page, baseUrl)
      currentPath = []
      continue
    }
    tried.add(next.label)

    const errBefore = errors.pageErrors.length
    const consoleBefore = errors.consoleErrors.length
    const clicked = await next.locator.click({ timeout: 3_000 }).then(() => true).catch(() => false)
    if (!clicked) continue
    await settle(page)

    currentPath.push(next.label)
    const repro = `Root(${ROOT_PATH}) -> ${currentPath.join(' -> ')}`

    const afterPath = pathOf(page)
    const afterActions = await enumerateActions(page)
    const afterSig = signature(afterPath, afterActions.map((a) => a.label))
    edges.push({ from: sig, to: afterSig, action: next.label, browser: browserName })

    const newPageErrors = errors.pageErrors.slice(errBefore)
    const newConsoleErrors = errors.consoleErrors.slice(consoleBefore)

    for (const err of newPageErrors) {
      addFinding('crash', 'critical', 'high', `Uncaught error after "${next.label}"`, `${err} | state=${afterSig}`, repro)
    }
    for (const err of newConsoleErrors) {
      addFinding('console-error', 'medium', 'medium', `Console error after "${next.label}"`, `${err} | state=${afterSig}`, repro)
    }
    if (afterPath.includes('/not-found')) {
      addFinding('crash', 'high', 'high', `Dead-end navigation to /not-found via "${next.label}"`, `navigated to ${afterPath} | state=${afterSig}`, repro)
    }
    if (!(await appAlive(page))) {
      addFinding('crash', 'critical', 'high', `App shell disappeared after "${next.label}"`, `no main/textarea after transition | state=${afterSig}`, repro)
      await gotoRoot(page, baseUrl)
      currentPath = []
    }
  }

  await context.close().catch(() => {})
}

const main = async () => {
  const browsers = (flag('browsers', 'chromium').split(',').filter(Boolean) as BrowserName[])
  const maxSteps = Number(flag('steps', '40')) || 40

  const runId = flag('run-id', new Date().toISOString().replace(/[:.]/g, '-'))
  const runDir = flag('out', `${REPO_ROOT}/.perf-hunt/runs/${runId}/explore`)
  mkdirSync(runDir, { recursive: true })

  console.error(`perf-hunt/explore: booting stack for run ${runId} (${browsers.join('+')}, ${maxSteps} steps)`)
  const stack = await bootStack(REPO_ROOT)

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const findings: Finding[] = []
  const seenFindingKeys = new Set<string>()

  try {
    for (const browserName of browsers) {
      console.error(`perf-hunt/explore: [${browserName}] crawling`)
      const browser = await launchBrowser(browserName)
      try {
        await crawlBrowser(browser, browserName, stack.baseUrl, maxSteps, runDir, nodes, edges, findings, seenFindingKeys)
      } finally {
        await browser.close().catch(() => {})
      }
    }
  } finally {
    await stack.teardown()
  }

  // Apply the same learned exclusions the perf report uses, so calibrated false
  // positives (e.g. keyless-stack send errors) don't recur in the crawl output.
  const cal = loadCalibration()
  const kept = applyExclusions(findings, cal)
  if (kept.length < findings.length) {
    console.error(`perf-hunt/explore: suppressed ${findings.length - kept.length} finding(s) via ${cal.excludeSignatures.length} learned exclusion(s)`)
  }

  const findingsPath = `${runDir}/explore-findings.json`
  writeFileSync(findingsPath, JSON.stringify(kept, null, 2))
  writeFileSync(`${runDir}/state-graph.json`, JSON.stringify({ nodes: [...nodes.values()], edges }, null, 2))

  console.error(`perf-hunt/explore: ${nodes.size} states, ${edges.length} transitions, ${kept.length} findings`)
  // The ONLY thing the agent parses from stdout: the path to the findings JSON.
  console.log(findingsPath)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
