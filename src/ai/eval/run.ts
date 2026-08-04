/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBuiltInAdapter } from '@/acp/built-in-adapter'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import { generateReport } from './report'
import { runPool } from './runner'
import { getScenarios } from './scenarios'
import { initLayout, printFooter, restoreConsole, silenceConsole, teardownLayout } from './ui'

export const verbose = process.argv.includes('--verbose')
export const detailed = process.argv.includes('--detailed')

const main = async () => {
  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim())
  const modeFilter = process.env.EVAL_MODES?.split(',').map((s) => s.trim())
  const engineFilter = process.env.EVAL_ENGINES?.split(',').map((s) => s.trim())
  const scenarioParallel = parseInt(process.env.EVAL_SCENARIO_PARALLEL ?? '3')

  const scenarios = getScenarios(modelFilter, modeFilter, engineFilter)

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    console.error(`  EVAL_ENGINES=${process.env.EVAL_ENGINES ?? '(all)'}`)
    process.exit(1)
  }

  const adapter = createBuiltInAdapter(builtInAgent)
  const runScenarios = async () => {
    await setupTestDatabase()
    if (!verbose) {
      silenceConsole()
    }
    initLayout(scenarios, scenarioParallel)

    try {
      return await runPool(scenarios, scenarioParallel, adapter)
    } finally {
      printFooter()
      teardownLayout()
      restoreConsole()
      adapter.disconnect()
      await teardownTestDatabase()
    }
  }
  const results = await runScenarios()

  generateReport(results, detailed)

  const failCount = results.filter((r) => !r.passed).length
  if (failCount > 0) {
    process.exit(1)
  }
}

await main()
