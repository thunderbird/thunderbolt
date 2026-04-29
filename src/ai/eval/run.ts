/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { generateReport } from './report'
import { runPool } from './runner'
import { getScenarios } from './scenarios'
import { initLayout, printFooter, restoreConsole, silenceConsole, teardownLayout } from './ui'

export const verbose = process.argv.includes('--verbose')
export const detailed = process.argv.includes('--detailed')

const main = async () => {
  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim())
  const modeFilter = process.env.EVAL_MODES?.split(',').map((s) => s.trim())
  const scenarioParallel = parseInt(process.env.EVAL_SCENARIO_PARALLEL ?? '3')

  const scenarios = getScenarios(modelFilter, modeFilter)

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    process.exit(1)
  }

  // Set up a single shared database for all scenarios (read-only for evals)
  await setupTestDatabase()

  // Suppress noisy console output from fetch.ts unless --verbose
  if (!verbose) {
    silenceConsole()
  }

  // Initialize terminal layout with spinner slots matching concurrency
  initLayout(scenarios, scenarioParallel)

  // Run all scenarios through a single worker pool
  const results = await runPool(scenarios, scenarioParallel)

  printFooter()
  teardownLayout()

  // Restore console for report generation and teardown
  restoreConsole()
  await teardownTestDatabase()

  generateReport(results, detailed)

  const failCount = results.filter((r) => !r.passed).length
  if (failCount > 0) {
    process.exit(1)
  }
}

await main()
