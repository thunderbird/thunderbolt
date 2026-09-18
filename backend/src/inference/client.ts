/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { elapsedMs } from '@/utils/timing'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import type { PostHog } from 'posthog-node'
import type { ManagedInferenceIdentity } from './usage-ledger'

export type InferenceProvider = 'fireworks' | 'anthropic' | 'tinfoil'

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
  upstreamMs: number | null
  totalMs: number
  attempts: number
}

export type InferenceUsageLog =
  | {
      event: 'inference_usage_completed'
      provider: InferenceProvider
      model: string
      eventId: string
      transport: 'direct'
    }
  | {
      event: 'inference_usage_inserted'
      provider: InferenceProvider
      model: string
      eventId: string
      outcome: 'inserted' | 'duplicate'
    }
  | (ManagedInferenceIdentity & {
      event: 'inference_usage_receipt_issued'
      eventId: string
      route: string
    })

export type InferenceRouteLog =
  | ({ provider: InferenceProvider; model: string; route: string } & (
      | { event: 'inference_connection_timeout' }
      | { event: 'inference_connection_failed' }
      | { event: 'inference_usage_missing' }
      | { event: 'inference_usage_callback_failed' }
    ))
  | InferenceUsageLog

type InferenceLogContext = InferenceUpstreamAttemptLog | InferenceProxyLatencyLog | InferenceRouteLog

export type InferenceLogger = {
  info: (context: InferenceLogContext, message: string) => void
}

/** Emit inference telemetry without allowing logger failures to alter request control flow. */
export const logInferenceSafely = (
  logger: InferenceLogger | undefined,
  context: InferenceLogContext,
  message: string,
): void => {
  try {
    logger?.info(context, message)
  } catch {
    // Inference behavior must not depend on usage telemetry availability.
  }
}

export type InferenceClientOptions = {
  /** Caller-owned analytics client; never stored in the provider cache. */
  posthogClient?: PostHog
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
 * Lazily initialized Anthropic client
 */
let anthropicClient: OpenAI | PostHogOpenAI | null = null

/**
 * Get the Fireworks AI client
 */
const getFireworksClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn, posthogClient } = options
  if (fireworksClient && !fetchFn && !posthogClient) {
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
        posthog: posthogClient ?? getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (!fetchFn && !posthogClient) {
    fireworksClient = client
  }

  return client
}

/**
 * Get the Anthropic AI client using OpenAI-compatible API
 */
const getAnthropicClient = (options: InferenceClientOptions = {}): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn, posthogClient } = options
  if (anthropicClient && !fetchFn && !posthogClient) {
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
        posthog: posthogClient ?? getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (!fetchFn && !posthogClient) {
    anthropicClient = client
  }

  return client
}

/**
 * Get the appropriate inference client based on provider
 * Clients are lazily initialized and reused across requests
 */
export const getInferenceClient = (
  provider: Exclude<InferenceProvider, 'tinfoil'>,
  options: InferenceClientOptions = {},
): InferenceClient => {
  const clientMap = {
    anthropic: () => getAnthropicClient(options),
    fireworks: () => getFireworksClient(options),
  } satisfies Record<Exclude<InferenceProvider, 'tinfoil'>, () => OpenAI | PostHogOpenAI>

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
  anthropicClient = null
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = getFireworksClient
