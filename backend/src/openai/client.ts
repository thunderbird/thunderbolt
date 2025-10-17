import { getSettings } from '@/config/settings'
import { getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import OpenAI from 'openai'

export const getOpenAI = () => {
  const settings = getSettings()

  if (!settings.fireworksApiKey) {
    throw new Error('Fireworks API key not configured')
  }

  const params = {
    apiKey: settings.fireworksApiKey,
    baseURL: 'https://api.fireworks.ai/inference/v1',
  }

  const openai: OpenAI | PostHogOpenAI = isPostHogConfigured()
    ? new PostHogOpenAI({
        ...params,
        posthog: getPostHogClient(),
      })
    : new OpenAI(params)

  return openai
}
