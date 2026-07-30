/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { PostHog } from 'posthog-node'

let phClient: PostHog | null = null

/**
 * Initialize and get the PostHog analytics client
 * Uses lazy initialization with settings from environment
 */
export const getPostHogClient = (fetchFn?: typeof fetch): PostHog => {
  // Don't use cache when fetchFn is provided (primarily for testing)
  if (phClient && !fetchFn) {
    return phClient
  }

  const settings = getSettings()

  if (!settings.posthogApiKey) {
    throw new Error('PostHog API key not configured - set POSTHOG_API_KEY environment variable')
  }

  const client = new PostHog(settings.posthogApiKey, {
    host: settings.posthogHost,
    privacyMode: true,
    ...(fetchFn && { fetch: fetchFn }),
  })

  // Workaround: PostHog AI library checks for `privacy_mode` property (snake_case)
  // but PostHog Node client only stores it in `options.privacyMode`
  // Manually set it so the AI library can detect it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(client as any).privacy_mode = true

  // Only cache if no custom fetchFn was provided
  if (!fetchFn) {
    phClient = client
  }

  return client
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

export type InferenceErrorEvent = {
  provider: string
  status: number
  distinctId: string
  model?: string
  detail?: string
}

/**
 * Record an upstream inference failure so the real provider error (status,
 * message, model) stays queryable. `safeErrorHandler` strips the cause from the
 * client response for security and stdout logs aren't retained, so a captured
 * event is the only durable record of why a send 400'd. No-op when PostHog is
 * unconfigured.
 */
export const captureInferenceError = ({ provider, status, distinctId, model, detail }: InferenceErrorEvent): void => {
  if (!isPostHogConfigured()) {
    return
  }
  getPostHogClient().capture({
    distinctId,
    event: 'inference_upstream_error',
    properties: { provider, status, model, detail },
  })
}

/**
 * Clear the PostHog client cache (for testing)
 */
export const clearPostHogClient = (): void => {
  phClient = null
}
