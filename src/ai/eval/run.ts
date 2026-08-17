/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBuiltInAdapter } from '@/acp/built-in-adapter'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import { setAuthToken } from '@/lib/auth-token'
import { Storage } from 'happy-dom'
import { getNecessityScenarios } from './necessity-scenarios'
import { detailed, verbose } from './options'
import { generateReport } from './report'
import { runPool } from './runner'
import { getScenarios } from './scenarios'
import { getScenarioSampleCount, selectSmokeScenarios } from './smoke'
import { initLayout, printFooter, restoreConsole, silenceConsole, teardownLayout } from './ui'

const main = async (): Promise<number> => {
  const authToken = process.env.EVAL_AUTH_TOKEN
  if (authToken) {
    setAuthToken(authToken)
  }

  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim())
  const modeFilter = process.env.EVAL_MODES?.split(',').map((s) => s.trim())
  const engineFilter = process.env.EVAL_ENGINES?.split(',').map((s) => s.trim())
  const scenarioParallel = parseInt(process.env.EVAL_SCENARIO_PARALLEL ?? '3')
  const necessitySamples = parseInt(process.env.EVAL_SAMPLES ?? '3')
  const smoke = process.env.EVAL_SMOKE === '1'
  if (!Number.isInteger(necessitySamples) || necessitySamples < 1) {
    throw new Error('EVAL_SAMPLES must be a positive integer')
  }

  const necessityScenarios =
    !modeFilter || modeFilter.includes('chat') ? getNecessityScenarios(modelFilter, engineFilter) : []
  const filteredScenarios = [...getScenarios(modelFilter, modeFilter, engineFilter), ...necessityScenarios]
  const scenarios = smoke ? selectSmokeScenarios(filteredScenarios) : filteredScenarios

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    console.error(`  EVAL_ENGINES=${process.env.EVAL_ENGINES ?? '(all)'}`)
    return 1
  }

  const adapter = createBuiltInAdapter(builtInAgent)
  const runScenarios = async () => {
    await setupTestDatabase()
    if (!verbose) {
      silenceConsole()
    }
    initLayout(scenarios, scenarioParallel)

    try {
      return await runPool(scenarios, scenarioParallel, adapter, (scenario) =>
        getScenarioSampleCount(scenario, necessitySamples, smoke),
      )
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
  return failCount > 0 ? 1 : 0
}

// Register only the browser API Zustand needs; happy-dom's fetch buffers
// streaming Request responses and deadlocks Tinfoil's encrypted SSE transport.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new Storage(),
})
process.exit(await main())
