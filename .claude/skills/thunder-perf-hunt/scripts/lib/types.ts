/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared contracts for the thunder-perf-hunt harness. Every probe writes data
 * that conforms to these types, and the agentic layer reasons only over these
 * compact structures — never raw traces. Keep this file dependency-free so it
 * can be imported by any probe script and by the report aggregator.
 */

export type BrowserName = 'chromium' | 'firefox'

/** Categories a finding can belong to. Drives triage routing and fix playbooks. */
export type FindingCategory =
  | 'web-vital'
  | 'unnecessary-render'
  | 'long-task'
  | 'layout-thrash'
  | 'memory-leak'
  | 'bundle'
  | 'network'
  | 'console-error'
  | 'crash'
  | 'a11y'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

/** How sure the deterministic layer is before the agent verifies. */
export type Confidence = 'high' | 'medium' | 'low'

/** Lifecycle of a finding as it moves through the agentic pipeline. */
export type FindingStatus =
  | 'candidate' // emitted by a probe, not yet verified
  | 'confirmed' // survived adversarial verification with reproduction
  | 'refuted' // verifier could not reproduce, or it is expected/by-design
  | 'fixed' // a fix landed and the metric moved
  | 'deferred' // real but out of scope for autonomous fixing

/** A single Core Web Vital sample with source attribution when available. */
export type WebVitalSample = {
  name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'
  value: number
  rating: 'good' | 'needs-improvement' | 'poor'
  /** CSS selector or resource URL the metric attributes to, when derivable. */
  attribution?: string
}

/** One Long Animation Frame (LoAF) with per-script source attribution. */
export type LoafSample = {
  duration: number
  blockingDuration: number
  /** ms spent in forced style/layout — a layout-thrash signal. */
  forcedStyleAndLayoutDuration: number
  scripts: Array<{
    sourceURL: string
    sourceFunctionName: string
    sourceCharPosition: number
    duration: number
    invoker: string
  }>
}

export type LongTaskSample = {
  duration: number
  startTime: number
  /** Attribution container name from the longtask entry, when present. */
  attribution: string
}

/** Per-component render accounting captured via the React commit hook. */
export type RenderStat = {
  component: string
  commits: number
  /** Summed actualDuration across commits (ms). */
  totalDuration: number
  maxDuration: number
}

export type NetworkSample = {
  url: string
  method: string
  status: number
  resourceType: string
  transferSizeBytes: number
  durationMs: number
  /** true when it blocked first paint / is on the critical request chain. */
  renderBlocking: boolean
}

export type ConsoleSample = {
  level: 'error' | 'warning'
  text: string
  /** First stack location, when the browser provides one. */
  location?: string
}

/** Heap comparison across a before/after boundary for leak detection. */
export type HeapDelta = {
  label: string
  beforeBytes: number
  afterBytes: number
  deltaBytes: number
  /**
   * Total live DOM node count delta (after − before), when measurable via CDP.
   * Informational only — a positive value doesn't imply leaked/detached nodes,
   * since live node counts fluctuate naturally across a navigate cycle.
   */
  domNodesDelta?: number
}

export type A11yViolation = {
  ruleId: string
  impact: 'critical' | 'serious' | 'moderate' | 'minor'
  help: string
  selectors: string[]
}

/** App-owned startup marks read from performance.mark (init-timing.ts). */
export type InitTimingMark = {
  name: string
  startTime: number
}

/** One probe run over a single (browser × scenario) pair. */
export type ScenarioReport = {
  scenario: string
  browser: BrowserName
  url: string
  startedAt: string
  vitals: WebVitalSample[]
  loaf: LoafSample[]
  longTasks: LongTaskSample[]
  renders: RenderStat[]
  /** Renders captured during a controlled unrelated interaction (noise probe). */
  noiseRenders: RenderStat[]
  network: NetworkSample[]
  console: ConsoleSample[]
  heap: HeapDelta[]
  a11y: A11yViolation[]
  initTiming: InitTimingMark[]
  /** Uncaught page errors (crash signal), Tauri noise filtered out. */
  pageErrors: string[]
  screenshotPath?: string
}

/** Bundle/chunk analysis (cross-browser, run once per build). */
export type BundleReport = {
  entryChunkGzipBytes: number
  totalJsGzipBytes: number
  largestChunks: Array<{ file: string; gzipBytes: number }>
  /** Modules unexpectedly pulled into the entry chunk. */
  suspectEntryModules: string[]
}

/** Root artifact for one full harness run, written to the run directory. */
export type RunReport = {
  runId: string
  startedAt: string
  finishedAt?: string
  gitRef: string
  mode: 'sweep' | 'diff' | 'focus'
  scenarios: ScenarioReport[]
  bundle?: BundleReport
}

/** A normalized, agent-facing issue derived from one or more probe samples. */
export type Finding = {
  id: string
  category: FindingCategory
  title: string
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  browsers: BrowserName[]
  scenarios: string[]
  /** Compact quantitative evidence (the metric that triggered this). */
  evidence: string
  /** Source location the issue attributes to: "file:line" or a selector. */
  sourceAttribution?: string
  /** Exact deterministic steps to reproduce (which probe + scenario + browser). */
  repro: string
  /** Before/after numbers once a fix is applied. */
  beforeAfter?: { metric: string; before: number; after: number; unit: string }
  suggestedFix?: string
  /** Findings clustered with this one for a single PR. */
  clusterId?: string
  prUrl?: string
}

/** JSON Schema-friendly shape a verifier sub-agent must return. */
export type VerdictReport = {
  findingId: string
  reproduced: boolean
  isReal: boolean
  /** Why it was confirmed or refuted, citing the re-run evidence. */
  rationale: string
  correctedSeverity?: Severity
  sourceAttribution?: string
}
