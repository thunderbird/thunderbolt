import { getSettings } from '@/config/settings'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import OpenAI from 'openai'
import { getPostHogClient, isPostHogConfigured } from './posthog'

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
