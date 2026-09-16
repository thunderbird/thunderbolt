/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createPrompt } from '@/ai/prompt'
import { createWebToolBudget, resolveWebToolIntent, webToolCaps } from '@/ai/web-tool-budget'
import { getSettings } from '@/dal'
import { getModel } from '@/dal/models'
import { getSkillByName } from '@/dal/skills'
import { getModelProfile } from '@/dal/model-profiles'
import { getDb } from '@/db/database'
import { getActiveLocale } from '@/i18n/active-locale'
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
import { evaluateWithJudge, judgeScenario, requiresJudge, semanticVerdicts, type JudgeVerdict } from './judge'
import { verbose } from './options'
import { getModelId } from './scenarios'
import { getWebToolCalls, scoreResult } from './scoring'
import { getScenarioTurns } from './turns'
import { positiveFinite, serializeArtifact } from './stats'
import { printResult, startSpinner, stopSpinner } from './ui'
import { describeExecutionError, parseStream } from './stream-parser'
import type {
  EvalAttempt,
  EvalCriteria,
  EvalScenario,
  EvalTrial,
  ParsedStream,
  Verdict,
  EvalEvidence,
  EvalTurnResult,
  JudgeTurn,
} from './types'

let evalHttpClient: HttpClient | undefined
const getEvalHttpClient = () =>
  (evalHttpClient ??= createAuthenticatedClient(getLocalSetting('cloudUrl'), getAuthToken, {
    credentials: isSsoMode() ? 'include' : undefined,
  }))

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
  const progress = { parsed: emptyStream(), settled: false }
  const operation = async () => {
    try {
      const response = await adapter.fetch({ ...init, signal: controller.signal }, context)
      const parsed = await parseStream(response, controller.signal, (snapshot) => {
        if (!progress.settled) {
          progress.parsed = snapshot
        }
      })
      return response.ok
        ? parsed
        : { ...parsed, unclassified: false, error: `HTTP ${response.status}: ${parsed.error ?? parsed.text}` }
    } catch (error) {
      return { ...progress.parsed, ...describeExecutionError(error) }
    }
  }
  const timeoutPromise = new Promise<ParsedStream>((resolve) => {
    const cancelTimeout = scheduleTimeout(() => {
      progress.settled = true
      const parsed = structuredClone({ ...progress.parsed, error: 'Scenario timed out', finishReason: 'timeout' })
      controller.abort(new Error('Scenario timed out'))
      resolve(parsed)
    }, timeoutMs)
    controller.signal.addEventListener('abort', cancelTimeout, { once: true })
  })
  try {
    return await Promise.race([operation(), timeoutPromise])
  } finally {
    progress.settled = true
    controller.abort()
  }
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
      timeFormat: settings.timeFormat,
      currency: settings.currency,
    },
    integrationStatus: 'READY',
    hasWebTools: true,
    // Mirror the send path, or this log misreports the fallback reply language.
    appLanguage: getActiveLocale(),
  })

  console.log(`\n${cyan}--- SYSTEM PROMPT (${scenario.id}) ---${reset}`)
  console.log(`${dim}${systemPrompt}${reset}`)
  console.log(`${cyan}--- USER PROMPT ---${reset}`)
  // Include the skill token so the log shows the message exactly as sent.
  console.log(`${dim}${skillToken}${scenario.prompt}${reset}`)
  console.log(`${cyan}--- END PROMPT ---${reset}\n`)
}

const emptyStream = (): ParsedStream => ({
  text: '',
  toolCalls: [],
  assistantParts: [],
  stepCount: 0,
  retryCount: 0,
  finishReason: 'unknown',
  events: [],
})

const traceAssertions = new Set([
  'maxToolCalls',
  'maxSteps',
  'noDuplicateToolCalls',
  'mustNotUseWidgets',
  'noHomepageLinks',
  'noReviewSites',
  'expectResearchSkill',
])

/** Grade each declared deterministic assertion independently; incomplete traces can only prove violations. */
export const deterministicVerdicts = (
  scenario: EvalScenario,
  parsed: ParsedStream,
  completed: boolean,
): Record<string, Verdict> =>
  Object.fromEntries(
    Object.entries(scenario.criteria)
      .filter(([key, value]) => value !== undefined && (value !== false || key === 'expectResearchSkill'))
      .map(([key, value]) => {
        if (
          requiresJudge({ mustProduceOutput: false, [key]: value }) ||
          (!completed && (!traceAssertions.has(key) || (key === 'expectResearchSkill' && value === true)))
        ) {
          return [key, 'unknown']
        }
        const criteria: EvalCriteria = { mustProduceOutput: false, [key]: value }
        const score = scoreResult({ ...scenario, criteria }, { ...parsed, error: undefined }, 0)
        return [key, score.passed ? (completed ? 'pass' : 'unknown') : 'fail']
      }),
  )

/** Pi wraps the original tool result in details; legacy SSE carries it directly. */
const toolOutput = (event: Record<string, unknown>): unknown => {
  const output = event.output
  return output !== null && typeof output === 'object' && 'details' in output ? output.details : output
}

/** Observe successful research-instruction loads and their timing from the same stream evidence used by scoring. */
const observeResearchSkill = (
  streams: ParsedStream[],
  explicitResearch: boolean,
): EvalAttempt['instrumentation']['researchSkill'] => {
  const events = streams.flatMap(({ events }) => events ?? [])
  const researchCalls = events.filter((event) => {
    const name = (event.input as { name?: unknown } | undefined)?.name
    return (
      event.type === 'tool-input-available' &&
      event.toolName === 'skill' &&
      typeof name === 'string' &&
      name.trim().replace(/^\//, '') === 'research'
    )
  })
  const researchCallIds = new Set(researchCalls.map((event) => event.toolCallId))
  const loadedIndex = events.findIndex((event) => {
    const output = toolOutput(event)
    return (
      event.type === 'tool-output-available' &&
      researchCallIds.has(event.toolCallId) &&
      typeof output === 'string' &&
      output.trim().length > 0
    )
  })
  const loaded = explicitResearch || loadedIndex >= 0
  const webResult = events.findIndex(
    (event) =>
      event.type === 'tool-output-available' &&
      streams.some(({ toolCalls }) => getWebToolCalls(toolCalls).some((call) => call.toolCallId === event.toolCallId)),
  )
  return {
    attempted: explicitResearch || researchCalls.length > 0,
    loaded,
    beforeFirstWebResult: loaded && webResult >= 0 ? explicitResearch || loadedIndex < webResult : null,
  }
}

/** Classify recovered tool failures only from the tool event's evidence. */
export const recoveredToolEvents = (streams: ParsedStream[]): EvalAttempt['toolEvents'] => {
  const counts = { toolInfraError: 0, toolMisuse: 0, budgetDenial: 0 }
  const webCallIds = new Set(
    streams.flatMap(({ toolCalls }) => getWebToolCalls(toolCalls).map(({ toolCallId }) => toolCallId)),
  )
  for (const event of streams.flatMap(({ events }) => events ?? [])) {
    if (
      event.type !== 'tool-output-error' &&
      event.type !== 'tool-output-available' &&
      event.type !== 'tool-input-error'
    ) {
      continue
    }
    const output = toolOutput(event) as Record<string, unknown> | undefined
    if (output?.status === 'budget_exhausted') {
      counts.budgetDenial++
      continue
    }
    const message = String(event.errorText ?? output?.error ?? '')
    if (event.type === 'tool-input-error' || /invalid.*(argument|input)|validation|schema/i.test(message)) {
      counts.toolMisuse++
      continue
    }
    if (
      webCallIds.has(String(event.toolCallId)) &&
      (event.type === 'tool-output-error' || output?.success === false || Boolean(message))
    ) {
      counts.toolInfraError++
    }
  }
  return counts
}

/** Keep source IDs from each turn's web-tool outputs; sufficient snippets are evidence too. */
export const extractTurnEvidence = (stream: ParsedStream): EvalEvidence[] => {
  const calls = new Map(getWebToolCalls(stream.toolCalls).map((call) => [call.toolCallId, call.toolName]))
  return (stream.events ?? []).flatMap((event) => {
    const toolName = calls.get(String(event.toolCallId))
    if (event.type !== 'tool-output-available' || (toolName !== 'search' && toolName !== 'fetch_content')) {
      return []
    }
    const output = toolOutput(event)
    return (Array.isArray(output) ? output : [output]).flatMap((value: unknown) => {
      if (!value || typeof value !== 'object') {
        return []
      }
      const source = value as Record<string, unknown>
      const url = source.url ?? source.pageUrl
      const pageStatus = source.pageStatus ?? source.status
      if (typeof source.sourceIndex !== 'number' || typeof url !== 'string') {
        return []
      }
      return [
        {
          sourceIndex: source.sourceIndex,
          url,
          title: String(source.title ?? url),
          text: [source.text, source.snippet].filter((part) => typeof part === 'string' && part.trim()).join('\n'),
          toolName,
          ...(typeof source.publishedDate === 'string' ? { publishedDate: source.publishedDate } : {}),
          ...(typeof pageStatus === 'string' || typeof pageStatus === 'number' ? { pageStatus } : {}),
          ...(typeof source.retrievedAt === 'string' ? { retrievedAt: source.retrievedAt } : {}),
          ...(typeof source.crawledAt === 'string' ? { crawledAt: source.crawledAt } : {}),
          ...(typeof source.observedAt === 'string' ? { observedAt: source.observedAt } : {}),
        },
      ]
    })
  })
}

type EvaluateTurn = (scenario: EvalScenario, conversation: JudgeTurn[], signal: AbortSignal) => Promise<JudgeVerdict>

/** Grade only this turn's declarations, preserving unknowns when generation was interrupted. */
const gradeTurn = async (
  scenario: EvalScenario,
  parsed: ParsedStream,
  durationMs: number,
  conversation: JudgeTurn[],
  evaluate: EvaluateTurn,
): Promise<EvalTurnResult> => {
  const verdicts = deterministicVerdicts(scenario, parsed, !parsed.error)
  const criteria: EvalCriteria = parsed.error
    ? {
        mustProduceOutput: false,
        ...Object.fromEntries(Object.entries(scenario.criteria).filter(([key]) => verdicts[key] === 'fail')),
      }
    : scenario.criteria
  const deterministic = scoreResult({ ...scenario, criteria }, { ...parsed, error: undefined }, durationMs)
  const result = parsed.error
    ? {
        ...deterministic,
        scenario,
        passed: false,
        error: parsed.error,
        failures: [...deterministic.failures, parsed.error],
      }
    : await evaluateWithJudge(deterministic, (signal) => evaluate(scenario, conversation, signal))
  return {
    turn: conversation.length,
    result,
    verdicts: { ...verdicts, ...semanticVerdicts(scenario.criteria, result.judgeVerdict) },
  }
}

/** Execute one isolated trajectory; generation and judging have separate deadlines. */
export const runScenario = async (
  scenario: EvalScenario,
  adapter: AgentAdapter,
  fetchTurn = fetchAndParseTurn,
  evaluateTurn?: EvaluateTurn,
): Promise<EvalAttempt> => {
  const allTurns = getScenarioTurns(scenario)
  const timeout = positiveFinite(process.env.EVAL_TIMEOUT, 600000, 'EVAL_TIMEOUT')
  const start = performance.now()
  const selectedModel = await getModel(getDb(), getModelId(scenario.modelName))
  if (!selectedModel) {
    throw new Error(`Eval model not found in database: ${getModelId(scenario.modelName)}`)
  }
  const profile = await getModelProfile(getDb(), selectedModel.id)
  const researchSkill = await getSkillByName(getDb(), 'research')
  const explicitResearch = scenario.modeName === 'research' && researchSkill?.enabled === 1
  const threadId = uuidv7()
  const skillToken = scenario.modeName === 'chat' ? '' : `/${scenario.modeName} `
  await logVerbosePrompt(scenario, skillToken)
  const httpClient = getEvalHttpClient()
  const proxyFetch = createProxyFetch({ cloudUrl: getLocalSetting('cloudUrl'), getProxyAuthToken: getAuthToken })
  const history: ThunderboltUIMessage[] = []
  const streams: ParsedStream[] = []
  const conversation: JudgeTurn[] = []
  const turnResults: EvalTurnResult[] = []
  const evaluate: EvaluateTurn =
    evaluateTurn ??
    ((turnScenario, turns, signal) =>
      judgeScenario(turnScenario, turns.at(-1)!.responseText, () => proxyFetch, signal, turns))
  const instrumentation: EvalAttempt['instrumentation'] = {
    emitted: 0,
    executed: 0,
    cacheHits: 0,
    initialCap: webToolCaps[scenario.modeName === 'chat' ? 'auto' : scenario.modeName],
    finalCap: webToolCaps[scenario.modeName === 'chat' ? 'auto' : scenario.modeName],
    promoted: false,
    researchSkill: { attempted: scenario.modeName === 'research', loaded: false, beforeFirstWebResult: null },
    preflight: {
      threadId,
      model: selectedModel,
      profile,
      engine: scenario.engineName,
      prompt: scenario.prompt,
      promptCapture: 'unavailable',
      toolsCapture: 'unavailable',
    },
  }
  const state: { setupFailure?: string; scoredTurnReached: boolean; judgeDurationMs: number } = {
    scoredTurnReached: false,
    judgeDurationMs: 0,
  }
  for (const [index, turn] of allTurns.entries()) {
    const turnStart = performance.now()
    const user: ThunderboltUIMessage = {
      id: uuidv7(),
      role: 'user',
      parts: [{ type: 'text', text: `${skillToken}${turn.prompt}` }],
    }
    const messages = [...history, user]
    const context = createEvalAdapterContext({
      threadId,
      selectedModel,
      messages,
      httpClient,
      getProxyFetch: () => proxyFetch,
    })
    const budget = context.webToolBudget!
    const execute = budget.execute
    budget.execute = async (toolName, input, run) => {
      const call = { executed: false }
      const result = await execute(toolName, input, () => {
        call.executed = true
        instrumentation.executed++
        return run()
      })
      if (!call.executed && (result as { status?: string } | null)?.status !== 'budget_exhausted') {
        instrumentation.cacheHits++
      }
      return result
    }
    const remaining = timeout - (performance.now() - start - state.judgeDurationMs)
    state.scoredTurnReached = index === allTurns.length - 1 && remaining > 0
    const parsed =
      remaining <= 0
        ? { ...emptyStream(), error: 'Scenario timed out', finishReason: 'timeout' }
        : await fetchTurn(
            adapter,
            { method: 'POST', body: JSON.stringify({ messages, id: uuidv7() }) },
            context,
            remaining,
          )
    instrumentation.initialCap = budget.initialCap
    instrumentation.finalCap = budget.cap
    instrumentation.promoted = budget.promoted
    parsed.researchSkillLoaded = observeResearchSkill([parsed], explicitResearch).loaded
    streams.push(parsed)
    conversation.push({ prompt: turn.prompt, responseText: parsed.text, evidence: extractTurnEvidence(parsed) })
    if (turn.criteria && (index < allTurns.length - 1 || state.scoredTurnReached)) {
      const turnScenario: EvalScenario = {
        ...scenario,
        prompt: turn.prompt,
        followUps: undefined,
        promptCriteria: undefined,
        promptExpectation: undefined,
        criteria: turn.criteria,
        expectation: turn.expectation,
      }
      const graded = await gradeTurn(
        turnScenario,
        parsed,
        Math.round(performance.now() - turnStart),
        conversation,
        evaluate,
      )
      turnResults.push(graded)
      state.judgeDurationMs += graded.result.judgeAttempts?.reduce((sum, attempt) => sum + attempt.durationMs, 0) ?? 0
      if (!graded.result.passed) {
        break
      }
    }
    if (parsed.error) {
      break
    }
    if (index < allTurns.length - 1 && parsed.text.trim().length === 0) {
      state.setupFailure = 'Multi-turn setup turn produced no reusable answer'
      break
    }
    history.push(user, { id: uuidv7(), role: 'assistant', parts: parsed.assistantParts })
  }
  const parsed = streams.at(-1)!
  const generationDurationMs = Math.round(performance.now() - start - state.judgeDurationMs)
  const onScoredTurn = state.scoredTurnReached
  const verdicts: Record<string, Verdict> = Object.fromEntries(
    turnResults.flatMap(({ turn, verdicts }) =>
      Object.entries(verdicts).map(([key, verdict]) => [
        turn === allTurns.length ? key : `turn${turn}.${key}`,
        verdict,
      ]),
    ),
  )
  if (state.setupFailure) {
    verdicts.setupTurn = 'fail'
  }
  if (parsed.finishReason === 'timeout') {
    verdicts.deadline = 'fail'
  }
  const provenFailure = Object.values(verdicts).includes('fail')
  const scored =
    turnResults.find(({ turn }) => turn === allTurns.length)?.result ??
    scoreResult({ ...scenario, criteria: { mustProduceOutput: false } }, emptyStream(), 0)
  const error = parsed.error ?? turnResults.at(-1)?.result.error
  const result = {
    ...scored,
    scenario,
    error,
    passed: onScoredTurn && !error && !state.setupFailure && turnResults.every(({ result }) => result.passed),
    failures: [
      ...new Set([
        ...turnResults.flatMap(({ turn, result }) =>
          result.failures.map((failure) => (turn === allTurns.length ? failure : `Turn ${turn}: ${failure}`)),
        ),
        ...(state.setupFailure ? [state.setupFailure] : []),
        ...(parsed.error ? [parsed.error] : []),
      ]),
    ],
  }
  const researchObservation = observeResearchSkill(streams, explicitResearch)
  instrumentation.researchSkill = {
    ...researchObservation,
    attempted: instrumentation.researchSkill.attempted || researchObservation.attempted,
  }
  instrumentation.emitted = streams.reduce((sum, stream) => sum + getWebToolCalls(stream.toolCalls).length, 0)
  if (verbose) {
    console.log(`\n${yellow}--- RESPONSE (${scenario.id}) ---${reset}`)
    console.log(`${dim}${JSON.parse(serializeArtifact(parsed.text || '(empty response)'))}${reset}`)
    console.log(`${yellow}--- END RESPONSE ---${reset}\n`)
  }
  const judgeDurationMs = state.judgeDurationMs
  return structuredClone({
    threadId,
    status:
      parsed.finishReason === 'timeout'
        ? 'timeout'
        : parsed.error
          ? 'infra_error'
          : result.error
            ? 'judge_error'
            : 'completed',
    error: result.error,
    errorStack: parsed.errorStack,
    unclassified: parsed.unclassified ?? false,
    generationDurationMs,
    judgeDurationMs,
    streams,
    turnResults,
    scoredTurnReached: onScoredTurn,
    result: { ...result, durationMs: generationDurationMs + judgeDurationMs },
    verdicts,
    provenFailure,
    toolEvents: recoveredToolEvents(streams),
    instrumentation,
  })
}

/** Retry only evidence-classified infrastructure failures, never a proven behavioural failure or timeout. */
export const runTrial = async (
  scenario: EvalScenario,
  index: number,
  execute: () => Promise<EvalAttempt>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<EvalTrial> => {
  const first = await execute()
  const attempts = [first]
  if (first.status === 'infra_error' && !first.unclassified && !first.provenFailure) {
    const stream = first.streams.at(-1)
    if (
      stream?.httpStatus === 429 ||
      /\b429\b|rate.?limit|too many requests/i.test(first.error ?? stream?.error ?? '')
    ) {
      const header = stream?.retryAfter?.trim().replace(/^"(.*)"$/, '$1')
      const delay = header && /^-?\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? '') - Date.now()
      const maxWaitMs = 60000
      if (delay > maxWaitMs) {
        first.retryDecision = 'not_retried_delay_over_window'
        return { id: `${scenario.id}/${index}`, scenario, index, attempts }
      }
      first.retryWaitMs = Number.isFinite(delay) && delay > 0 ? delay : maxWaitMs
      await wait(first.retryWaitMs)
      first.retryDecision = 'waited'
    }
    attempts.push(await execute())
  }
  return { id: `${scenario.id}/${index}`, scenario, index, attempts }
}

/** Keep every sample and persist each completed trial before starting the next one. */
export const runPool = async (
  scenarios: EvalScenario[],
  concurrency: number,
  adapter: AgentAdapter,
  sampleCountForScenario: (scenario: EvalScenario) => number = () => 1,
  onTrial: (trial: EvalTrial) => void = () => {},
  execute: (scenario: EvalScenario, adapter: AgentAdapter) => Promise<EvalAttempt> = runScenario,
): Promise<void> => {
  const queue = [...scenarios]
  const worker = async () => {
    while (queue.length > 0) {
      const scenario = queue.shift()!
      startSpinner(scenario)
      for (const index of Array.from({ length: sampleCountForScenario(scenario) }, (_, index) => index)) {
        const trial = await runTrial(scenario, index, () => execute(scenario, adapter))
        onTrial(trial)
        printResult(trial)
      }
      stopSpinner(scenario.id)
    }
  }
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()),
  )
  const failure = outcomes.find((outcome) => outcome.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
  }
}
