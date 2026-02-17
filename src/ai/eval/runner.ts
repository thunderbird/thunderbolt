import { aiFetchStreamingResponse } from '@/ai/fetch'
import { createPrompt } from '@/ai/prompt'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getSettings } from '@/dal'
import { getModel } from '@/dal/models'
import type { SaveMessagesFunction } from '@/types'
import { v7 as uuidv7 } from 'uuid'
import { getModelId } from './scenarios'
import { scoreResult } from './scoring'
import { parseStream } from './stream-parser'
import type { EvalResult, EvalScenario } from './types'

const TIMEOUT = parseInt(process.env.EVAL_TIMEOUT ?? '120000')

const dim = '\x1b[2m'
const cyan = '\x1b[36m'
const yellow = '\x1b[33m'
const reset = '\x1b[0m'

const logVerbosePrompt = async (scenario: EvalScenario, modeSystemPrompt: string | undefined) => {
  const { verbose } = await import('./run')
  if (!verbose) return

  const modelId = getModelId(scenario.modelName)
  const model = await getModel(modelId)
  const settings = await getSettings({
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
    vendor: model?.vendor ?? null,
    model: model?.model ?? null,
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
  if (!verbose) return

  console.log(`\n${yellow}--- RESPONSE (${scenario.id}) ---${reset}`)
  console.log(`${dim}${responseText || '(empty response)'}${reset}`)
  console.log(`${yellow}--- END RESPONSE ---${reset}\n`)
}

/** Run a single evaluation scenario end-to-end */
export const runScenario = async (scenario: EvalScenario): Promise<EvalResult> => {
  const start = performance.now()

  try {
    // Fresh in-memory database for isolation
    await setupTestDatabase()

    const modelId = getModelId(scenario.modelName)

    // Look up the mode by name to get the system prompt
    const { defaultModes } = await import('@/defaults/modes')
    const mode = defaultModes.find((m) => m.name === scenario.modeName)
    if (!mode) throw new Error(`Unknown mode: ${scenario.modeName}`)

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

    // Call the actual AI pipeline with a timeout
    const response = await Promise.race([
      aiFetchStreamingResponse({
        init: { method: 'POST', body },
        saveMessages,
        modelId,
        modeSystemPrompt: mode.systemPrompt ?? undefined,
        modeName: mode.name,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Scenario timed out')), TIMEOUT)),
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
      citations: [],
      linkPreviewUrls: [],
      homepageUrls: [],
      reviewSiteUrls: [],
      toolCallCount: 0,
      retryCount: 0,
      durationMs: Math.round(durationMs),
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await teardownTestDatabase()
  }
}

/** Run multiple scenarios sequentially (for same-model tests sharing a backend) */
export const runSequential = async (scenarios: EvalScenario[]): Promise<EvalResult[]> => {
  const results: EvalResult[] = []
  for (const scenario of scenarios) {
    const result = await runScenario(scenario)
    // Log progress immediately
    const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    const time = `${(result.durationMs / 1000).toFixed(1)}s`
    console.log(`  ${status} ${scenario.id} (${time})${result.failures.length ? ` — ${result.failures[0]}` : ''}`)
    results.push(result)
  }
  return results
}
