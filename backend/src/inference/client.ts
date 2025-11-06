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
 * Get the Fireworks AI client
 */
const getFireworksClient = (): OpenAI | PostHogOpenAI => {
  const settings = getSettings()

  if (!settings.fireworksApiKey) {
    throw new Error('Fireworks API key not configured')
  }

  const params = {
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
  }

  return isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(),
      })
    : new OpenAI(params)
}

/**
 * Get the Thunderbolt inference client for gpt-oss
 */
const getThunderboltClient = (): OpenAI | PostHogOpenAI => {
  const settings = getSettings()

  if (!settings.thunderboltInferenceUrl || !settings.thunderboltInferenceApiKey) {
    throw new Error('Thunderbolt inference URL or API key not configured')
  }

  const params = {
    apiKey: settings.thunderboltInferenceApiKey,
    baseURL: settings.thunderboltInferenceUrl,
  }

  return isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(),
      })
    : new OpenAI(params)
}

/**
 * Get the appropriate inference client based on provider
 */
export const getInferenceClient = (provider: InferenceProvider): InferenceClient => {
  const client = provider === 'thunderbolt' ? getThunderboltClient() : getFireworksClient()

  return {
    client,
    provider,
  }
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use getInferenceClient instead
 */
export const getOpenAI = getFireworksClient
