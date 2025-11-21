import { getSettings } from '@/config/settings'
import { PostHog } from 'posthog-node'

let phClient: PostHog | null = null

/**
 * Initialize and get the PostHog analytics client
 * Uses lazy initialization with settings from environment
 */
export const getPostHogClient = (fetchFn?: typeof fetch): PostHog => {
  if (!phClient) {
    const settings = getSettings()

    if (!settings.posthogApiKey) {
      throw new Error('PostHog API key not configured - set POSTHOG_API_KEY environment variable')
    }

    phClient = new PostHog(settings.posthogApiKey, {
      host: settings.posthogHost,
      privacyMode: true,
      ...(fetchFn && { fetch: fetchFn }),
    })

    // Workaround: PostHog AI library checks for `privacy_mode` property (snake_case)
    // but PostHog Node client only stores it in `options.privacyMode`
    // Manually set it so the AI library can detect it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(phClient as any).privacy_mode = true
  }

  return phClient
}

/**
 * Shutdown the PostHog client (call on app termination)
 */
export const shutdownPostHog = async (timeoutMs = 3000): Promise<void> => {
  if (phClient) {
    await phClient.shutdown(timeoutMs)
    phClient = null
  }
}

/**
 * Check if PostHog is properly configured
 */
export const isPostHogConfigured = (): boolean => {
  const settings = getSettings()
  return !!settings.posthogApiKey
}

/**
 * Clear the PostHog client cache (for testing)
 */
export const clearPostHogClient = (): void => {
  phClient = null
}
