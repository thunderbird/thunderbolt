/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { clearPostHogClient, isPostHogConfigured, shutdownPostHog } from '@/posthog/client'
import { isPosthogRequest } from '@/test-utils/posthog'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { clearInferenceClientCache, getInferenceClient } from './client'

type PostHogEvent = {
  event?: string
  properties?: Record<string, unknown>
}

type PostHogBatchRequest = {
  batch: PostHogEvent[]
}

type PostHogRequestBody = PostHogEvent | PostHogBatchRequest

type FetchCall = {
  url: string
  options: RequestInit
  body: PostHogRequestBody | null
}

/**
 * Integration tests to verify PostHog privacy mode works correctly
 * in the actual inference routes with real client creation
 */
describe('Inference Routes - PostHog Privacy Integration', () => {
  let capturedFetches: FetchCall[] = []
  let mockFetch: typeof fetch
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    // Save original env vars
    originalEnv = {
      POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
      POSTHOG_HOST: process.env.POSTHOG_HOST,
      FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
      THUNDERBOLT_INFERENCE_URL: process.env.THUNDERBOLT_INFERENCE_URL,
      THUNDERBOLT_INFERENCE_API_KEY: process.env.THUNDERBOLT_INFERENCE_API_KEY,
    }

    capturedFetches = []
    mockFetch = jest.fn(async (url: string, options: RequestInit) => {
      // Capture all fetch calls
      let parsedBody: PostHogRequestBody | null = null
      if (options.body) {
        try {
          parsedBody = JSON.parse(options.body as string) as PostHogRequestBody
        } catch {
          // Not JSON, skip parsing
        }
      }

      capturedFetches.push({
        url,
        options,
        body: parsedBody,
      })

      // Return appropriate mock responses based on URL
      if (isPosthogRequest(url)) {
        return new Response(JSON.stringify({ status: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Mock OpenAI/Fireworks completion response
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Secret conversation response',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch
  })

  afterEach(async () => {
    // Clear inference client cache for test isolation
    clearInferenceClientCache()

    // Clear settings and PostHog caches
    clearSettingsCache()

    // Shutdown PostHog with a short timeout (100ms) since we're using mocked fetch
    await shutdownPostHog(100)

    // Clear the PostHog client cache
    clearPostHogClient()

    // Restore original env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    capturedFetches = []
  })

  describe('PostHog client privacy_mode property', () => {
    it('should properly set privacy_mode when PostHog is configured', () => {
      // Set up env for PostHog
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.POSTHOG_HOST = 'https://us.i.posthog.com'

      // Clear settings cache so new env vars are picked up
      clearSettingsCache()

      // This will trigger client initialization
      const configured = isPostHogConfigured()
      expect(configured).toBe(true)

      // Import and check the client
      const { getPostHogClient } = require('@/posthog/client')
      const client = getPostHogClient(mockFetch)

      // Verify our workaround is in place
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((client as any).privacy_mode).toBe(true)
      expect(client.options.privacyMode).toBe(true)
    })
  })

  describe('Inference client with PostHog wrapper', () => {
    it('should create PostHogOpenAI client when PostHog is configured', () => {
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.FIREWORKS_API_KEY = 'test-fireworks-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const { client } = getInferenceClient('fireworks', mockFetch)

      // Verify it's a PostHog-wrapped client
      expect(client.constructor.name).toBe('PostHogOpenAI')
    })

    it('should handle client creation even without PostHog configuration', () => {
      // Note: In this test environment, PostHog might be cached from previous tests
      // The important thing is that the client is created successfully
      delete process.env.POSTHOG_API_KEY
      process.env.FIREWORKS_API_KEY = 'test-fireworks-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const { client } = getInferenceClient('fireworks', mockFetch)

      // Verify client exists and is functional
      expect(client).toBeDefined()
      expect(client.chat).toBeDefined()
      expect(client.chat.completions).toBeDefined()
    })
  })

  describe('End-to-end privacy verification', () => {
    it('should not send conversation content to PostHog when making completions', async () => {
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.POSTHOG_HOST = 'https://us.i.posthog.com'
      process.env.FIREWORKS_API_KEY = 'test-fireworks-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      // Get the wrapped client with injected mock fetch
      const { client } = getInferenceClient('fireworks', mockFetch)

      // Make a completion with sensitive data
      const completion = await (client as PostHogOpenAI).chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'user',
            content: 'This is highly sensitive information that must not be logged to PostHog',
          },
        ],
        posthogDistinctId: 'test-user',
        posthogProperties: {
          model_provider: 'fireworks',
          endpoint: '/chat/completions',
        },
      })

      // Verify the completion works
      expect(completion).toBeDefined()

      // Find PostHog requests
      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      // If PostHog sent events, verify they don't contain conversation content
      for (const request of posthogRequests) {
        if (!request.body) continue

        const batch = 'batch' in request.body ? request.body.batch : [request.body]

        for (const event of batch) {
          const properties = event.properties || {}

          // CRITICAL: Conversation content must NOT be present
          expect(properties.$ai_input).toBeNullOrUndefined()
          expect(properties.$ai_output_choices).toBeNullOrUndefined()

          // But metadata should still be present
          if (event.event === '$ai_generation') {
            // Metadata is allowed
            expect(properties.model_provider || properties.$ai_provider).toBeDefined()
          }
        }
      }

      // Verify that fetch was called for the actual completion
      const completionCalls = capturedFetches.filter((call) => !call.url.includes('posthog'))
      expect(completionCalls.length).toBeGreaterThan(0)
    })

    it('should verify privacy mode prevents content leakage in batch operations', async () => {
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.FIREWORKS_API_KEY = 'test-fireworks-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const { client } = getInferenceClient('fireworks', mockFetch)

      // Make multiple completions
      const conversations = [
        'Secret project details',
        'Confidential user information',
        'Private API keys and credentials',
      ]

      for (const message of conversations) {
        await (client as PostHogOpenAI).chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: message }],
          posthogDistinctId: 'test-user',
        })
      }

      // Check ALL captured PostHog requests
      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      // Verify NONE of the secret messages appear in any request
      for (const request of posthogRequests) {
        const requestStr = JSON.stringify(request)

        // Verify the secret content is NOT in the request
        expect(requestStr.includes('Secret project details')).toBe(false)
        expect(requestStr.includes('Confidential user information')).toBe(false)
        expect(requestStr.includes('Private API keys')).toBe(false)

        // Also check the structured data
        if (request.body) {
          const batch = 'batch' in request.body ? request.body.batch : [request.body]
          for (const event of batch) {
            const properties = event.properties || {}
            expect(properties.$ai_input).toBeNullOrUndefined()
            expect(properties.$ai_output_choices).toBeNullOrUndefined()
          }
        }
      }
    })
  })
})

expect.extend({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toBeNullOrUndefined(received: any) {
    const pass = received === null || received === undefined
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be null or undefined`
          : `Expected ${received} to be null or undefined, but got ${typeof received}`,
    }
  },
})
