/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { getModel } from '@/dal/models'
import { getDb } from '@/db/database'
import { createClient } from '@/lib/http'
import { getLocalSetting } from '@/stores/local-settings-store'
import { createBuiltInAdapter } from '@/acp/built-in-adapter'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { builtInAgent } from '@/defaults/agents'
import { getActiveLocale, setActiveLocale } from '@/i18n/active-locale'
import { setAuthToken } from '@/lib/auth-token'
import { settableLocales } from '@/i18n/resolve-locale'
import { Storage } from 'happy-dom'
import { getLanguageScenarios } from './language-scenarios'
import { getNecessityScenarios } from './necessity-scenarios'
import { detailed } from './options'
import { appendTrial, generateReport, startTrialJournal } from './report'
import {
  acceptEval,
  aggregateEvalMetrics,
  createManifest,
  getSystemPromptVersion,
  positiveFinite,
  serializeArtifact,
} from './stats'
import { judgeModels, judgePromptVersion } from './judge'
import type { EvalTrial } from './types'
import { runPool } from './runner'
import { getModelId, getScenarios } from './scenarios'
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
  positiveFinite(process.env.EVAL_TIMEOUT, 600000, 'EVAL_TIMEOUT')
  positiveFinite(process.env.EVAL_JUDGE_TIMEOUT, 60000, 'EVAL_JUDGE_TIMEOUT')
  const authToken = process.env.EVAL_AUTH_TOKEN
  if (authToken) {
    setAuthToken(authToken)
  }

  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim())
  const modeFilter = process.env.EVAL_MODES?.split(',').map((s) => s.trim())
  const engineFilter = process.env.EVAL_ENGINES?.split(',').map((s) => s.trim())
  const scenarioFilter = process.env.EVAL_SCENARIOS?.split(',').map((s) => s.trim())
  const scenarioParallel = positiveFinite(process.env.EVAL_SCENARIO_PARALLEL, 3, 'EVAL_SCENARIO_PARALLEL')
  if (!Number.isInteger(scenarioParallel)) {
    throw new Error('EVAL_SCENARIO_PARALLEL must be an integer')
  }
  const necessitySamples = Number(process.env.EVAL_SAMPLES ?? '3')
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
  if (scenarioFilter) {
    const availableIds = new Set(filteredScenarios.map(({ id }) => id.split('/').at(-1)))
    const unknown = scenarioFilter.filter((id) => !availableIds.has(id))
    if (unknown.length > 0) {
      throw new Error(`Unknown EVAL_SCENARIOS for selected filters: ${unknown.join(', ')}`)
    }
  }
  const selectedScenarios = scenarioFilter
    ? filteredScenarios.filter(({ id }) => scenarioFilter.includes(id.split('/').at(-1)!))
    : filteredScenarios
  const scenarios = smoke ? selectSmokeScenarios(selectedScenarios) : selectedScenarios

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    console.error(`  EVAL_ENGINES=${process.env.EVAL_ENGINES ?? '(all)'}`)
    console.error(`  EVAL_SUITES=${suites.join(',')}`)
    console.error(`  EVAL_SCENARIOS=${process.env.EVAL_SCENARIOS ?? '(all)'}`)
    console.error(`  EVAL_LANGUAGE=${getActiveLocale()}`)
    return 1
  }

  await setupTestDatabase()
  const cells = await Promise.all(
    [...new Map(scenarios.map((scenario) => [`${scenario.modelName}/${scenario.engineName}`, scenario])).entries()].map(
      async ([key, scenario]) => {
        const model = await getModel(getDb(), getModelId(scenario.modelName))
        if (!model) {
          throw new Error(`Eval model missing: ${scenario.modelName}`)
        }
        return { key, model: scenario.modelName, engine: scenario.engineName, modelId: model.model }
      },
    ),
  )
  const manifest = createManifest(
    scenarios,
    {
      cells,
      suites: [...suites],
      samples: necessitySamples,
      scenarioConcurrency: Math.min(scenarioParallel, scenarios.length),
      judgeModelId: judgeModels.opus.model,
      judgePromptVersion,
      providerKind: 'unknown',
      preflight: null,
      treatment: {
        generationRevision: {
          commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          overlayCommit: process.env.EVAL_OVERLAY_COMMIT ?? null,
        },
        systemPromptVersion: getSystemPromptVersion(),
        WEB_BUDGET_PROMOTION: process.env.WEB_BUDGET_PROMOTION ?? 'unset',
      },
    },
    process.env,
  )
  const outputPath = process.env.EVAL_OUTPUT ?? 'evals/eval-results.md'
  const trials: EvalTrial[] = []
  const adapter = createBuiltInAdapter(builtInAgent)
  const state = { harnessCrashed: false }
  // The manifest exists even if preflight or the first trajectory fails.
  const journalPath = startTrialJournal(manifest, dirname(outputPath))
  try {
    const config = await createClient({ prefixUrl: getLocalSetting('cloudUrl') })
      .get('config', { timeout: 5000 })
      .json<Record<string, unknown>>()
    manifest.providerKind = typeof config.webToolsProvider === 'string' ? config.webToolsProvider : 'unknown'
    manifest.preflight = JSON.parse(serializeArtifact(config)) as unknown
    startTrialJournal(manifest, dirname(outputPath))
    silenceConsole()
    initLayout(
      scenarios,
      scenarioParallel,
      manifest.scenarios.reduce((sum, { planned }) => sum + planned, 0),
    )
    await runPool(
      scenarios,
      scenarioParallel,
      adapter,
      (scenario) => getScenarioSampleCount(scenario, necessitySamples, smoke),
      (trial) => {
        appendTrial(journalPath, trial)
        trials.push(trial)
      },
    )
  } catch (error) {
    state.harnessCrashed = true
    console.error(JSON.parse(serializeArtifact(String(error))))
  } finally {
    printFooter()
    teardownLayout()
    restoreConsole()
    adapter.disconnect()
    await teardownTestDatabase()
  }
  const metrics = aggregateEvalMetrics(manifest, trials, undefined, state.harnessCrashed)
  generateReport(metrics, detailed, outputPath)
  return acceptEval(metrics).exitCode
}

// Register only the browser API Zustand needs; happy-dom's fetch buffers
// streaming Request responses and deadlocks Tinfoil's encrypted SSE transport.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new Storage(),
})
try {
  process.exit(await main())
} catch (error) {
  console.error(JSON.parse(serializeArtifact(String(error))))
  process.exit(2)
}
