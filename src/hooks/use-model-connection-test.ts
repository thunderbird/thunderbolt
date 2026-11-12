/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { createModel } from '@/ai/fetch'
import { getTinfoilClient } from '@/ai/tinfoil-client'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { Model } from '@/types'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, generateText, tool } from 'ai'
import { isLocalNetworkHost } from '@shared/ip-classification'
import { useCallback, useReducer, useRef } from 'react'
import { z } from 'zod'

/** Whether the tested model accepted a request carrying a tool definition. */
export type ToolSupport = 'supported' | 'unsupported'

export type ModelConnectionConfig = {
  provider: Model['provider']
  model: string
  url?: string | null
  apiKey?: string | null
}

type NormalizedConfig = {
  provider: Model['provider']
  model: string
  url: string | null
  apiKey: string | null
}

/** `loadingModel` is a `testing` run that has waited long enough to suggest a cold model load. */
type ConnectionTestPhase = 'idle' | 'testing' | 'loadingModel' | 'success' | 'error'

type ConnectionTestState = {
  phase: ConnectionTestPhase
  error: string | null
  toolSupport: ToolSupport | null
  tested: NormalizedConfig | null
}

type ConnectionTestAction =
  | { type: 'START'; tested: NormalizedConfig }
  | { type: 'LOADING' }
  | { type: 'SUCCESS'; tested: NormalizedConfig; toolSupport: ToolSupport }
  | { type: 'FAILURE'; tested: NormalizedConfig; error: string }
  | { type: 'RESET' }

const initialState: ConnectionTestState = {
  phase: 'idle',
  error: null,
  toolSupport: null,
  tested: null,
}

const reducer = (state: ConnectionTestState, action: ConnectionTestAction): ConnectionTestState => {
  switch (action.type) {
    case 'START':
      return { phase: 'testing', error: null, toolSupport: null, tested: action.tested }
    case 'LOADING':
      return state.phase === 'testing' ? { ...state, phase: 'loadingModel' } : state
    case 'SUCCESS':
      return { phase: 'success', error: null, toolSupport: action.toolSupport, tested: action.tested }
    case 'FAILURE':
      return { phase: 'error', error: action.error, toolSupport: null, tested: action.tested }
    case 'RESET':
      return initialState
  }
}

const normalize = (config: ModelConnectionConfig): NormalizedConfig => ({
  provider: config.provider,
  model: config.model,
  url: config.url || null,
  apiKey: config.apiKey || null,
})

/** Whether a config targets a Custom endpoint on this device or the local network. */
export const isLocalEndpoint = (config: Pick<NormalizedConfig, 'provider' | 'url'>): boolean => {
  if (config.provider !== 'custom' || !config.url || !URL.canParse(config.url)) {
    return false
  }
  return isLocalNetworkHost(new URL(config.url).hostname)
}

export type ConnectionTestLimits = {
  timeoutMs: number
  /** Delay before a run reports `loadingModel`, or null when it never does. */
  loadingHintAfterMs: number | null
}

/**
 * Time limits for one connection test. Local endpoints get Ollama's default
 * model-load timeout: aborting the request cancels the load, so a short limit
 * would fail every retry of a cold model the same way.
 */
export const connectionTestLimits = (config: Pick<NormalizedConfig, 'provider' | 'url'>): ConnectionTestLimits =>
  isLocalEndpoint(config)
    ? { timeoutMs: 300_000, loadingHintAfterMs: 5_000 }
    : { timeoutMs: 10_000, loadingHintAfterMs: null }

const sameConfig = (left: NormalizedConfig, right: NormalizedConfig): boolean =>
  left.provider === right.provider &&
  left.model === right.model &&
  left.url === right.url &&
  left.apiKey === right.apiKey

/**
 * Probe that issues a real `generateText` round-trip against the configured
 * provider and reports whether the model accepts tools. Split out so tests can
 * swap in a synchronous stub without touching global module mocks.
 */
export type ConnectionTestProbe = (
  config: NormalizedConfig,
  getProxyFetch: () => FetchFn,
  signal: AbortSignal,
) => Promise<ToolSupport>

type DefaultProbeDependencies = {
  getTinfoilClient?: typeof getTinfoilClient
  createModel?: typeof createModel
  generateText?: typeof generateText
}

/** Build the temporary model row consumed by the shared provider factory. */
const connectionTestModel = (config: NormalizedConfig): Model => ({
  id: 'test',
  name: 'Test Model',
  provider: config.provider,
  model: config.model,
  url: config.url,
  apiKey: config.apiKey,
  isSystem: 0,
  enabled: 1,
  toolUsage: 1,
  isConfidential: 0,
  startWithReasoning: 0,
  reasoningEffort: null,
  supportsParallelToolCalls: 1,
  contextWindow: null,
  deletedAt: null,
  defaultHash: null,
  vendor: null,
  description: null,
  userId: null,
})

/** Build a BYOK Tinfoil probe model over an attested enclave client. */
const createTinfoilProbeModel = async (config: NormalizedConfig, acquireClient: typeof getTinfoilClient) => {
  if (!config.apiKey) {
    throw new Error('No API key provided')
  }
  const client = await acquireClient()
  const provider = createOpenAICompatible({
    name: 'tinfoil',
    baseURL: client.getBaseURL()!,
    apiKey: config.apiKey,
    fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => client.fetch(input, init), {
      preconnect: () => Promise.resolve(false),
    }),
  })
  return provider(config.model)
}

const probeTools = {
  get_current_time: tool({ description: 'Returns the current time.', inputSchema: z.object({}) }),
}

/** Statuses that say nothing about tool support: auth, request timeout, rate limit. */
const nonVerdictStatuses: ReadonlySet<number> = new Set([401, 403, 408, 429])

/**
 * Whether a failed tools request is worth retrying without tools. Providers
 * reject tools with different statuses (Ollama and vLLM 400, OpenRouter 404,
 * llama.cpp 500), so the verdict comes from the retry succeeding, not the status.
 */
const isToolRejectionCandidate = (error: unknown): boolean =>
  APICallError.isInstance(error) && error.statusCode !== undefined && !nonVerdictStatuses.has(error.statusCode)

/** A 5xx can be a passing outage as well as a rejection (llama.cpp rejects tools with a 500). */
const isServerError = (error: unknown): boolean =>
  APICallError.isInstance(error) && error.statusCode !== undefined && error.statusCode >= 500

/** Create the real Settings model probe with injectable external boundaries. */
export const createDefaultProbe =
  ({
    getTinfoilClient: acquireTinfoilClient = getTinfoilClient,
    createModel: createAiModel = createModel,
    generateText: runGenerateText = generateText,
  }: DefaultProbeDependencies = {}): ConnectionTestProbe =>
  async (config, getProxyFetch, signal) => {
    const aiModel =
      config.provider === 'tinfoil'
        ? await createTinfoilProbeModel(config, acquireTinfoilClient)
        : await createAiModel(connectionTestModel(config), getProxyFetch)
    const request = {
      model: aiModel,
      prompt: 'Say "test successful" if you can read this.',
      maxRetries: 0,
      abortSignal: signal,
    }
    // Through the AI SDK, so the probe sends what real chats send (tool_choice included).
    const sendWithTools = () => runGenerateText({ ...request, tools: probeTools })
    try {
      await sendWithTools()
      return 'supported'
    } catch (error) {
      if (!isToolRejectionCandidate(error)) {
        throw error
      }
      await runGenerateText(request)
      if (!isServerError(error)) {
        return 'unsupported'
      }
      // After a 5xx, only a second failure with tools counts as a rejection.
      try {
        await sendWithTools()
        return 'supported'
      } catch (confirmationError) {
        if (!isToolRejectionCandidate(confirmationError)) {
          throw confirmationError
        }
        return 'unsupported'
      }
    }
  }

const defaultProbe = createDefaultProbe()

/** Abort signal plus a promise that rejects with a readable error when it fires. */
const startTimeout = (timeoutMs: number) => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutSignal.addEventListener('abort', () =>
      reject(new Error(`Connection test timed out after ${timeoutMs / 1000} seconds`)),
    )
  })
  return { timeoutSignal, timeoutPromise }
}

/**
 * Manages the state machine for a "Test Model" round-trip: idle → testing →
 * success/error. Returns `isTesting`, `status`, and `error` derived at render
 * time from the tested config vs. the current one: any credential divergence
 * collapses all three to their idle values in the same render, so a stale
 * `'success'` can't survive a credential edit and a mid-flight edit stops the
 * spinner immediately (no useEffect-based invalidation).
 *
 * The probe is bounded by a single `AbortSignal.timeout` piped through both
 * the provider construction (via `Promise.race`) and the `generateText`
 * request (via `abortSignal`), so a hanging Tinfoil attestation or a stuck
 * `generateText` request both surface as a timeout error. Local endpoints get
 * a longer limit because a cold model load can take minutes, and after a few
 * seconds `isLoadingModel` turns on so the UI can say why it is waiting.
 *
 * `test` resolves with the tool-support verdict so the caller can apply it in
 * its event handler, or `null` when the run was superseded or the config was
 * edited mid-flight — a verdict for a config the form no longer shows.
 */
export const useModelConnectionTest = (current: ModelConnectionConfig, probe: ConnectionTestProbe = defaultProbe) => {
  const { t } = useLingui()
  const getProxyFetch = useProxyFetchGetter()
  const [state, dispatch] = useReducer(reducer, initialState)
  const runIdRef = useRef(0)
  const normalizedCurrent = normalize(current)
  const latestConfigRef = useRef(normalizedCurrent)
  latestConfigRef.current = normalizedCurrent

  const test = useCallback(
    async (config: ModelConnectionConfig): Promise<ToolSupport | null> => {
      const runId = ++runIdRef.current
      const isCurrent = () => runIdRef.current === runId

      const tested = normalize(config)
      dispatch({ type: 'START', tested })

      const { timeoutMs, loadingHintAfterMs } = connectionTestLimits(tested)
      const { timeoutSignal, timeoutPromise } = startTimeout(timeoutMs)
      const loadingTimer =
        loadingHintAfterMs === null
          ? undefined
          : setTimeout(() => isCurrent() && dispatch({ type: 'LOADING' }), loadingHintAfterMs)
      const runPromise = probe(tested, getProxyFetch, timeoutSignal)

      try {
        const toolSupport = await Promise.race([runPromise, timeoutPromise])
        if (!isCurrent()) {
          return null
        }
        dispatch({ type: 'SUCCESS', tested, toolSupport })
        return sameConfig(tested, latestConfigRef.current) ? toolSupport : null
      } catch (err) {
        console.error('Connection test error:', err)
        if (!isCurrent()) {
          return null
        }
        dispatch({
          type: 'FAILURE',
          tested,
          error: err instanceof Error ? err.message : t`Failed to connect to model`,
        })
        return null
      } finally {
        clearTimeout(loadingTimer)
      }
    },
    [getProxyFetch, probe],
  )

  const reset = useCallback(() => {
    runIdRef.current += 1
    dispatch({ type: 'RESET' })
  }, [])

  const matchesCurrent = state.tested !== null && sameConfig(state.tested, normalizedCurrent)

  const phase = matchesCurrent ? state.phase : 'idle'
  const isLoadingModel = phase === 'loadingModel'
  const isTesting = phase === 'testing' || isLoadingModel
  const status: 'idle' | 'success' | 'error' = phase === 'success' || phase === 'error' ? phase : 'idle'
  const error = matchesCurrent ? state.error : null
  const toolSupport = matchesCurrent ? state.toolSupport : null

  return { isTesting, isLoadingModel, status, error, toolSupport, test, reset }
}

/** What a model form reads from {@link useModelConnectionTest}. */
export type ModelConnectionTest = ReturnType<typeof useModelConnectionTest>
