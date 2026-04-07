import * as posthogClient from '@/posthog/client'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import * as streamingUtils from '@/utils/streaming'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import type OpenAI from 'openai'
import * as inferenceClient from './client'
import { createInferenceRoutes, supportedModels } from './routes'

describe('Inference Routes', () => {
  let app: { handle: Elysia['handle'] }
  let getInferenceClientSpy: ReturnType<typeof spyOn>
  let isPostHogConfiguredSpy: ReturnType<typeof spyOn>
  let createSSEStreamSpy: ReturnType<typeof spyOn>
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

  const createMockStream = (chunks: any[] = []) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  })

  const createMockSSEStream = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"test": "chunk"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()

    // Mock dependencies
    getInferenceClientSpy = spyOn(inferenceClient, 'getInferenceClient').mockReturnValue({
      client: mockOpenAIClient as unknown as OpenAI,
      provider: 'mistral',
    })
    isPostHogConfiguredSpy = spyOn(posthogClient, 'isPostHogConfigured').mockReturnValue(false)
    createSSEStreamSpy = spyOn(streamingUtils, 'createSSEStreamFromCompletion').mockReturnValue(createMockSSEStream())

    app = new Elysia().use(createInferenceRoutes(mockAuth))
  })

  afterAll(() => {
    getInferenceClientSpy?.mockRestore()
    isPostHogConfiguredSpy?.mockRestore()
    createSSEStreamSpy?.mockRestore()
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
      createSSEStreamSpy.mockClear()
      getInferenceClientSpy.mockClear()
      getInferenceClientSpy.mockReturnValue({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'mistral',
      })
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

      expect(createSSEStreamSpy).toHaveBeenCalledWith(mockCompletion, validRequestBody.model)
    })

    it('should route gpt-oss-120b model to thunderbolt provider', async () => {
      getInferenceClientSpy.mockReturnValue({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'thunderbolt',
      })

      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(200)
      expect(getInferenceClientSpy).toHaveBeenCalledWith('thunderbolt')
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'openai/gpt-oss-120b',
        }),
      )
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
      expect(getInferenceClientSpy).toHaveBeenCalledWith('mistral')
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
      isPostHogConfiguredSpy.mockReturnValue(true)
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
      isPostHogConfiguredSpy.mockReturnValue(false)
    })

    it('should include correct provider in PostHog properties for gpt-oss-120b', async () => {
      isPostHogConfiguredSpy.mockReturnValue(true)
      getInferenceClientSpy.mockReturnValue({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'thunderbolt',
      })

      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          posthogProperties: expect.objectContaining({
            model_provider: 'thunderbolt',
          }),
        }),
      )

      // Reset for other tests
      isPostHogConfiguredSpy.mockReturnValue(false)
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
      const expectedModels = ['gpt-oss-120b', 'mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5']
      expect(Object.keys(supportedModels)).toEqual(expectedModels)
    })

    it('should handle requests with has_tools flag correctly', async () => {
      isPostHogConfiguredSpy.mockReturnValue(true)
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
      isPostHogConfiguredSpy.mockReturnValue(false)
    })
  })

  describe('authentication', () => {
    it('should return 401 when session is null', async () => {
      mockCreateCompletion.mockClear()
      const unauthenticatedApp = new Elysia().use(createInferenceRoutes(mockAuthUnauthenticated))

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
      createSSEStreamSpy.mockClear()
      getInferenceClientSpy.mockClear()
      getInferenceClientSpy.mockReturnValue({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'mistral',
      })
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
