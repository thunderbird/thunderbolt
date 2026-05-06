/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { aiFetchStreamingResponse } from '@/ai/fetch'
import { createPrompt } from '@/ai/prompt'
import { getSettings } from '@/dal'
import { getModel } from '@/dal/models'
import { getModelProfile } from '@/dal/model-profiles'
import { getDb } from '@/db/database'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { createAuthenticatedClient } from '@/lib/http'
import type { SaveMessagesFunction } from '@/types'
import { v7 as uuidv7 } from 'uuid'
import { getModelId } from './scenarios'
import { scoreResult } from './scoring'
import { parseStream } from './stream-parser'
import type { EvalResult, EvalScenario } from './types'

const timeout = parseInt(process.env.EVAL_timeout ?? '120000')

let _evalHttpClientPromise: Promise<import('@/lib/http').HttpClient> | null = null
const getEvalHttpClient = () => {
  if (!_evalHttpClientPromise) {
    _evalHttpClientPromise = (async () => {
      const db = getDb()
      const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })
      return createAuthenticatedClient(cloudUrl, getAuthToken, {
        credentials: isSsoMode() ? 'include' : undefined,
      })
    })()
  }
  return _evalHttpClientPromise
}

const dim = '\x1b[2m'
const cyan = '\x1b[36m'
const yellow = '\x1b[33m'
const reset = '\x1b[0m'

const logVerbosePrompt = async (scenario: EvalScenario, modeSystemPrompt: string | undefined) => {
  const { verbose } = await import('./run')
  if (!verbose) {
    return
  }

  const db = getDb()
  const modelId = getModelId(scenario.modelName)
  const [model, profile] = await Promise.all([getModel(db, modelId), getModelProfile(db, modelId)])
  const settings = await getSettings(db, {
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    integrations_do_not_ask_again: false,
    integrations_google_credentials: '',
    integrations_google_is_enabled: false,
    integrations_microsoft_credentials: '',
    integrations_microsoft_is_enabled: false,
  })

  const systemPrompt = createPrompt({
    modelName: model?.name ?? scenario.modelName,
    profile,
    modeName: scenario.modeName,
    preferredName: settings.preferredName,
    location: {
      name: settings.locationName || undefined,
      lat: settings.locationLat ? parseFloat(settings.locationLat) : undefined,
      lng: settings.locationLng ? parseFloat(settings.locationLng) : undefined,
    },
    localization: {
      distanceUnit: settings.distanceUnit,
      temperatureUnit: settings.temperatureUnit,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      currency: settings.currency,
    },
    integrationStatus: 'READY',
    modeSystemPrompt,
  })

  console.log(`\n${cyan}--- SYSTEM PROMPT (${scenario.id}) ---${reset}`)
  console.log(`${dim}${systemPrompt}${reset}`)
  console.log(`${cyan}--- USER PROMPT ---${reset}`)
  console.log(`${dim}${scenario.prompt}${reset}`)
  console.log(`${cyan}--- END PROMPT ---${reset}\n`)
}

const logVerboseResponse = async (scenario: EvalScenario, responseText: string) => {
  const { verbose } = await import('./run')
  if (!verbose) {
    return
  }

  console.log(`\n${yellow}--- RESPONSE (${scenario.id}) ---${reset}`)
  console.log(`${dim}${responseText || '(empty response)'}${reset}`)
  console.log(`${yellow}--- END RESPONSE ---${reset}\n`)
}

/** Run a single evaluation scenario end-to-end (assumes DB is already initialized) */
export const runScenario = async (scenario: EvalScenario): Promise<EvalResult> => {
  const start = performance.now()

  try {
    const modelId = getModelId(scenario.modelName)

    // Look up the mode by name to get the system prompt
    const { defaultModes } = await import('@/defaults/modes')
    const mode = defaultModes.find((m) => m.name === scenario.modeName)
    if (!mode) {
      throw new Error(`Unknown mode: ${scenario.modeName}`)
    }

    // No-op message saver — we don't need persistence for evals
    const saveMessages: SaveMessagesFunction = async () => {}

    // Build request body (matches chat-instance.ts format)
    const body = JSON.stringify({
      messages: [
        {
          id: uuidv7(),
          role: 'user',
          parts: [{ type: 'text', text: scenario.prompt }],
        },
      ],
      id: uuidv7(),
    })

    await logVerbosePrompt(scenario, mode.systemPrompt ?? undefined)

    const httpClient = await getEvalHttpClient()

    // Call the actual AI pipeline with a timeout
    const response = await Promise.race([
      aiFetchStreamingResponse({
        init: { method: 'POST', body },
        saveMessages,
        modelId,
        modeSystemPrompt: mode.systemPrompt ?? undefined,
        modeName: mode.name,
        httpClient,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Scenario timed out')), timeout)),
    ])

    // Parse streaming response
    const parsed = await parseStream(response)
    const durationMs = performance.now() - start

    await logVerboseResponse(scenario, parsed.text)

    return scoreResult(scenario, parsed, durationMs)
  } catch (err) {
    const durationMs = performance.now() - start
    return {
      scenario,
      passed: false,
      failures: [`Runtime error: ${err instanceof Error ? err.message : String(err)}`],
      responseText: '',
      responseLength: 0,
      citations: [],
      widgets: [],
      linkPreviewUrls: [],
      homepageUrls: [],
      reviewSiteUrls: [],
      toolCallCount: 0,
      retryCount: 0,
      durationMs: Math.round(durationMs),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Run scenarios with a worker pool — each slot immediately starts the next scenario when free */
export const runPool = async (scenarios: EvalScenario[], concurrency: number): Promise<EvalResult[]> => {
  const { startSpinner, stopSpinner, printResult } = await import('./ui')

  const results: EvalResult[] = []
  const queue = [...scenarios]

  const worker = async () => {
    while (queue.length > 0) {
      const scenario = queue.shift()!
      startSpinner(scenario)
      const result = await runScenario(scenario)
      stopSpinner(scenario.id)
      printResult(result)
      results.push(result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()))
  return results
}
