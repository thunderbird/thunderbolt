/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { clearPostHogClient, getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { createTestDb } from '@/test-utils/db'
import { mockAuth } from '@/test-utils/mock-auth'
import { isPosthogRequest } from '@/test-utils/posthog'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import type { PostHog } from 'posthog-node'
import { clearInferenceClientCache, getInferenceClient } from './client'
import { createInferenceRoutes } from './routes'

type PostHogEvent = {
  distinct_id?: string
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

type DirectUpstreamRequestBody = {
  model: string
  stream_options: { include_usage: boolean }
}

/** Parse a captured PostHog request body, ignoring endpoints that do not send JSON. */
const parsePostHogRequestBody = (body: string): PostHogRequestBody | null => {
  if (!body) {
    return null
  }
  try {
    return JSON.parse(body) as PostHogRequestBody
  } catch {
    return null
  }
}

/**
 * Integration tests to verify PostHog privacy mode works correctly
 * with real inference client creation
 */
describe('Inference Routes - PostHog Privacy Integration', () => {
  let capturedFetches: FetchCall[] = []
  let mockFetch: typeof fetch
  let originalEnv: Record<string, string | undefined>
  const posthogClients = new Set<PostHog>()

  /** Own each analytics client together with its injected transport until test cleanup. */
  const createTestPostHogClient = (fetchFn: typeof fetch): PostHog => {
    const client = getPostHogClient(fetchFn)
    posthogClients.add(client)
    return client
  }

  beforeEach(() => {
    // Save original env vars
    originalEnv = {
      POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
      POSTHOG_HOST: process.env.POSTHOG_HOST,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
    }

    capturedFetches = []
    mockFetch = jest.fn(async (url: string, options: RequestInit) => {
      // Capture all fetch calls
      const parsedBody = parsePostHogRequestBody(options.body?.toString() ?? '')

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
    try {
      await Promise.all([...posthogClients].map((client) => client.shutdown(100)))
    } finally {
      posthogClients.clear()
      clearInferenceClientCache()
      clearPostHogClient()
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      clearSettingsCache()
      capturedFetches = []
    }
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

      const client = createTestPostHogClient(mockFetch)

      // Verify our workaround is in place
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((client as any).privacy_mode).toBe(true)
      expect(client.options.privacyMode).toBe(true)
    })
  })

  describe('Inference client with PostHog wrapper', () => {
    it.each([
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['fireworks', 'FIREWORKS_API_KEY'],
    ] as const)('keeps an owned PostHog client out of the %s provider cache', (provider, apiKeyName) => {
      process.env[apiKeyName] = 'test-provider-key'
      delete process.env.POSTHOG_API_KEY
      clearSettingsCache()
      clearInferenceClientCache()
      const cachedClient = getInferenceClient(provider).client

      process.env.POSTHOG_API_KEY = 'test-key'
      clearSettingsCache()
      const posthogClient = createTestPostHogClient(mockFetch)
      const injectedClient = getInferenceClient(provider, { posthogClient }).client

      expect(injectedClient.constructor.name).toBe('PostHogOpenAI')
      expect(injectedClient).not.toBe(cachedClient)
      expect(getInferenceClient(provider).client).toBe(cachedClient)
    })

    it('should create PostHogOpenAI client when PostHog is configured', () => {
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const posthogClient = createTestPostHogClient(mockFetch)
      const { client } = getInferenceClient('anthropic', { fetchFn: mockFetch, posthogClient })

      // Verify it's a PostHog-wrapped client
      expect(client.constructor.name).toBe('PostHogOpenAI')
    })

    it('should handle client creation even without PostHog configuration', () => {
      // Note: In this test environment, PostHog might be cached from previous tests
      // The important thing is that the client is created successfully
      delete process.env.POSTHOG_API_KEY
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const { client } = getInferenceClient('anthropic', { fetchFn: mockFetch })

      // Verify client exists and is functional
      expect(client).toBeDefined()
      expect(client.chat).toBeDefined()
      expect(client.chat.completions).toBeDefined()
    })
  })

  describe('End-to-end privacy verification', () => {
    it('preserves direct-route usage accounting and privacy with the real PostHog OpenAI wrapper', async () => {
      const testDb = await createTestDb()
      await testDb.db.insert(user).values({
        id: 'test-user',
        name: 'Test User',
        email: 'test-user@example.com',
        emailVerified: true,
        isAnonymous: false,
      })
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.POSTHOG_HOST = 'https://us.i.posthog.com'
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const secretPrompt = 'ROUTE_POSTHOG_SECRET_PROMPT'
      const usageChunk = Object.freeze({
        id: 'chatcmpl-usage',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'claude-opus-5',
        choices: Object.freeze([]),
        usage: Object.freeze({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }),
      })
      const rawStream =
        'data: {"id":"chatcmpl-content","object":"chat.completion.chunk","created":0,"model":"claude-opus-5","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        `data: ${JSON.stringify(usageChunk)}\n\n` +
        'data: [DONE]\n\n'
      let upstreamRequestBody: DirectUpstreamRequestBody | undefined
      const routeFetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString()
          const requestBody = new Response(
            init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined),
          )
          const bodyText =
            new Headers(init?.headers).get('content-encoding') === 'gzip' && requestBody.body
              ? await new Response(requestBody.body.pipeThrough(new DecompressionStream('gzip'))).text()
              : await requestBody.text()
          if (isPosthogRequest(url)) {
            capturedFetches.push({
              url,
              options: init ?? {},
              body: parsePostHogRequestBody(bodyText),
            })
            return new Response(JSON.stringify({ status: 1 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          upstreamRequestBody = JSON.parse(bodyText) as DirectUpstreamRequestBody
          return new Response(rawStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        },
        { preconnect: () => undefined },
      )
      const posthogClient = createTestPostHogClient(routeFetch)
      const inferenceClient = getInferenceClient('anthropic', { fetchFn: routeFetch, posthogClient })

      try {
        const app = new Elysia().use(
          createInferenceRoutes({ auth: mockAuth, database: testDb.db, getClient: () => inferenceClient }),
        )
        const response = await app.handle(
          new Request('http://localhost/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'opus-5',
              messages: [{ role: 'user', content: secretPrompt }],
              stream: true,
              stream_options: { include_usage: false, client_value: 'ignored' },
            }),
          }),
        )
        const responseText = await response.text()
        await posthogClient.flush()

        expect(response.status).toBe(200)
        expect(upstreamRequestBody).toMatchObject({
          model: 'claude-opus-5',
          stream_options: { include_usage: true },
        })
        expect(upstreamRequestBody?.stream_options).toEqual({ include_usage: true })
        expect(responseText).toContain(`data: ${JSON.stringify(usageChunk)}\n\n`)
        expect(usageChunk).toEqual({
          id: 'chatcmpl-usage',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'claude-opus-5',
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        })

        const rows = await testDb.db.select().from(inferenceUsage).where(eq(inferenceUsage.userId, 'test-user'))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          userId: 'test-user',
          provider: 'anthropic',
          model: 'claude-opus-5',
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
        })

        const postHogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))
        const generationEvents = postHogRequests.flatMap((request) => {
          if (!request.body) {
            return []
          }
          return 'batch' in request.body ? request.body.batch : [request.body]
        })
        const generation = generationEvents.find((event) => event.event === '$ai_generation')
        expect(generation).toMatchObject({
          distinct_id: 'test-user',
          properties: {
            model_provider: 'anthropic',
            model: 'claude-opus-5',
          },
        })
        expect(generation?.properties?.$ai_input).toBeNullOrUndefined()
        expect(generation?.properties?.$ai_output_choices).toBeNullOrUndefined()
        expect(JSON.stringify(postHogRequests)).not.toContain(secretPrompt)
      } finally {
        await testDb.cleanup()
      }
    })

    it('should not send conversation content to PostHog when making completions', async () => {
      process.env.POSTHOG_API_KEY = 'test-key'
      process.env.POSTHOG_HOST = 'https://us.i.posthog.com'
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      // Get the wrapped client with injected mock fetch
      const posthogClient = createTestPostHogClient(mockFetch)
      const { client } = getInferenceClient('anthropic', { fetchFn: mockFetch, posthogClient })

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
          model_provider: 'anthropic',
          endpoint: '/chat/completions',
        },
      })

      // Verify the completion works
      expect(completion).toBeDefined()

      await posthogClient.flush()

      // Find PostHog requests
      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      // If PostHog sent events, verify they don't contain conversation content
      for (const request of posthogRequests) {
        if (!request.body) {
          continue
        }

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
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

      // Clear caches so new env vars are picked up
      clearSettingsCache()
      clearInferenceClientCache()
      clearPostHogClient()

      const posthogClient = createTestPostHogClient(mockFetch)
      const { client } = getInferenceClient('anthropic', { fetchFn: mockFetch, posthogClient })

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

      await posthogClient.flush()

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
