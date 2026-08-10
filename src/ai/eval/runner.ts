/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPrompt } from '@/ai/prompt'
import { createWebToolBudget, resolveWebToolIntent } from '@/ai/web-tool-budget'
import { getSettings } from '@/dal'
import { getModel } from '@/dal/models'
import { getModelProfile } from '@/dal/model-profiles'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/lib/http'
import { getLocalSetting } from '@/stores/local-settings-store'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { createAuthenticatedClient } from '@/lib/http'
import { createProxyFetch, type FetchFn } from '@/lib/proxy-fetch'
import { extractLastUserText } from '@/skills/resolve-skill-system-messages'
import { v7 as uuidv7 } from 'uuid'
import type { AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { Model, ThunderboltUIMessage } from '@/types'
import { evaluateWithJudge, judgeScenario } from './judge'
import { verbose } from './options'
import { getModelId } from './scenarios'
import { scoreResult } from './scoring'
import { modalResult } from './stats'
import { parseStream } from './stream-parser'
import type { EvalResult, EvalScenario, ParsedStream } from './types'

const timeout = parseInt(process.env.EVAL_TIMEOUT ?? '120000')

let _evalHttpClientPromise: Promise<import('@/lib/http').HttpClient> | null = null
const getEvalHttpClient = () => {
  if (!_evalHttpClientPromise) {
    _evalHttpClientPromise = (async () => {
      const cloudUrl = getLocalSetting('cloudUrl')
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

type EvalAdapterContextOptions = {
  threadId: string
  selectedModel: Model
  messages: ThunderboltUIMessage[]
  httpClient: HttpClient
  getProxyFetch: () => FetchFn
}

/** Build the production adapter context for one eval turn. */
export const createEvalAdapterContext = ({
  threadId,
  selectedModel,
  messages,
  httpClient,
  getProxyFetch,
}: EvalAdapterContextOptions): AgentAdapterContext => ({
  threadId,
  chatThread: null,
  acpSessionId: null,
  saveMessages: async () => {},
  selectedModel,
  mcpClients: [],
  reconnectClient: async () => null,
  httpClient,
  getProxyFetch,
  webToolBudget: createWebToolBudget(resolveWebToolIntent(extractLastUserText(messages))),
  onAcpSessionId: async () => {},
})

/** Fetch and consume one adapter stream, aborting both phases when the turn times out. */
export const fetchAndParseTurn = async (
  adapter: Pick<AgentAdapter, 'fetch'>,
  init: RequestInit,
  context: AgentAdapterContext,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
): Promise<ParsedStream> => {
  const controller = new AbortController()
  const operation = async () => {
    const response = await adapter.fetch({ ...init, signal: controller.signal }, context)
    return parseStream(response, controller.signal)
  }
  const timeoutError = new Error('Scenario timed out')
  const timeoutPromise = new Promise<never>((_, reject) => {
    const cancelTimeout = scheduleTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
    controller.signal.addEventListener('abort', cancelTimeout, { once: true })
  })

  return Promise.race([operation(), timeoutPromise]).finally(() => controller.abort())
}

const logVerbosePrompt = async (scenario: EvalScenario, skillToken: string) => {
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
  })

  const systemPrompt = createPrompt({
    modelName: model?.name ?? scenario.modelName,
    profile,
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
    hasWebTools: true,
  })

  console.log(`\n${cyan}--- SYSTEM PROMPT (${scenario.id}) ---${reset}`)
  console.log(`${dim}${systemPrompt}${reset}`)
  console.log(`${cyan}--- USER PROMPT ---${reset}`)
  // Include the skill token so the log shows the message exactly as sent.
  console.log(`${dim}${skillToken}${scenario.prompt}${reset}`)
  console.log(`${cyan}--- END PROMPT ---${reset}\n`)
}

const logVerboseResponse = async (scenario: EvalScenario, responseText: string) => {
  if (!verbose) {
    return
  }

  console.log(`\n${yellow}--- RESPONSE (${scenario.id}) ---${reset}`)
  console.log(`${dim}${responseText || '(empty response)'}${reset}`)
  console.log(`${yellow}--- END RESPONSE ---${reset}\n`)
}

/** Run a single evaluation scenario end-to-end (assumes DB is already initialized) */
export const runScenario = async (scenario: EvalScenario, adapter: AgentAdapter): Promise<EvalResult> => {
  const start = performance.now()

  try {
    const modelId = getModelId(scenario.modelName)
    const selectedModel = await getModel(getDb(), modelId)
    if (!selectedModel) {
      throw new Error(`Eval model not found in database: ${modelId}`)
    }
    const threadId = uuidv7()

    // Search/Research ship as default skills now (seeded by the eval DB's
    // reconcile pass), so a non-chat scenario invokes its skill the way a
    // user would: a `/slug` token at the start of each user turn, resolved
    // to the skill instruction by the production send path.
    const skillToken = scenario.modeName === 'chat' ? '' : `/${scenario.modeName} `

    await logVerbosePrompt(scenario, skillToken)

    const httpClient = await getEvalHttpClient()

    // Eval runs in Node, not a browser — no React tree, no `ProxyFetchProvider`.
    // Build the proxy fetch directly from the same cloudUrl the HTTP client uses.
    const cloudUrl = getLocalSetting('cloudUrl')
    const proxyFetch = createProxyFetch({ cloudUrl, getProxyAuthToken: getAuthToken })

    const userMessage = (text: string): ThunderboltUIMessage => ({
      id: uuidv7(),
      role: 'user',
      parts: [{ type: 'text', text: `${skillToken}${text}` }],
    })

    const runTurn = async (messages: ThunderboltUIMessage[]): Promise<ParsedStream> => {
      const body = JSON.stringify({ messages, id: uuidv7() })
      const context = createEvalAdapterContext({
        threadId,
        selectedModel,
        messages,
        httpClient,
        getProxyFetch: () => proxyFetch,
      })
      return fetchAndParseTurn(adapter, { method: 'POST', body }, context, timeout)
    }

    // Run every turn but the last to build history, feeding each prior assistant
    // message (with its tool results) back in — exactly as production does.
    // Scoring applies to the final turn, so multi-turn scenarios measure whether
    // the model reuses earlier results instead of re-searching.
    const allTurns = [scenario.prompt, ...(scenario.followUps ?? [])]
    const history: ThunderboltUIMessage[] = []
    for (const text of allTurns.slice(0, -1)) {
      const user = userMessage(text)
      const turn = await runTurn([...history, user])
      if (turn.error || turn.assistantParts.length === 0) {
        throw new Error(
          `Multi-turn setup turn produced no reusable result (${turn.error ?? 'empty assistant message'}) — cannot measure cross-turn reuse`,
        )
      }
      history.push(user, { id: uuidv7(), role: 'assistant', parts: turn.assistantParts })
    }

    const finalUser = userMessage(allTurns.at(-1)!)
    const parsed = await runTurn([...history, finalUser])

    await logVerboseResponse(scenario, parsed.text)

    const deterministicResult = scoreResult(scenario, parsed, performance.now() - start)
    const judgedResult = await evaluateWithJudge(deterministicResult, (signal) =>
      judgeScenario(scenario, parsed.text, () => proxyFetch, signal),
    )
    return { ...judgedResult, durationMs: Math.round(performance.now() - start) }
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
      duplicateToolCallCount: 0,
      retryCount: 0,
      durationMs: Math.round(durationMs),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Run scenarios with a worker pool — each slot immediately starts the next scenario when free */
export const runPool = async (
  scenarios: EvalScenario[],
  concurrency: number,
  adapter: AgentAdapter,
  sampleCountForScenario: (scenario: EvalScenario) => number = () => 1,
): Promise<EvalResult[]> => {
  const { startSpinner, stopSpinner, printResult } = await import('./ui')

  const results: EvalResult[] = []
  const queue = [...scenarios]

  const worker = async () => {
    while (queue.length > 0) {
      const scenario = queue.shift()!
      startSpinner(scenario)
      const samples: EvalResult[] = []
      const sampleRuns = Array.from(
        { length: sampleCountForScenario(scenario) },
        () => () => runScenario(scenario, adapter),
      )
      for (const runSample of sampleRuns) {
        samples.push(await runSample())
      }
      const result = samples.length === 1 ? samples[0] : modalResult(samples)
      stopSpinner(scenario.id)
      printResult(result)
      results.push(result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()))
  return results
}
