import { getSettings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import OpenAI from 'openai'

export type InferenceProvider = 'fireworks' | 'thunderbolt'

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
 * Get the Fireworks AI client
 */
const getFireworksClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
  if (fireworksClient) {
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

  fireworksClient = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  return fireworksClient
}

/**
 * Get the Thunderbolt inference client for gpt-oss
 */
const getThunderboltClient = (fetchFn?: typeof fetch): OpenAI | PostHogOpenAI => {
  if (thunderboltClient) {
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

  thunderboltClient = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(fetchFn),
      })
    : new OpenAI(params)

  return thunderboltClient
}

/**
 * Get the appropriate inference client based on provider
 * Clients are lazily initialized and reused across requests
 */
export const getInferenceClient = (provider: InferenceProvider, fetchFn?: typeof fetch): InferenceClient => {
  const client = provider === 'thunderbolt' ? getThunderboltClient(fetchFn) : getFireworksClient(fetchFn)

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
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = getFireworksClient
