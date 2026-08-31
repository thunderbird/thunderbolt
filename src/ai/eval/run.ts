/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createBuiltInAdapter } from '@/acp/built-in-adapter'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import { getActiveLocale, setActiveLocale } from '@/i18n/active-locale'
import { setAuthToken } from '@/lib/auth-token'
import { settableLocales } from '@/i18n/resolve-locale'
import { Storage } from 'happy-dom'
import { getLanguageScenarios } from './language-scenarios'
import { getNecessityScenarios } from './necessity-scenarios'
import { detailed, verbose } from './options'
import { generateReport } from './report'
import { runPool } from './runner'
import { getScenarios } from './scenarios'
import { getScenarioSampleCount, selectSmokeScenarios } from './smoke'
import { initLayout, printFooter, restoreConsole, silenceConsole, teardownLayout } from './ui'

/** The independently runnable scenario suites, for `EVAL_SUITES`. */
const evalSuites = ['core', 'necessity', 'language'] as const
type EvalSuite = (typeof evalSuites)[number]

/**
 * Resolve which suites to run, failing loudly on an unknown name — a typo that
 * silently ran everything would be an expensive way to learn about it.
 */
const resolveSuites = (requested: string | undefined): readonly EvalSuite[] => {
  if (!requested) {
    return evalSuites
  }
  const names = requested.split(',').map((name) => name.trim())
  const unknown = names.filter((name) => !(evalSuites as readonly string[]).includes(name))
  if (unknown.length > 0) {
    throw new Error(`EVAL_SUITES must be a comma-separated subset of: ${evalSuites.join(', ')}`)
  }
  return evalSuites.filter((suite) => names.includes(suite))
}

/** Pin the run's app language, rejecting a tag the app itself would refuse to store. */
const applyAppLanguage = (requested: string | undefined) => {
  if (!requested) {
    return
  }
  const locale = settableLocales.find((candidate) => candidate === requested)
  if (!locale) {
    throw new Error(`EVAL_LANGUAGE must be one of: ${settableLocales.join(', ')}`)
  }
  setActiveLocale(locale)
}

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
  const suites = resolveSuites(process.env.EVAL_SUITES)
  if (!Number.isInteger(necessitySamples) || necessitySamples < 1) {
    throw new Error('EVAL_SAMPLES must be a positive integer')
  }
  // Bun has no localStorage at import time and no navigator.languages, so the app
  // language resolves to `en` for every run unless it is set here. The reply-language
  // suite reads it back for its fallback scenarios.
  applyAppLanguage(process.env.EVAL_LANGUAGE)

  // Necessity and language scenarios are Chat turns, so a mode filter that excludes chat
  // excludes them too.
  const chatScenariosIncluded = !modeFilter || modeFilter.includes('chat')
  const includeSuite = (suite: EvalSuite) => suites.includes(suite)
  const filteredScenarios = [
    ...(includeSuite('core') ? getScenarios(modelFilter, modeFilter, engineFilter) : []),
    ...(includeSuite('necessity') && chatScenariosIncluded ? getNecessityScenarios(modelFilter, engineFilter) : []),
    ...(includeSuite('language') && chatScenariosIncluded ? getLanguageScenarios(modelFilter, engineFilter) : []),
  ]
  const scenarios = smoke ? selectSmokeScenarios(filteredScenarios) : filteredScenarios

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    console.error(`  EVAL_ENGINES=${process.env.EVAL_ENGINES ?? '(all)'}`)
    console.error(`  EVAL_SUITES=${suites.join(',')}`)
    console.error(`  EVAL_LANGUAGE=${getActiveLocale()}`)
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
