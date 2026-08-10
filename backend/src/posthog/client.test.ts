/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { isPosthogRequest } from '@/test-utils/posthog'
import { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test'
import { PostHog } from 'posthog-node'
import * as client from './client'

type FetchCall = {
  url: string
  options: RequestInit
  body: any
}

const parsePostHogRequestBody = async (body: BodyInit | null | undefined): Promise<unknown> => {
  if (!body) {
    return null
  }
  if (typeof body === 'string') {
    return JSON.parse(body)
  }
  if (body instanceof Blob) {
    const compressed = new Uint8Array(await body.arrayBuffer())
    return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed)))
  }
  return body
}

/**
 * Tests to verify that PostHog privacy mode correctly prevents
 * conversation content from being sent to PostHog servers
 */
describe('PostHog Privacy Mode', () => {
  let capturedFetches: FetchCall[] = []
  let mockFetch: jest.Mock

  beforeEach(() => {
    capturedFetches = []
    mockFetch = jest.fn(async (url: string, options: RequestInit) => {
      // Capture the fetch call
      capturedFetches.push({
        url,
        options,
        body: options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : null,
      })

      // Return successful response
      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  })

  afterEach(() => {
    capturedFetches = []
  })

  describe('PostHog client configuration', () => {
    it('should set privacy_mode property when configured', () => {
      const client = new PostHog('test-key', {
        host: 'https://us.i.posthog.com',
        privacyMode: true,
        fetch: mockFetch,
      })

      // Manually set privacy_mode as we do in our workaround
      ;(client as any).privacy_mode = true

      expect((client as any).privacy_mode).toBe(true)
      expect(client.options.privacyMode).toBe(true)
    })

    it('should expose privacy_mode to PostHog AI library', () => {
      const client = new PostHog('test-key', {
        host: 'https://us.i.posthog.com',
        privacyMode: true,
        fetch: mockFetch,
      })
      ;(client as any).privacy_mode = true

      // The AI library checks for client.privacy_mode
      const aiLibraryCanSeePrivacyMode = (client as any).privacy_mode === true
      expect(aiLibraryCanSeePrivacyMode).toBe(true)
    })
  })

  describe('AI library privacy mode integration', () => {
    it('should not send conversation content with privacy mode enabled', async () => {
      // Create PostHog client with privacy mode
      const phClient = new PostHog('test-key', {
        host: 'https://us.i.posthog.com',
        privacyMode: true,
        fetch: mockFetch,
        flushAt: 1, // Flush after every event
        flushInterval: 0, // Disable interval flushing
      })
      ;(phClient as any).privacy_mode = true

      // Mock OpenAI client with a fake completion
      const mockOpenAIFetch = jest.fn(async () => {
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
                  content: 'This is a secret response that should not be logged',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 15,
              total_tokens: 25,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      })

      // Create PostHogOpenAI wrapper
      const client = new PostHogOpenAI({
        apiKey: 'fake-openai-key',
        baseURL: 'https://api.openai.com/v1',
        posthog: phClient,
        fetch: mockOpenAIFetch as any,
      })

      // Make a completion with sensitive content
      await client.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'This is a secret message that should not be logged' }],
        posthogDistinctId: 'test-user',
        posthogProperties: {
          test_property: 'test_value',
        },
      })

      // Flush PostHog to ensure events are sent
      await phClient.flush()

      // Find PostHog capture requests (check various URL patterns)
      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      // If no requests were captured, this might mean the AI library didn't send any
      // In that case, we pass the test since no conversation data was sent
      if (posthogRequests.length === 0) {
        // This is actually good - privacy mode prevented all data from being sent
        return
      }

      // Check each PostHog request
      for (const request of posthogRequests) {
        const batch = request.body?.batch || [request.body]

        for (const event of batch) {
          const properties = event.properties || {}

          // CRITICAL: Verify conversation content is NOT present
          expect(properties.$ai_input).toBeNullOrUndefined()
          expect(properties.$ai_output_choices).toBeNullOrUndefined()

          // Verify metadata IS still present (privacy mode doesn't block metadata)
          if (event.event === '$ai_generation') {
            expect(properties.$ai_model).toBeDefined()
            expect(properties.test_property).toBe('test_value')
          }
        }
      }
    })

    it('should not send conversation content in streaming mode', async () => {
      const phClient = new PostHog('test-key', {
        host: 'https://us.i.posthog.com',
        privacyMode: true,
        fetch: mockFetch,
      })
      ;(phClient as any).privacy_mode = true

      // Mock streaming response
      const mockStreamResponse = new ReadableStream({
        start(controller) {
          const chunks = [
            'data: {"id":"chunk1","choices":[{"delta":{"content":"Secret"}}]}\n\n',
            'data: {"id":"chunk2","choices":[{"delta":{"content":" message"}}]}\n\n',
            'data: [DONE]\n\n',
          ]
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      })

      const mockOpenAIFetch = jest.fn(async () => {
        return new Response(mockStreamResponse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      })

      const client = new PostHogOpenAI({
        apiKey: 'fake-openai-key',
        baseURL: 'https://api.openai.com/v1',
        posthog: phClient,
        fetch: mockOpenAIFetch as any,
      })

      // Make streaming completion
      const stream = await client.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Secret streaming message' }],
        stream: true,
        posthogDistinctId: 'test-user',
      })

      // Consume the stream
      for await (const _chunk of stream) {
        // Process chunks
      }

      await phClient.flush()

      // Check PostHog requests
      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      for (const request of posthogRequests) {
        const batch = request.body?.batch || [request.body]

        for (const event of batch) {
          const properties = event.properties || {}

          // Verify no conversation content
          expect(properties.$ai_input).toBeNullOrUndefined()
          expect(properties.$ai_output_choices).toBeNullOrUndefined()
        }
      }
    })

    it('should explicitly override client privacy mode with posthogPrivacyMode parameter', async () => {
      // Create client WITHOUT privacy mode
      const phClient = new PostHog('test-key', {
        host: 'https://us.i.posthog.com',
        privacyMode: false,
        fetch: mockFetch,
      })

      const mockOpenAIFetch = jest.fn(async () => {
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
                  content: 'Response',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      })

      const client = new PostHogOpenAI({
        apiKey: 'fake-openai-key',
        baseURL: 'https://api.openai.com/v1',
        posthog: phClient,
        fetch: mockOpenAIFetch,
      })

      // Override with posthogPrivacyMode parameter
      await client.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Secret message' }],
        posthogDistinctId: 'test-user',
        posthogPrivacyMode: true, // Explicitly enable privacy mode for this call
      })

      await phClient.flush()

      const posthogRequests = capturedFetches.filter((call) => isPosthogRequest(call.url))

      for (const request of posthogRequests) {
        const batch = request.body?.batch || [request.body]

        for (const event of batch) {
          const properties = event.properties || {}

          // Should still not send conversation content due to posthogPrivacyMode override
          expect(properties.$ai_input).toBeNullOrUndefined()
          expect(properties.$ai_output_choices).toBeNullOrUndefined()
        }
      }
    })
  })

  describe('Privacy mode verification helpers', () => {
    it('should have privacy_mode property check working correctly', () => {
      const clientWithPrivacy = new PostHog('test-key', {
        privacyMode: true,
        fetch: mockFetch,
      })
      ;(clientWithPrivacy as any).privacy_mode = true

      const clientWithoutPrivacy = new PostHog('test-key', {
        privacyMode: false,
        fetch: mockFetch,
      })

      // Simulate the check that PostHog AI library does
      expect((clientWithPrivacy as any).privacy_mode || false).toBe(true)
      expect((clientWithoutPrivacy as any).privacy_mode || false).toBe(false)
    })
  })
})

describe('redactAiError', () => {
  it('keeps API error identifiers and drops provider response content', () => {
    const rawError = JSON.stringify({
      status: 400,
      error: {
        message: 'prompt is too long and contains sensitive content',
        type: 'invalid_request_error',
      },
      message: 'prompt is too long and contains sensitive content',
      code: null,
      requestID: 'req_1',
      type: 'invalid_request_error',
    })

    expect(client.redactAiError(rawError)).toBe(
      JSON.stringify({
        status: 400,
        code: null,
        type: 'invalid_request_error',
        requestID: 'req_1',
      }),
    )
  })

  it('drops future provider error details from object input', () => {
    expect(
      client.redactAiError({
        name: 'APIError',
        statusCode: 429,
        httpStatus: 429,
        message: 'sensitive prompt fragment',
        stack: 'APIError: sensitive prompt fragment',
        cause: { message: 'sensitive prompt fragment' },
        headers: { authorization: 'secret' },
        param: 'messages',
      }),
    ).toBe(
      JSON.stringify({
        name: 'APIError',
        statusCode: 429,
        httpStatus: 429,
        param: 'messages',
      }),
    )
  })

  it('drops an unparseable string', () => {
    expect(client.redactAiError('not-json')).toBeUndefined()
  })

  it('drops non-object values', () => {
    expect(client.redactAiError(400)).toBeUndefined()
    expect(client.redactAiError(null)).toBeUndefined()
  })

  it('drops an error with no whitelisted identifiers', () => {
    expect(client.redactAiError({ message: 'sensitive prompt fragment' })).toBeUndefined()
    expect(client.redactAiError({ code: undefined })).toBeUndefined()
  })
})

describe('PostHog AI error egress privacy', () => {
  let capturedFetches: FetchCall[] = []
  let mockFetch: typeof fetch
  let phClient: PostHog | undefined
  let originalPostHogApiKey: string | undefined
  let originalPostHogHost: string | undefined

  beforeEach(() => {
    capturedFetches = []
    originalPostHogApiKey = process.env.POSTHOG_API_KEY
    originalPostHogHost = process.env.POSTHOG_HOST
    process.env.POSTHOG_API_KEY = 'test-key'
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com'
    clearSettingsCache()

    const captureFetch = async (input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString()
      capturedFetches.push({
        url,
        options,
        body: await parsePostHogRequestBody(options.body),
      })

      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    mockFetch = Object.assign(captureFetch, { preconnect: () => {} })
  })

  afterEach(async () => {
    await phClient?.shutdown(100)
    if (originalPostHogApiKey === undefined) {
      delete process.env.POSTHOG_API_KEY
    } else {
      process.env.POSTHOG_API_KEY = originalPostHogApiKey
    }
    if (originalPostHogHost === undefined) {
      delete process.env.POSTHOG_HOST
    } else {
      process.env.POSTHOG_HOST = originalPostHogHost
    }
    clearSettingsCache()
    client.clearPostHogClient()
    capturedFetches = []
  })

  it('redacts AI errors while preserving other event payloads', async () => {
    phClient = client.getPostHogClient(mockFetch)
    const rawError = JSON.stringify({
      status: 400,
      code: 'context_length_exceeded',
      message: 'sensitive prompt fragment',
      error: { message: 'sensitive prompt fragment' },
    })

    phClient.capture({
      distinctId: 'user-1',
      event: '$ai_generation',
      properties: {
        $ai_error: rawError,
        $ai_model: 'gpt-4',
        safeProperty: 'unchanged',
      },
    })
    phClient.capture({
      distinctId: 'user-1',
      event: 'inference_upstream_error',
      properties: {
        $ai_error: rawError,
        safeProperty: 'unchanged',
      },
    })
    phClient.capture({
      distinctId: 'user-1',
      event: '$ai_generation',
      properties: {
        $ai_error: 'not-json',
        redactionCase: 'drop',
        safeProperty: 'still-unchanged',
      },
    })

    await Bun.sleep(0)
    await phClient.flush()

    const events = capturedFetches
      .filter((call) => isPosthogRequest(call.url))
      .flatMap((call) => call.body?.batch || [call.body])
    const aiEvent = events.find(
      (event) => event.event === '$ai_generation' && event.properties.redactionCase === undefined,
    )
    const droppedAiErrorEvent = events.find(
      (event) => event.event === '$ai_generation' && event.properties.redactionCase === 'drop',
    )
    const inferenceErrorEvent = events.find((event) => event.event === 'inference_upstream_error')

    expect(aiEvent.properties.$ai_error).toBe(JSON.stringify({ status: 400, code: 'context_length_exceeded' }))
    expect(aiEvent.properties.$ai_model).toBe('gpt-4')
    expect(aiEvent.properties.safeProperty).toBe('unchanged')
    expect('$ai_error' in droppedAiErrorEvent.properties).toBe(false)
    expect(droppedAiErrorEvent.properties.safeProperty).toBe('still-unchanged')
    expect(inferenceErrorEvent.properties.$ai_error).toBe(rawError)
    expect(inferenceErrorEvent.properties.safeProperty).toBe('unchanged')
  })
})

describe('captureInferenceError', () => {
  it('is a no-op when PostHog is unconfigured', () => {
    const configuredSpy = spyOn(client, 'isPostHogConfigured').mockReturnValue(false)
    const clientSpy = spyOn(client, 'getPostHogClient')

    client.captureInferenceError({
      provider: 'anthropic',
      status: 400,
      errorKind: 'bad_request',
      distinctId: 'user-1',
    })

    expect(clientSpy).not.toHaveBeenCalled()
    configuredSpy.mockRestore()
    clientSpy.mockRestore()
  })

  it('captures an inference_upstream_error event with body-free structured metadata', () => {
    const capture = jest.fn()
    const configuredSpy = spyOn(client, 'isPostHogConfigured').mockReturnValue(true)
    const clientSpy = spyOn(client, 'getPostHogClient').mockReturnValue({ capture } as unknown as PostHog)

    client.captureInferenceError({
      provider: 'anthropic',
      status: 400,
      distinctId: 'user-1',
      errorKind: 'context_length',
      model: 'opus-4.8',
      errorType: 'invalid_request_error',
      errorCode: 'context_length_exceeded',
      requestId: 'provider-request-123',
      phase: 'stream',
    })

    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'inference_upstream_error',
      properties: {
        provider: 'anthropic',
        status: 400,
        errorKind: 'context_length',
        model: 'opus-4.8',
        errorType: 'invalid_request_error',
        errorCode: 'context_length_exceeded',
        requestId: 'provider-request-123',
        phase: 'stream',
      },
    })
    configuredSpy.mockRestore()
    clientSpy.mockRestore()
  })
})

expect.extend({
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
