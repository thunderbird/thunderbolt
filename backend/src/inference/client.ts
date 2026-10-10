/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings, type Settings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { elapsedMs } from '@/utils/timing'
import Anthropic from '@anthropic-ai/sdk'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import type { PostHog } from 'posthog-node'
import type { ManagedInferenceIdentity } from './usage-ledger'

export type InferenceProvider = ManagedInferenceIdentity['provider']

export type InferenceClient = {
  client: OpenAI | PostHogOpenAI
  provider: InferenceProvider
}

/** The caller an upstream attempt belongs to, so `/v1/chat` and hosted-agent traffic can be told apart. */
type InferenceUpstreamSource = 'chat' | 'agent'

export type InferenceUpstreamAttemptLog = {
  event: 'inference_upstream_attempt'
  provider: InferenceProvider
  source: InferenceUpstreamSource
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

type InferenceErrorLog = ManagedInferenceIdentity & { event: 'inference_price_unavailable' }

export type InferenceLogger = {
  info: (context: InferenceLogContext, message: string) => void
  /** Optional so info-only test loggers still fit; the app's pino logger provides it. */
  error?: (context: InferenceErrorLog, message: string) => void
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
  /** Labels the upstream-attempt logs; defaults to `chat`. */
  source?: InferenceUpstreamSource
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

/**
 * Wrap fetch with safe, per-call upstream telemetry. `attempt` is read from `X-Stainless-Retry-Count`, which
 * only the OpenAI and Anthropic SDKs send: the AI SDK does not, so each of its calls, retries included, logs
 * as its own entry with `attempt: 1`.
 */
export const createInferenceFetch = ({
  provider,
  fetchFn = globalThis.fetch,
  logger,
  nowFn = () => performance.now(),
  source = 'chat',
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
        source,
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
 * Derive the `/v1` endpoint from the Anthropic API root. It serves both the OpenAI-compatible API and the
 * native Messages API the AI SDK provider calls.
 */
export const getAnthropicV1BaseUrl = (root: string): string => `${root.replace(/\/$/, '')}/v1/`

/** A managed provider called directly with the deployment's own key; tinfoil goes through its enclave instead. */
export type ManagedDirectProvider = Exclude<InferenceProvider, 'tinfoil'>
type ManagedProviderSettings = Pick<Settings, 'anthropicApiKey' | 'anthropicBaseUrl' | 'fireworksApiKey'>

const managedProviderEndpoints = {
  anthropic: (settings) => ({
    name: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    apiKey: settings.anthropicApiKey,
    baseURL: getAnthropicV1BaseUrl(settings.anthropicBaseUrl),
  }),
  fireworks: (settings) => ({
    name: 'Fireworks',
    envVar: 'FIREWORKS_API_KEY',
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
  }),
} satisfies Record<
  ManagedDirectProvider,
  (settings: ManagedProviderSettings) => { name: string; envVar: string; apiKey: string; baseURL: string }
>

/**
 * Key, `/v1` API root and instrumented fetch for one managed provider. The OpenAI SDK constructor and the AI
 * SDK provider factories (`createAnthropic`, `createOpenAICompatible`) all take this shape as-is, so every SDK
 * client of a managed provider shares the per-call telemetry of {@link createInferenceFetch} and the `fetchFn`
 * seam. Throws when the provider's key is unset, so a caller that builds its client at startup fails at startup.
 */
export const createManagedProviderConnection = (
  provider: ManagedDirectProvider,
  settings: ManagedProviderSettings,
  { fetchFn, logger, nowFn, source }: InferenceClientOptions = {},
) => {
  const { name, envVar, apiKey, baseURL } = managedProviderEndpoints[provider](settings)
  if (!apiKey) {
    throw new Error(`${name} API key not configured: set ${envVar}`)
  }
  return { apiKey, baseURL, fetch: createInferenceFetch({ provider, fetchFn, logger, nowFn, source }) }
}

/** Lazily initialized OpenAI-compatible clients, one per provider. */
const openAICompatibleClients = new Map<ManagedDirectProvider, OpenAI | PostHogOpenAI>()
let anthropicMessagesClient: Anthropic | null = null

/**
 * Get the OpenAI-compatible client for a managed direct provider. Cached unless the caller injects its own
 * fetch or analytics client.
 */
const getOpenAICompatibleClient = (
  provider: ManagedDirectProvider,
  options: InferenceClientOptions = {},
): OpenAI | PostHogOpenAI => {
  const { fetchFn, logger, nowFn, posthogClient } = options
  const cacheable = !fetchFn && !posthogClient
  const cached = cacheable ? openAICompatibleClients.get(provider) : undefined
  if (cached) {
    return cached
  }

  // OpenAI SDK defaults to 2 retries; changing maxRetries is a follow-up decision after collecting attempt data.
  const params = createManagedProviderConnection(provider, getSettings(), { fetchFn, logger, nowFn })

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: posthogClient ?? getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  if (cacheable) {
    openAICompatibleClients.set(provider, client)
  }

  return client
}

/**
 * Get the native Anthropic Messages client used by cache-enabled managed models.
 */
export const getAnthropicMessagesClient = (options: InferenceClientOptions = {}): Anthropic => {
  const { fetchFn, logger, nowFn } = options
  if (anthropicMessagesClient && !fetchFn) {
    return anthropicMessagesClient
  }

  const settings = getSettings()
  if (!settings.anthropicApiKey) {
    throw new Error('Anthropic API key not configured')
  }

  const client = new Anthropic({
    apiKey: settings.anthropicApiKey,
    baseURL: settings.anthropicBaseUrl,
    fetch: createInferenceFetch({ provider: 'anthropic', fetchFn, logger, nowFn }),
  })

  if (!fetchFn) {
    anthropicMessagesClient = client
  }
  return client
}

/**
 * Get the appropriate inference client based on provider
 * Clients are lazily initialized and reused across requests
 */
export const getInferenceClient = (
  provider: ManagedDirectProvider,
  options: InferenceClientOptions = {},
): InferenceClient => ({ client: getOpenAICompatibleClient(provider, options), provider })

/**
 * Clear cached inference clients
 * Used for testing purposes to ensure test isolation
 */
export const clearInferenceClientCache = () => {
  openAICompatibleClients.clear()
  anthropicMessagesClient = null
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = (options?: InferenceClientOptions) => getOpenAICompatibleClient('fireworks', options)
