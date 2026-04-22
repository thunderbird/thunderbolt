import { getSettings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import OpenAI from 'openai'

export type InferenceProvider = 'fireworks' | 'thunderbolt' | 'mistral' | 'anthropic'

type InferenceClient = {
  client: OpenAI | PostHogOpenAI
  provider: InferenceProvider
}

/**
 * Lazily initialized Fireworks client
 */
let fireworksClient: OpenAI | PostHogOpenAI | null = null

/**
 * Lazily initialized Thunderbolt client
 */
let thunderboltClient: OpenAI | PostHogOpenAI | null = null

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
const getFireworksClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
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
    ...(fetchFn && { fetch: fetchFn }),
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
 * Get the Thunderbolt inference client for gpt-oss
 */
const getThunderboltClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
  // Don't use cache when fetchFn is provided (primarily for testing)
  if (thunderboltClient && !fetchFn) {
    return thunderboltClient
  }

  const settings = getSettings()

  if (!settings.thunderboltInferenceUrl || !settings.thunderboltInferenceApiKey) {
    throw new Error('Thunderbolt inference URL or API key not configured')
  }

  const params = {
    apiKey: settings.thunderboltInferenceApiKey,
    baseURL: settings.thunderboltInferenceUrl,
    ...(fetchFn && { fetch: fetchFn }),
  }

  const client = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  // Only cache if no custom fetchFn was provided
  if (!fetchFn) {
    thunderboltClient = client
  }

  return client
}

/**
 * Get the Mistral AI client using OpenAI-compatible API
 */
const getMistralClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
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
    ...(fetchFn && { fetch: fetchFn }),
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
const getAnthropicClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
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
    ...(fetchFn && { fetch: fetchFn }),
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
export const getInferenceClient = (provider: InferenceProvider, fetchFn?: typeof fetch): InferenceClient => {
  const clientMap: Record<InferenceProvider, () => OpenAI | PostHogOpenAI> = {
    thunderbolt: () => getThunderboltClient(fetchFn),
    mistral: () => getMistralClient(fetchFn),
    anthropic: () => getAnthropicClient(fetchFn),
    fireworks: () => getFireworksClient(fetchFn),
  }

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
  thunderboltClient = null
  mistralClient = null
  anthropicClient = null
}

/**
 * Get an OpenAI-compatible client for a user-supplied custom endpoint.
 *
 * Unlike the other client factories, this is NOT cached — each user request
 * supplies its own baseUrl + apiKey combination. Do not add caching here.
 *
 * @param baseUrl   - Base URL of the custom endpoint (e.g. "https://my-llm.example.com/v1")
 * @param apiKey    - User's API key for the custom endpoint (may be a placeholder if not required)
 * @param fetchFn   - Optional fetch function override (primarily for testing + SSRF-safe fetch injection)
 *
 * The `fetchFn` parameter is how SSRF protection is injected:
 *   getCustomModelClient(baseUrl, apiKey, createSafeFetch(globalThis.fetch))
 *
 * defaultHeaders ensure every upstream request carries the mandatory
 * Thunderbolt-Proxy User-Agent and X-Abuse-Contact.
 */
export const getCustomModelClient = (
  baseUrl: string,
  apiKey: string,
  fetchFn?: typeof fetch,
): OpenAI | PostHogOpenAI => {
  const userAgent = 'Thunderbolt-Proxy/1.0'
  const abuseContact = 'abuse@thunderbolt.io'

  const params = {
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: {
      'User-Agent': userAgent,
      'X-Abuse-Contact': abuseContact,
    },
    ...(fetchFn && { fetch: fetchFn }),
  }

  if (isPostHogConfigured()) {
    return new PostHogOpenAI({
      ...params,
      posthog: getPostHogClient(fetchFn),
    })
  }

  return new OpenAI(params)
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = getFireworksClient
