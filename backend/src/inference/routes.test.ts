/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestDb } from '@/test-utils/db'
import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type { InferenceLogger, InferenceProxyLatencyLog } from './client'
import { createInferenceRoutes, supportedModels } from './routes'
import { defaultModels } from '@shared/defaults/models'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']
type InferenceLogContext = Parameters<InferenceLogger['info']>[0]

const insertUser = async (database: TestDatabase, id: string, isAnonymous = false) => {
  await database.insert(user).values({
    id,
    name: isAnonymous ? 'Anonymous User' : 'Registered User',
    email: `${id}@example.com`,
    emailVerified: !isAnonymous,
    isAnonymous,
  })
}

describe('Thunderbolt model catalog parity', () => {
  it('routes every Thunderbolt model shipped in frontend defaults', () => {
    const shippedModelIds = defaultModels
      .filter((model) => model.provider === 'thunderbolt')
      .map((model) => model.model)

    expect(shippedModelIds).not.toHaveLength(0)
    expect(shippedModelIds.every((modelId) => supportedModels[modelId] !== undefined)).toBe(true)
  })
})

describe('Inference Routes', () => {
  let app: { handle: Elysia['handle'] }
  let consoleSpies: ConsoleSpies
  let database: TestDatabase
  let cleanup: () => Promise<void>

  // Mock OpenAI client
  const mockCreateCompletion = mock(() => Promise.resolve({}))

  const mockOpenAIClient = Object.assign(new OpenAI({ apiKey: 'test' }), {
    chat: {
      completions: {
        create: mockCreateCompletion,
      },
    },
  })

  const getInferenceClientMock = mock(() => ({
    client: mockOpenAIClient,
    provider: 'tinfoil' as const,
  }))
  const isPostHogConfiguredMock = mock(() => false)

  const createMockStream = (chunks: unknown[] = []) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  })

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    await insertUser(database, 'test-user')
    app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        getClient: getInferenceClientMock,
        isPostHogConfiguredFn: isPostHogConfiguredMock,
      }),
    )
  })

  afterEach(async () => {
    await cleanup()
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  describe('POST /chat/completions', () => {
    const validRequestBody = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.7,
    }

    /** Configure a direct-route policy rejection before client construction. */
    const arrangePolicyRejection = async (rejection: 'missing-price' | 'quota') => {
      if (rejection === 'missing-price') {
        await database
          .delete(inferencePrices)
          .where(sql`${inferencePrices.provider} = 'tinfoil' and ${inferencePrices.model} = 'deepseek-v4-flash'`)
        return
      }

      await database.insert(inferenceUsage).values({
        id: 'telemetry-quota-usage',
        userId: 'test-user',
        provider: 'tinfoil',
        model: 'deepseek-v4-flash',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costNanoUsd: 15_000_000_000n,
      })
    }

    beforeEach(() => {
      // Reset all mocks before each test
      mockCreateCompletion.mockClear()
      getInferenceClientMock.mockClear()
      isPostHogConfiguredMock.mockClear()
      consoleSpies.error.mockClear()
      isPostHogConfiguredMock.mockImplementation(() => false)
      getInferenceClientMock.mockImplementation(() => ({
        client: mockOpenAIClient,
        provider: 'tinfoil' as const,
      }))
    })

    it('should handle valid streaming request successfully', async () => {
      const mockCompletion = createMockStream([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world!' } }] },
      ])

      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('Connection')).toBe('keep-alive')

      expect(mockCreateCompletion).toHaveBeenCalledWith({
        model: 'deepseek-v4-flash',
        messages: validRequestBody.messages,
        temperature: validRequestBody.temperature,
        tools: undefined,
        tool_choice: undefined,
        stream: true,
        stream_options: { include_usage: true },
      })
    })

    it.each([
      ['omitted', undefined],
      ['disabled', { include_usage: false }],
      ['customized', { include_usage: false, vendor_extension: 'client-value' }],
    ])('forces exact stream usage options when the client value is %s', async (_label, streamOptions) => {
      mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream()))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validRequestBody, stream_options: streamOptions }),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ stream_options: { include_usage: true } }),
      )
    })

    it('should route DeepSeek V4 Flash to the Tinfoil provider', async () => {
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(getInferenceClientMock).toHaveBeenCalledWith('tinfoil')
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'deepseek-v4-flash',
        }),
      )
    })

    it('declares stream-usage support for exactly the two direct models', () => {
      expect(supportedModels).toEqual({
        'opus-5': {
          provider: 'anthropic',
          internalName: 'claude-opus-5',
          omitTemperature: true,
          supportsStreamUsage: true,
        },
        'deepseek-v4-flash': {
          provider: 'tinfoil',
          internalName: 'deepseek-v4-flash',
          supportsStreamUsage: true,
        },
      })
    })

    it('should handle request with tools and tool_choice', async () => {
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const requestWithTools = {
        ...validRequestBody,
        tools: [{ type: 'function', function: { name: 'test_tool' } }],
        tool_choice: 'auto',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestWithTools),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: requestWithTools.tools,
          tool_choice: requestWithTools.tool_choice,
        }),
      )
    })

    it('should include PostHog properties when configured', async () => {
      isPostHogConfiguredMock.mockImplementation(() => true)
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          posthogProperties: expect.objectContaining({
            model_provider: 'tinfoil',
            endpoint: '/chat/completions',
            has_tools: false,
            temperature: validRequestBody.temperature,
          }),
        }),
      )

      // Reset for other tests
      isPostHogConfiguredMock.mockImplementation(() => false)
    })

    it('should reject non-streaming requests', async () => {
      const nonStreamingRequest = {
        ...validRequestBody,
        stream: false,
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nonStreamingRequest),
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('should reject unsupported models', async () => {
      const unsupportedModelRequest = {
        ...validRequestBody,
        model: 'unsupported-model',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(unsupportedModelRequest),
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('returns a minimal 503 before client construction when the canonical price is missing', async () => {
      await database
        .delete(inferencePrices)
        .where(sql`${inferencePrices.provider} = 'tinfoil' and ${inferencePrices.model} = 'deepseek-v4-flash'`)

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
      expect(getInferenceClientMock).not.toHaveBeenCalled()
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it.each([
      ['anonymous', true, '5h', 10, 0],
      ['anonymous', true, '7d', 60, 6],
      ['registered', false, '5h', 1_500, 0],
      ['registered', false, '7d', 7_500, 6],
    ] as const)(
      'applies below, exact, and above %s %s quota boundaries',
      async (accountKind, isAnonymous, window, limitCents, ageHours) => {
        for (const [boundary, spentCents, expectedStatus] of [
          ['below', limitCents - 1, 200],
          ['exact', limitCents, 429],
          ['above', limitCents + 1, 429],
        ] as const) {
          const userId = `${accountKind}-${window}-${boundary}`
          await insertUser(database, userId, isAnonymous)
          await database.insert(inferenceUsage).values({
            id: `usage-${userId}`,
            userId,
            provider: 'tinfoil',
            model: 'deepseek-v4-flash',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costNanoUsd: BigInt(spentCents) * 10_000_000n,
            createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1_000),
          })
          const quotaApp = new Elysia().use(
            createInferenceRoutes({
              auth: createMockAuth(userId, isAnonymous),
              database,
              getClient: getInferenceClientMock,
              isPostHogConfiguredFn: isPostHogConfiguredMock,
            }),
          )
          mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream()))
          const clientCallsBefore = getInferenceClientMock.mock.calls.length

          const response = await quotaApp.handle(
            new Request('http://localhost/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(validRequestBody),
            }),
          )

          expect(response.status, boundary).toBe(expectedStatus)
          expect(getInferenceClientMock.mock.calls.length, boundary).toBe(
            expectedStatus === 200 ? clientCallsBefore + 1 : clientCallsBefore,
          )
          if (expectedStatus === 429) {
            expect(await response.json(), boundary).toEqual({
              error: { code: 'INFERENCE_QUOTA_EXCEEDED', window },
            })
          }
        }
      },
    )

    it('reports the five-hour window when both quota windows are exceeded', async () => {
      const userId = 'both-window-user'
      await insertUser(database, userId)
      await database.insert(inferenceUsage).values([
        {
          id: 'both-window-recent',
          userId,
          provider: 'anthropic',
          model: 'claude-opus-5',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costNanoUsd: 15_000_000_000n,
        },
        {
          id: 'both-window-older',
          userId,
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costNanoUsd: 60_000_000_000n,
          createdAt: new Date(Date.now() - 6 * 60 * 60 * 1_000),
        },
      ])
      const quotaApp = new Elysia().use(
        createInferenceRoutes({
          auth: createMockAuth(userId, false),
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
        }),
      )

      const response = await quotaApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
      expect(getInferenceClientMock).not.toHaveBeenCalled()
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it.each([
      ['missing-price', 503],
      ['quota', 429],
    ] as const)('records latency telemetry for a %s rejection', async (rejection, status) => {
      await arrangePolicyRejection(rejection)
      const entries: Array<{ context: InferenceProxyLatencyLog; message: string }> = []
      const timestamps = [100, 120, 170]
      const telemetryApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          logger: {
            info: (context, message) => entries.push({ context: context as InferenceProxyLatencyLog, message }),
          },
          nowFn: () => timestamps.shift() ?? 0,
        }),
      )

      const response = await telemetryApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(status)
      if (rejection === 'quota') {
        expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
      }
      expect(response.headers.get('x-proxy-timing')).toBeNull()
      expect(response.headers.get('server-timing')).toBeNull()
      expect(entries).toEqual([
        {
          context: {
            event: 'inference_proxy_latency',
            route: '/chat/completions',
            provider: 'tinfoil',
            model: 'deepseek-v4-flash',
            status,
            preMs: 20,
            upstreamMs: null,
            totalMs: 70,
            attempts: 0,
          },
          message: 'Inference proxy latency',
        },
      ])
      expect(getInferenceClientMock).not.toHaveBeenCalled()
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it.each([
      ['missing-price', 503, { error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } }],
      ['quota', 429, { error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } }],
    ] as const)('preserves the %s rejection when latency logging throws', async (rejection, status, body) => {
      await arrangePolicyRejection(rejection)
      const throwingLoggerApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          logger: {
            info: () => {
              throw new Error('Telemetry unavailable')
            },
          },
        }),
      )

      const response = await throwingLoggerApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(status)
      expect(await response.json()).toEqual(body)
      expect(getInferenceClientMock).not.toHaveBeenCalled()
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('should handle inference API errors gracefully', async () => {
      const apiError = new Error('API rate limit exceeded')
      mockCreateCompletion.mockImplementation(() => Promise.reject(apiError))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('captures body-free structured metadata from an API error', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
        }),
      )
      const apiError = new APIError(
        400,
        {
          message: 'prompt is too long',
          code: 'context_length_exceeded',
          type: 'invalid_request_error',
        },
        undefined,
        new Headers({ 'x-request-id': 'provider-request-123' }),
      )
      mockCreateCompletion.mockImplementation(() => Promise.reject(apiError))

      const response = await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(400)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 400,
        model: 'deepseek-v4-flash',
        errorKind: 'context_length',
        errorType: 'invalid_request_error',
        errorCode: 'context_length_exceeded',
        requestId: 'provider-request-123',
        distinctId: 'test-user',
      })
      expect(await response.json()).toEqual({ success: false, data: null, error: 'Bad Request' })
      expect(consoleSpies.error).not.toHaveBeenCalled()
    })

    it('rethrows an unexpected programming fault to the diagnostic error handler', async () => {
      const faultMessage = 'Unexpected inference programming fault'
      const captureInferenceErrorMock = mock(() => {})
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const faultApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(() => Promise.reject(new Error(faultMessage)))

      const response = await faultApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ success: false, data: null, error: 'Internal Server Error' })
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 500,
        model: 'deepseek-v4-flash',
        errorKind: 'unknown',
        errorType: undefined,
        errorCode: undefined,
        requestId: undefined,
        distinctId: 'test-user',
      })
      expect(JSON.stringify(consoleSpies.error.mock.calls)).toContain(faultMessage)
      expect(JSON.stringify(logs)).not.toContain(faultMessage)
      expect(logs.map(({ context }) => context.event)).toEqual(['inference_proxy_latency'])
    })

    it('captures body-free structured metadata from a mid-stream API error', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
        }),
      )
      const apiError = new APIError(
        529,
        {
          message: 'Overloaded',
          type: 'overloaded_error',
        },
        undefined,
        new Headers({ 'x-request-id': 'provider-stream-request-123' }),
      )
      const completionController = new AbortController()
      const mockCompletion = {
        controller: completionController,
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hello' } }] }
          throw apiError
        },
      }
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validRequestBody, model: 'opus-5' }),
        }),
      )

      expect(response.status).toBe(200)
      await expect(response.text()).rejects.toThrow('Overloaded')
      expect(captureInferenceErrorMock).toHaveBeenCalledTimes(1)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'anthropic',
        status: 529,
        model: 'opus-5',
        errorKind: 'upstream_error',
        errorType: 'overloaded_error',
        errorCode: undefined,
        requestId: 'provider-stream-request-123',
        distinctId: 'test-user',
        phase: 'stream',
      })
    })

    it('does not capture downstream cancellation as a stream error', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
        }),
      )
      const completionController = new AbortController()
      const iterationSettled = Promise.withResolvers<void>()
      const mockCompletion = {
        controller: completionController,
        async *[Symbol.asyncIterator]() {
          try {
            yield { choices: [{ delta: { content: 'Hello' } }] }
            await new Promise<void>((_resolve, reject) => {
              completionController.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                once: true,
              })
            })
          } finally {
            iterationSettled.resolve()
          }
        },
      }
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const reader = response.body!.getReader()

      expect((await reader.read()).done).toBeFalse()
      await reader.cancel()
      await iterationSettled.promise
      expect(captureInferenceErrorMock).not.toHaveBeenCalled()
    })

    it('captures connection timeouts with body-free logging', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      const rawCause = new Error('SECRET_TIMEOUT_BODY')
      const connectionError = new APIConnectionTimeoutError({ message: 'Request timed out.' })
      connectionError.cause = rawCause
      mockCreateCompletion.mockImplementation(() => Promise.reject(connectionError))

      const response = await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
      expect(captureInferenceErrorMock).toHaveBeenCalledTimes(1)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 500,
        model: 'deepseek-v4-flash',
        errorKind: 'connection',
        errorType: undefined,
        errorCode: undefined,
        requestId: undefined,
        distinctId: 'test-user',
      })
      expect(logs).toContainEqual({
        context: {
          event: 'inference_connection_timeout',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          route: '/chat/completions',
        },
        message: 'Connection timeout to inference provider',
      })
      expect(consoleSpies.error.mock.calls.flat()).not.toContain(connectionError)
      expect(consoleSpies.error.mock.calls.flat()).not.toContain(rawCause)
      expect(JSON.stringify(logs)).not.toContain(rawCause.message)
      expect(logs.every(({ context }) => !Object.hasOwn(context, 'error') && !Object.hasOwn(context, 'cause'))).toBe(
        true,
      )
    })

    it('captures connection failures with body-free logging', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      const rawCause = new Error('SECRET_CONNECTION_BODY')
      const connectionError = new APIConnectionError({ message: 'Connection failed.', cause: rawCause })
      mockCreateCompletion.mockImplementation(() => Promise.reject(connectionError))

      const response = await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
      expect(captureInferenceErrorMock).toHaveBeenCalledTimes(1)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 500,
        model: 'deepseek-v4-flash',
        errorKind: 'connection',
        errorType: undefined,
        errorCode: undefined,
        requestId: undefined,
        distinctId: 'test-user',
      })
      expect(logs).toContainEqual({
        context: {
          event: 'inference_connection_failed',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          route: '/chat/completions',
        },
        message: 'Failed to connect to inference provider',
      })
      expect(consoleSpies.error.mock.calls.flat()).not.toContain(connectionError)
      expect(consoleSpies.error.mock.calls.flat()).not.toContain(rawCause)
      expect(JSON.stringify(logs)).not.toContain(rawCause.message)
      expect(logs.every(({ context }) => !Object.hasOwn(context, 'error') && !Object.hasOwn(context, 'cause'))).toBe(
        true,
      )
    })

    it('never captures provider error message content', async () => {
      const sentinel = 'SECRET_PROMPT_FRAGMENT_XYZ'
      const captureInferenceErrorMock = mock(() => {})
      const captureApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          captureInferenceErrorFn: captureInferenceErrorMock,
        }),
      )
      const apiError = new APIError(
        400,
        { message: sentinel, code: 'invalid_request_error', type: 'invalid_request_error' },
        undefined,
        new Headers(),
      )
      mockCreateCompletion.mockImplementation(() => Promise.reject(apiError))

      await captureApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(captureInferenceErrorMock).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(captureInferenceErrorMock.mock.calls)).not.toContain(sentinel)
      expect(consoleSpies.error.mock.calls.flat()).not.toContain(apiError)
      expect(JSON.stringify(consoleSpies.error.mock.calls)).not.toContain(sentinel)
    })

    it('emits phase timing headers and a structured latency log on success', async () => {
      const entries: Array<{ context: InferenceProxyLatencyLog; message: string }> = []
      const timestamps = [100, 120, 170]
      const timingApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          logger: {
            info: (context, message) => entries.push({ context: context as InferenceProxyLatencyLog, message }),
          },
          nowFn: () => timestamps.shift() ?? 0,
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          createMockStream([{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]),
        ),
      )

      const response = await timingApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('x-proxy-timing')).toBe('pre=20;upstream=50;total=70;attempts=0')
      expect(response.headers.get('server-timing')).toBe('pre;dur=20, upstream;dur=50, total;dur=70')
      expect(entries.filter(({ context }) => context.event === 'inference_proxy_latency')).toEqual([
        {
          context: {
            event: 'inference_proxy_latency',
            route: '/chat/completions',
            provider: 'tinfoil',
            model: 'deepseek-v4-flash',
            status: 200,
            preMs: 20,
            upstreamMs: 50,
            totalMs: 70,
            attempts: 0,
          },
          message: 'Inference proxy latency',
        },
      ])
    })

    it('emits phase timing headers and a structured latency log on upstream error', async () => {
      const entries: Array<{ context: InferenceProxyLatencyLog; message: string }> = []
      const timestamps = [200, 230, 310]
      const timingApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          logger: {
            info: (context, message) => entries.push({ context: context as InferenceProxyLatencyLog, message }),
          },
          nowFn: () => timestamps.shift() ?? 0,
        }),
      )
      mockCreateCompletion.mockImplementation(() => Promise.reject(new Error('Upstream failed')))

      const response = await timingApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
      expect(response.headers.get('x-proxy-timing')).toBe('pre=30;upstream=80;total=110;attempts=0')
      expect(response.headers.get('server-timing')).toBe('pre;dur=30, upstream;dur=80, total;dur=110')
      expect(entries).toEqual([
        {
          context: {
            event: 'inference_proxy_latency',
            route: '/chat/completions',
            provider: 'tinfoil',
            model: 'deepseek-v4-flash',
            status: 500,
            preMs: 30,
            upstreamMs: 80,
            totalMs: 110,
            attempts: 0,
          },
          message: 'Inference proxy latency',
        },
      ])
    })

    it('should handle malformed JSON requests', async () => {
      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ invalid json',
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('exposes only Thunderbolt models handled by the inference proxy', () => {
      expect(Object.keys(supportedModels)).toEqual(['opus-5', 'deepseek-v4-flash'])
    })

    it('should handle requests with has_tools flag correctly', async () => {
      isPostHogConfiguredMock.mockImplementation(() => true)
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const requestWithTools = {
        ...validRequestBody,
        tools: [{ type: 'function', function: { name: 'test' } }],
      }

      await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestWithTools),
        }),
      )

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          posthogProperties: expect.objectContaining({
            has_tools: true,
          }),
        }),
      )

      // Reset for other tests
      isPostHogConfiguredMock.mockImplementation(() => false)
    })

    it.each([
      {
        publicModel: 'deepseek-v4-flash',
        provider: 'tinfoil',
        internalName: 'deepseek-v4-flash',
        userId: 'test-user',
        isAnonymous: false,
        expectedCost: 2_700n,
      },
      {
        publicModel: 'opus-5',
        provider: 'anthropic',
        internalName: 'claude-opus-5',
        userId: 'anonymous-route-user',
        isAnonymous: true,
        expectedCost: 85_000n,
      },
    ] as const)(
      'records $publicModel usage with canonical identity for the authenticated user',
      async ({ publicModel, provider, internalName, userId, isAnonymous, expectedCost }) => {
        if (isAnonymous) {
          await insertUser(database, userId, true)
        }
        const routeApp = new Elysia().use(
          createInferenceRoutes({
            auth: createMockAuth(userId, isAnonymous),
            database,
            getClient: getInferenceClientMock,
            isPostHogConfiguredFn: isPostHogConfiguredMock,
          }),
        )
        mockCreateCompletion.mockImplementation(() =>
          Promise.resolve(
            createMockStream([
              {
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 99 },
              },
            ]),
          ),
        )

        const response = await routeApp.handle(
          new Request('http://localhost/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...validRequestBody,
              model: publicModel,
              provider: 'client-controlled-provider',
              internalName: 'client-controlled-model',
            }),
          }),
        )
        await response.text()

        const rows = await database.select().from(inferenceUsage)
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(rows[0]).toMatchObject({
          userId,
          provider,
          model: internalName,
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 99,
          costNanoUsd: expectedCost,
        })
      },
    )

    it('keeps the request-start price when the current price changes before usage arrives', async () => {
      mockCreateCompletion.mockImplementation(async () => {
        await database
          .update(inferencePrices)
          .set({ inputNanoUsdPerToken: 9_000n, outputNanoUsdPerToken: 11_000n })
          .where(sql`${inferencePrices.provider} = 'tinfoil' and ${inferencePrices.model} = 'deepseek-v4-flash'`)
        return createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }])
      })

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      await response.text()

      const [row] = await database.select().from(inferenceUsage)
      expect(row.costNanoUsd).toBe(2_700n)
    })

    it.each([
      ['missing', { choices: [{ delta: { content: 'ok' } }] }],
      [
        'malformed',
        {
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: -1, total_tokens: 0 },
        },
      ],
    ] as const)('does not insert usage when provider usage is %s', async (_label, chunk) => {
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const missingUsageApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream([chunk])))
      const rowCountBefore = (await database.select().from(inferenceUsage)).length

      const response = await missingUsageApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const responseText = await response.text()

      expect(responseText.endsWith('data: [DONE]\n\n')).toBeTrue()
      expect(await database.select().from(inferenceUsage)).toHaveLength(rowCountBefore)
      expect(logs).toContainEqual({
        context: {
          event: 'inference_usage_missing',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          route: '/chat/completions',
        },
        message: 'Inference usage missing',
      })
      expect(logs.every(({ context }) => !Object.hasOwn(context, 'error') && !Object.hasOwn(context, 'cause'))).toBe(
        true,
      )
    })

    it('completes the caller stream and logs body-free metadata when the usage insert fails', async () => {
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const failingApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(async () => {
        await database.execute(sql`drop table inference_usage`)
        return createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }])
      })

      const response = await failingApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const responseText = await response.text()

      expect(response.status).toBe(200)
      expect(responseText.endsWith('data: [DONE]\n\n')).toBeTrue()
      expect(logs.map(({ context }) => context.event).filter((event) => event.startsWith('inference_usage_'))).toEqual([
        'inference_usage_completed',
        'inference_usage_callback_failed',
      ])
      expect(logs).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: 'inference_usage_completed',
            provider: 'tinfoil',
            model: 'deepseek-v4-flash',
            transport: 'direct',
          }),
          message: 'Inference usage completed',
        }),
      )
      expect(logs).toContainEqual({
        context: {
          event: 'inference_usage_callback_failed',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          route: '/chat/completions',
        },
        message: 'Inference usage callback failed',
      })
      expect(logs.some(({ context }) => context.event === 'inference_usage_inserted')).toBeFalse()
      expect(JSON.stringify(logs)).not.toContain('prompt_tokens')
      expect(logs.every(({ context }) => !Object.hasOwn(context, 'error') && !Object.hasOwn(context, 'cause'))).toBe(
        true,
      )
    })

    it('logs completed then inserted for a newly persisted usage event', async () => {
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const telemetryApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }]),
        ),
      )

      const response = await telemetryApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      await response.text()

      const [row] = await database.select().from(inferenceUsage)
      expect(logs.map(({ context }) => context.event).filter((event) => event.startsWith('inference_usage_'))).toEqual([
        'inference_usage_completed',
        'inference_usage_inserted',
      ])
      expect(logs).toContainEqual({
        context: {
          event: 'inference_usage_completed',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          eventId: row.id,
          transport: 'direct',
        },
        message: 'Inference usage completed',
      })
      expect(logs).toContainEqual({
        context: {
          event: 'inference_usage_inserted',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          eventId: row.id,
          outcome: 'inserted',
        },
        message: 'Inference usage inserted',
      })
    })

    it('persists completed usage when success telemetry logging throws', async () => {
      const attemptedEvents: string[] = []
      const telemetryError = new Error('Telemetry sink failed')
      const throwingLoggerApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: {
            info: (context) => {
              attemptedEvents.push(context.event)
              if (context.event === 'inference_usage_completed' || context.event === 'inference_usage_inserted') {
                throw telemetryError
              }
            },
          },
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }]),
        ),
      )

      const response = await throwingLoggerApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const responseText = await response.text()

      expect(response.status).toBe(200)
      expect(responseText.endsWith('data: [DONE]\n\n')).toBeTrue()
      expect(await database.select().from(inferenceUsage)).toHaveLength(1)
      expect(attemptedEvents).toEqual([
        'inference_proxy_latency',
        'inference_usage_completed',
        'inference_usage_inserted',
      ])
      expect(attemptedEvents).not.toContain('inference_usage_callback_failed')
    })

    it('logs the duplicate outcome when the server event ID already exists', async () => {
      const eventId = '123e4567-e89b-42d3-a456-426614174000'
      await database.insert(inferenceUsage).values({
        id: eventId,
        userId: 'test-user',
        provider: 'tinfoil',
        model: 'deepseek-v4-flash',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costNanoUsd: 1_000n,
      })
      const randomUUIDSpy = spyOn(crypto, 'randomUUID').mockReturnValue(eventId)
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const telemetryApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }]),
        ),
      )

      try {
        const response = await telemetryApp.handle(
          new Request('http://localhost/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validRequestBody),
          }),
        )
        await response.text()
      } finally {
        randomUUIDSpy.mockRestore()
      }

      expect(await database.select().from(inferenceUsage)).toHaveLength(1)
      expect(logs.map(({ context }) => context.event).filter((event) => event.startsWith('inference_usage_'))).toEqual([
        'inference_usage_completed',
        'inference_usage_inserted',
      ])
      expect(logs).toContainEqual({
        context: {
          event: 'inference_usage_inserted',
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          eventId,
          outcome: 'duplicate',
        },
        message: 'Inference usage inserted',
      })
    })

    it('keeps the completed ledger attempt when the caller cancels after natural exhaustion', async () => {
      const completed = Promise.withResolvers<void>()
      const inserted = Promise.withResolvers<void>()
      const lateCancelApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: {
            info: (context) => {
              if (context.event === 'inference_usage_completed') {
                completed.resolve()
              }
              if (context.event === 'inference_usage_inserted') {
                inserted.resolve()
              }
            },
          },
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          Object.assign(
            createMockStream([{ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }]),
            { controller: new AbortController() },
          ),
        ),
      )

      const response = await lateCancelApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const reader = response.body!.getReader()

      expect((await reader.read()).done).toBeFalse()
      expect(
        await Promise.race([
          completed.promise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]),
      ).toBeTrue()
      await reader.cancel()
      await inserted.promise
      expect(await database.select().from(inferenceUsage)).toHaveLength(1)
    })

    it('completes without a row when observer-valid usage exceeds persistence range', async () => {
      const logs: Array<{ context: InferenceLogContext; message: string }> = []
      const overflowApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          database,
          getClient: getInferenceClientMock,
          isPostHogConfiguredFn: isPostHogConfiguredMock,
          logger: { info: (context, message) => logs.push({ context, message }) },
        }),
      )
      mockCreateCompletion.mockImplementation(() =>
        Promise.resolve(
          createMockStream([
            {
              choices: [],
              usage: { prompt_tokens: 2_147_483_648, completion_tokens: 0, total_tokens: 2_147_483_648 },
            },
          ]),
        ),
      )

      const response = await overflowApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )
      const responseText = await response.text()

      expect(responseText.endsWith('data: [DONE]\n\n')).toBeTrue()
      expect(await database.select().from(inferenceUsage)).toHaveLength(0)
      expect(logs.map(({ context }) => context.event).filter((event) => event.startsWith('inference_usage_'))).toEqual([
        'inference_usage_completed',
        'inference_usage_callback_failed',
      ])
      expect(logs.some(({ context }) => context.event === 'inference_usage_inserted')).toBeFalse()
    })

    it.each([true, false])(
      'preserves provider usage chunks without shared-object mutation when PostHog configured is %s',
      async (postHogConfigured) => {
        isPostHogConfiguredMock.mockImplementation(() => postHogConfigured)
        const usage = Object.freeze({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
        const chunk = Object.freeze({ choices: Object.freeze([]), usage })
        mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream([chunk])))

        const response = await app.handle(
          new Request('http://localhost/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validRequestBody),
          }),
        )
        const responseText = await response.text()

        expect(responseText).toBe(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        expect(chunk).toEqual({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
        if (postHogConfigured) {
          expect(mockCreateCompletion).toHaveBeenCalledWith(
            expect.objectContaining({
              posthogDistinctId: 'test-user',
              posthogProperties: expect.objectContaining({
                model_provider: 'tinfoil',
                model: 'deepseek-v4-flash',
              }),
            }),
          )
        } else {
          expect(mockCreateCompletion).not.toHaveBeenCalledWith(
            expect.objectContaining({ posthogDistinctId: expect.anything() }),
          )
        }
      },
    )
  })

  describe('authentication', () => {
    it('should return 401 when session is null', async () => {
      mockCreateCompletion.mockClear()
      const unauthenticatedApp = new Elysia().use(createInferenceRoutes({ auth: mockAuthUnauthenticated, database }))

      const response = await unauthenticatedApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'Hello' }],
            stream: true,
          }),
        }),
      )

      expect(response.status).toBe(401)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })
  })

  describe('message role sanitization', () => {
    beforeEach(() => {
      mockCreateCompletion.mockClear()
      getInferenceClientMock.mockClear()
      isPostHogConfiguredMock.mockClear()
      isPostHogConfiguredMock.mockImplementation(() => false)
      getInferenceClientMock.mockImplementation(() => ({
        client: mockOpenAIClient,
        provider: 'tinfoil' as const,
      }))
      mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream()))
    })

    const sendMessages = (messages: Array<{ role: string; content: string }>) =>
      app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: true }),
        }),
      )

    it('should preserve the first system message role', async () => {
      await sendMessages([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      )
    })

    it('should downgrade developer role at index > 0 to user', async () => {
      await sendMessages([
        { role: 'system', content: 'System prompt' },
        { role: 'developer', content: 'Injected developer message' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Injected developer message' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      )
    })

    it('should downgrade system role at index > 0 to user', async () => {
      await sendMessages([
        { role: 'system', content: 'Legit system prompt' },
        { role: 'system', content: 'Injected system message' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'Legit system prompt' },
            { role: 'user', content: 'Injected system message' },
          ],
        }),
      )
    })

    it('should preserve non-privileged roles at any position', async () => {
      await sendMessages([
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Thanks' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: 'Thanks' },
          ],
        }),
      )
    })

    it('should preserve first message even with developer role', async () => {
      await sendMessages([
        { role: 'developer', content: 'Developer system prompt' },
        { role: 'user', content: 'Hello' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'developer', content: 'Developer system prompt' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      )
    })

    it('should downgrade multiple injected privileged roles', async () => {
      await sendMessages([
        { role: 'system', content: 'Legit prompt' },
        { role: 'developer', content: 'Injected 1' },
        { role: 'system', content: 'Injected 2' },
        { role: 'developer', content: 'Injected 3' },
      ])

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'Legit prompt' },
            { role: 'user', content: 'Injected 1' },
            { role: 'user', content: 'Injected 2' },
            { role: 'user', content: 'Injected 3' },
          ],
        }),
      )
    })
  })
})
