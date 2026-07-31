/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import type OpenAI from 'openai'
import { createInferenceRoutes, supportedModels, type InferenceProxyLatencyLog } from './routes'
import { defaultModels } from '@shared/defaults/models'

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

  // Mock OpenAI client
  const mockCreateCompletion = mock(() => Promise.resolve({}))

  const mockOpenAIClient = {
    chat: {
      completions: {
        create: mockCreateCompletion,
      },
    },
  }

  const getInferenceClientMock = mock(() => ({
    client: mockOpenAIClient as unknown as OpenAI,
    provider: 'mistral' as const,
  }))
  const isPostHogConfiguredMock = mock(() => false)

  const createMockStream = (chunks: unknown[] = []) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  })

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()
    app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        getClient: getInferenceClientMock,
        isPostHogConfiguredFn: isPostHogConfiguredMock,
      }),
    )
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  describe('POST /chat/completions', () => {
    const validRequestBody = {
      model: 'mistral-large-3',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.7,
    }

    beforeEach(() => {
      // Reset all mocks before each test
      mockCreateCompletion.mockClear()
      getInferenceClientMock.mockClear()
      isPostHogConfiguredMock.mockClear()
      isPostHogConfiguredMock.mockImplementation(() => false)
      getInferenceClientMock.mockImplementation(() => ({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'mistral' as const,
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
        model: 'mistral-large-2512',
        messages: validRequestBody.messages,
        temperature: validRequestBody.temperature,
        tools: undefined,
        tool_choice: undefined,
        stream: true,
      })
    })

    it('should route mistral models to mistral provider', async () => {
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
      expect(getInferenceClientMock).toHaveBeenCalledWith('mistral')
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mistral-large-2512',
        }),
      )
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
            model_provider: 'mistral',
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

    it('emits phase timing headers and a structured latency log on success', async () => {
      const entries: Array<{ context: InferenceProxyLatencyLog; message: string }> = []
      const timestamps = [100, 120, 170]
      const timingApp = new Elysia().use(
        createInferenceRoutes({
          auth: mockAuth,
          getClient: getInferenceClientMock,
          logger: {
            info: (context, message) => entries.push({ context: context as InferenceProxyLatencyLog, message }),
          },
          nowFn: () => timestamps.shift() ?? 0,
        }),
      )
      mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream()))

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
      expect(entries).toEqual([
        {
          context: {
            event: 'inference_proxy_latency',
            route: '/chat/completions',
            provider: 'mistral',
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
            provider: 'mistral',
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

    it('should validate all supported models', () => {
      const expectedModels = ['mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5', 'opus-4.8', 'deepseek-v4-flash']
      expect(Object.keys(supportedModels)).toEqual(expectedModels)
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
  })

  describe('authentication', () => {
    it('should return 401 when session is null', async () => {
      mockCreateCompletion.mockClear()
      const unauthenticatedApp = new Elysia().use(createInferenceRoutes({ auth: mockAuthUnauthenticated }))

      const response = await unauthenticatedApp.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mistral-large-3',
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
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'mistral' as const,
      }))
      mockCreateCompletion.mockImplementation(() => Promise.resolve(createMockStream()))
    })

    const sendMessages = (messages: Array<{ role: string; content: string }>) =>
      app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'mistral-large-3', messages, stream: true }),
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
