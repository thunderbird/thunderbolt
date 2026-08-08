#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Deterministic entry point for the harness. Boots the stack, drives every
 * requested (browser × scenario), and writes a single RunReport JSON plus
 * screenshots to a run directory. The agentic layer (SKILL.md) reads only the
 * JSON — never this script's stdout beyond the printed report path.
 *
 * Usage:
 *   bun scripts/run.ts --mode sweep --browsers chromium,firefox
 *   bun scripts/run.ts --mode diff --changed src/chat/foo.tsx,src/models/bar.tsx
 *   bun scripts/run.ts --mode focus --focus chat-landing --browsers chromium
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { REPO_ROOT } from './lib/env'
import { bootStack } from './lib/boot'
import { collectScenario, launchBrowser } from './lib/collect'
import { SCENARIOS, scenariosForChangedFiles, type ScenarioDef } from './lib/scenarios'
import type { BrowserName, RunReport, ScenarioReport } from './lib/types'

const flag = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const gitRef = (): string => {
  try {
    return new TextDecoder().decode(Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).stdout).trim()
  } catch {
    return 'unknown'
  }
}

const selectScenarios = (mode: string): ScenarioDef[] => {
  if (mode === 'diff') return scenariosForChangedFiles(flag('changed').split(',').filter(Boolean))
  if (mode === 'focus') {
    const names = flag('focus').split(',').filter(Boolean)
    return SCENARIOS.filter((s) => names.includes(s.name))
  }
  return SCENARIOS
}

const main = async () => {
  const mode = (flag('mode', 'sweep') as RunReport['mode']) || 'sweep'
  const browsers = (flag('browsers', 'chromium,firefox').split(',').filter(Boolean) as BrowserName[])
  const scenarios = selectScenarios(mode)
  if (scenarios.length === 0) throw new Error(`perf-hunt: no scenarios matched (mode=${mode})`)

  const runId = flag('run-id', new Date().toISOString().replace(/[:.]/g, '-'))
  const runDir = flag('out', `${REPO_ROOT}/.perf-hunt/runs/${runId}`)
  mkdirSync(runDir, { recursive: true })

  console.error(`perf-hunt: booting stack for run ${runId} (${mode}, ${browsers.join('+')}, ${scenarios.length} scenarios)`)
  const stack = await bootStack(REPO_ROOT)

  const reports: ScenarioReport[] = []
  const browserErrors: string[] = []
  try {
    for (const browserName of browsers) {
      // Isolate per-browser failures: a browser that can't launch on this host
      // (e.g. Playwright Firefox on a bleeding-edge OS) must not discard the
      // results already gathered from the browsers that did work.
      let browser
      try {
        browser = await launchBrowser(browserName)
      } catch (err) {
        const msg = `[${browserName}] launch failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
        console.error(`perf-hunt: ${msg}`)
        browserErrors.push(msg)
        continue
      }
      try {
        for (const scenario of scenarios) {
          console.error(`perf-hunt: [${browserName}] ${scenario.name}`)
          reports.push(await collectScenario(browser, browserName, stack.baseUrl, scenario, runDir))
        }
      } finally {
        await browser.close().catch(() => {})
      }
    }
  } finally {
    await stack.teardown()
  }

  if (reports.length === 0) {
    throw new Error(`perf-hunt: no scenarios collected. ${browserErrors.join('; ') || 'unknown error'}`)
  }

  const report: RunReport = {
    runId,
    startedAt: reports[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    gitRef: gitRef(),
    mode,
    scenarios: reports,
  }
  const reportPath = `${runDir}/report.json`
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  // The ONLY thing the agent parses from stdout: the path to the JSON report.
  console.log(reportPath)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
