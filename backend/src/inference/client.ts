/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { elapsedMs } from '@/utils/timing'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'

export type InferenceProvider = 'fireworks' | 'mistral' | 'anthropic' | 'tinfoil'

export type InferenceClient = {
  client: OpenAI | PostHogOpenAI
  provider: InferenceProvider
}

export type InferenceUpstreamAttemptLog = {
  event: 'inference_upstream_attempt'
  provider: InferenceProvider
  attempt: number
  method: string
  host: string
  status: number | null
  duration_ms: number
  retry_after?: string
  rate_limit_headers?: Record<string, string>
}

export type InferenceProxyLatencyLog = {
  event: 'inference_proxy_latency'
  route: string
  provider: InferenceProvider
  model: string
  status: number
  preMs: number
  upstreamMs: number
  totalMs: number
  attempts: number
}

type InferenceLogContext = InferenceUpstreamAttemptLog | InferenceProxyLatencyLog

export type InferenceLogger = {
  info: (context: InferenceLogContext, message: string) => void
}

export type InferenceClientOptions = {
  fetchFn?: typeof fetch
  logger?: InferenceLogger
  /** Monotonic clock used for upstream-attempt instrumentation. */
  nowFn?: () => number
}

type InferenceFetchOptions = InferenceClientOptions & {
  provider: InferenceProvider
}

export type InferenceAttemptTracker = {
  attempts: number
}

const inferenceAttemptStorage = new AsyncLocalStorage<InferenceAttemptTracker>()

/** Create request-local state used to count OpenAI SDK fetch attempts. */
export const createInferenceAttemptTracker = (): InferenceAttemptTracker => ({ attempts: 0 })

/** Run an inference SDK call with request-local attempt counting enabled. */
export const runWithInferenceAttemptTracking = <T>(tracker: InferenceAttemptTracker, callback: () => T): T =>
  inferenceAttemptStorage.run(tracker, callback)

/** Read the one-based attempt index emitted by the OpenAI SDK. */
const getAttemptIndex = (input: RequestInfo | URL, init?: RequestInit): number => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const retryCount = Number(headers.get('X-Stainless-Retry-Count') ?? 0)
  return Number.isFinite(retryCount) ? retryCount + 1 : 1
}

/** Resolve the upstream HTTP method without inspecting request content. */
const getRequestMethod = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

/** Resolve only the upstream hostname, excluding path, query, and credentials. */
const getRequestHost = (input: RequestInfo | URL): string =>
  new URL(input instanceof Request ? input.url : input.toString()).hostname

/** Collect rate-limit diagnostics while preserving upstream header names. */
const getRateLimitHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries([...headers.entries()].filter(([name]) => name.toLowerCase().startsWith('x-ratelimit-')))

/** Emit one structured, body-free log entry for an upstream attempt. */
const logUpstreamAttempt = (
  logger: InferenceLogger | undefined,
  context: Omit<InferenceUpstreamAttemptLog, 'event'>,
) => {
  logger?.info({ event: 'inference_upstream_attempt', ...context }, 'Inference upstream attempt')
}

/** Wrap fetch with safe, per-attempt upstream telemetry for OpenAI-compatible clients. */
export const createInferenceFetch = ({
  provider,
  fetchFn = globalThis.fetch,
  logger,
  nowFn = () => performance.now(),
}: InferenceFetchOptions): typeof fetch => {
  const instrumentedFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const attempt = getAttemptIndex(input, init)
      const tracker = inferenceAttemptStorage.getStore()
      if (tracker) {
        tracker.attempts = Math.max(tracker.attempts, attempt)
      }

      const startedAt = nowFn()
      const requestContext = {
        provider,
        attempt,
        method: getRequestMethod(input, init),
        host: getRequestHost(input),
      }

      try {
        const response = await fetchFn(input, init)
        const rateLimitHeaders = getRateLimitHeaders(response.headers)
        const retryAfter = response.headers.get('retry-after')
        const logContext: Omit<InferenceUpstreamAttemptLog, 'event'> = {
          ...requestContext,
          status: response.status,
          duration_ms: elapsedMs(startedAt, nowFn()),
        }
        if (retryAfter !== null) {
          logContext.retry_after = retryAfter
        }
        if (Object.keys(rateLimitHeaders).length > 0) {
          logContext.rate_limit_headers = rateLimitHeaders
        }
        logUpstreamAttempt(logger, logContext)
        return response
      } catch (error) {
        logUpstreamAttempt(logger, {
          ...requestContext,
          status: null,
          duration_ms: elapsedMs(startedAt, nowFn()),
        })
        throw error
      }
    },
    { preconnect: fetchFn.preconnect },
  )
  return instrumentedFetch
}

/**
 * Lazily initialized Fireworks client
 */
let fireworksClient: OpenAI | PostHogOpenAI | null = null

/**
 * Lazily initialized direct Tinfoil client
 */
let tinfoilDirectClient: OpenAI | PostHogOpenAI | null = null

/**
 * Lazily initialized Mistral client
 */
let mistralClient: OpenAI | PostHogOpenAI | null = null

/**
 * Lazily initialized Anthropic client
 */
let anthropicClient: OpenAI | PostHogOpenAI | null = null

/**
 * Get the Fireworks AI client
 */
const getFireworksClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn } = options
  // Don't use cache when fetchFn is provided (primarily for testing)
  if (fireworksClient && !fetchFn) {
    return fireworksClient
  }

  const settings = getSettings()

  if (!settings.fireworksApiKey) {
    throw new Error('Fireworks API key not configured')
  }

  const params = {
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
    fetch: createInferenceFetch({ provider: 'fireworks', fetchFn, logger, nowFn }),
    // OpenAI SDK defaults to 2 retries; changing maxRetries is a follow-up decision after collecting attempt data.
  }

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  // Only cache if no custom fetchFn was provided
  if (!fetchFn) {
    fireworksClient = client
  }

  return client
}

/**
 * Get the direct Tinfoil OpenAI-compatible client.
 * This path uses standard HTTPS without SecureClient attestation or EHBP.
 */
const getTinfoilDirectClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn } = options
  if (tinfoilDirectClient && !fetchFn) {
    return tinfoilDirectClient
  }

  const settings = getSettings()

  if (!settings.tinfoilApiKey) {
    throw new Error('Tinfoil API key not configured')
  }

  const params = {
    apiKey: settings.tinfoilApiKey,
    baseURL: settings.tinfoilEnclaveUrl.replace(/\/$/, ''),
    fetch: createInferenceFetch({ provider: 'tinfoil', fetchFn, logger, nowFn }),
  }

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (!fetchFn) {
    tinfoilDirectClient = client
  }

  return client
}

/**
 * Get the Mistral AI client using OpenAI-compatible API
 */
const getMistralClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn } = options
  if (mistralClient && !fetchFn) {
    return mistralClient
  }

  const settings = getSettings()

  if (!settings.mistralApiKey) {
    throw new Error('Mistral API key not configured')
  }

  const params = {
    apiKey: settings.mistralApiKey,
    baseURL: 'https://api.mistral.ai/v1',
    fetch: createInferenceFetch({ provider: 'mistral', fetchFn, logger, nowFn }),
  }

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (!fetchFn) {
    mistralClient = client
  }

  return client
}

/**
 * Get the Anthropic AI client using OpenAI-compatible API
 */
const getAnthropicClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn } = options
  if (anthropicClient && !fetchFn) {
    return anthropicClient
  }

  const settings = getSettings()

  if (!settings.anthropicApiKey) {
    throw new Error('Anthropic API key not configured')
  }

  const params = {
    apiKey: settings.anthropicApiKey,
    baseURL: 'https://api.anthropic.com/v1/',
    fetch: createInferenceFetch({ provider: 'anthropic', fetchFn, logger, nowFn }),
  }

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (!fetchFn) {
    anthropicClient = client
  }

  return client
}

/**
 * Get the appropriate inference client based on provider
 * Clients are lazily initialized and reused across requests
 */
export const getInferenceClient = (
  provider: InferenceProvider,
  options: InferenceClientOptions = {},
): InferenceClient => {
  const clientMap = {
    mistral: () => getMistralClient(options),
    anthropic: () => getAnthropicClient(options),
    fireworks: () => getFireworksClient(options),
    tinfoil: () => getTinfoilDirectClient(options),
  } satisfies Record<InferenceProvider, () => OpenAI | PostHogOpenAI>

  const client = clientMap[provider]()

  return {
    client,
    provider,
  }
}

/**
 * Clear cached inference clients
 * Used for testing purposes to ensure test isolation
 */
export const clearInferenceClientCache = () => {
  fireworksClient = null
  tinfoilDirectClient = null
  mistralClient = null
  anthropicClient = null
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = getFireworksClient
