/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import type { InferenceErrorKind } from '@/inference/error-kind'
import { managedDirectRuntimes } from '@/inference/managed-models'
import { PostHog } from 'posthog-node'

let phClient: PostHog | null = null

const analyticsModels = new Set<string>([
  ...Object.keys(managedDirectRuntimes),
  ...Object.values(managedDirectRuntimes).map(({ internalName }) => internalName),
])

// Keep metrics and fixed provider metadata, never account, request, trace, or conversation identifiers.
const analyticsPropertyKeys = new Set([
  'provider',
  'status',
  'errorKind',
  'model',
  'phase',
  'model_provider',
  'endpoint',
  'has_tools',
  'temperature',
  '$ai_lib',
  '$ai_lib_version',
  '$ai_provider',
  '$ai_model',
  '$ai_http_status',
  '$ai_is_error',
  '$ai_input_tokens',
  '$ai_output_tokens',
  '$ai_reasoning_tokens',
  '$ai_cache_read_input_tokens',
  '$ai_cache_creation_input_tokens',
  '$ai_web_search_count',
  '$ai_latency',
  '$ai_time_to_first_token',
  '$ai_tokens_source',
  '$ai_input_cost_usd',
  '$ai_output_cost_usd',
  '$ai_total_cost_usd',
])

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
  Object.assign(client, { privacy_mode: true })

  // SDK privacy mode does not remove identifiers or tool schemas. Enforce the analytics privacy boundary here.
  const originalCapture: PostHog['capture'] = client.capture.bind(client)
  client.capture = (message: Parameters<PostHog['capture']>[0]): void => {
    const properties = Object.fromEntries(
      Object.entries(message.properties ?? {}).filter(([key, value]) =>
        key === 'model' || key === '$ai_model'
          ? typeof value === 'string' && analyticsModels.has(value)
          : analyticsPropertyKeys.has(key),
      ),
    )
    originalCapture({
      event: message.event,
      distinctId: crypto.randomUUID(),
      disableGeoip: true,
      properties: {
        ...properties,
        $process_person_profile: false,
      },
    })
  }

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
  errorKind: InferenceErrorKind
  model?: string
  phase?: 'stream'
}

/**
 * Records an upstream inference failure without shipping request or response
 * content or joinable identifiers. No-op when PostHog is unconfigured.
 */
export const captureInferenceError = ({ provider, status, errorKind, model, phase }: InferenceErrorEvent): void => {
  if (!isPostHogConfigured()) {
    return
  }
  getPostHogClient().capture({
    event: 'inference_upstream_error',
    properties: {
      provider,
      status,
      errorKind,
      ...(model !== undefined && { model }),
      ...(phase !== undefined && { phase }),
    },
  })
}

/**
 * Clear the PostHog client cache (for testing)
 */
export const clearPostHogClient = (): void => {
  phClient = null
}
