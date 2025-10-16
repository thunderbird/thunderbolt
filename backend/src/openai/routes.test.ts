import * as posthogClient from '@/posthog/client'
import * as streamingUtils from '@/utils/streaming'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import * as openaiClient from './client'
import { createOpenAIRoutes, supportedModels } from './routes'

describe('OpenAI Routes', () => {
  let app: Elysia
  let getOpenAISpy: ReturnType<typeof spyOn>
  let isPostHogConfiguredSpy: ReturnType<typeof spyOn>
  let createSSEStreamSpy: ReturnType<typeof spyOn>
  let consoleSpy: ReturnType<typeof spyOn>

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
    // Suppress console output during tests
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {})

    // Mock dependencies
    getOpenAISpy = spyOn(openaiClient, 'getOpenAI').mockReturnValue(mockOpenAIClient as any)
    isPostHogConfiguredSpy = spyOn(posthogClient, 'isPostHogConfigured').mockReturnValue(false)
    createSSEStreamSpy = spyOn(streamingUtils, 'createSSEStreamFromCompletion').mockReturnValue(
      createMockSSEStream(),
    )

    app = new Elysia().use(createOpenAIRoutes())
  })

  afterAll(() => {
    getOpenAISpy?.mockRestore()
    isPostHogConfiguredSpy?.mockRestore()
    createSSEStreamSpy?.mockRestore()
    consoleSpy?.mockRestore()
  })

  describe('POST /chat/completions', () => {
    const validRequestBody = {
      model: supportedModels[0],
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.7,
    }

    beforeEach(() => {
      // Reset all mocks before each test
      mockCreateCompletion.mockClear()
      createSSEStreamSpy.mockClear()
      consoleSpy.mockClear()
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
        model: `accounts/fireworks/models/${validRequestBody.model}`,
        messages: validRequestBody.messages,
        temperature: validRequestBody.temperature,
        tools: undefined,
        tool_choice: undefined,
        stream: true,
      })

      expect(createSSEStreamSpy).toHaveBeenCalledWith(mockCompletion, validRequestBody.model)
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
            privacy_mode: true,
            model_provider: 'fireworks',
            endpoint: '/chat/completions',
            has_tools: false,
            temperature: validRequestBody.temperature,
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

    it('should handle OpenAI API errors gracefully', async () => {
      const apiError = new Error('OpenAI API rate limit exceeded')
      mockCreateCompletion.mockImplementation(() => Promise.reject(apiError))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
      expect(consoleSpy).toHaveBeenCalledWith('OpenAI completion error:', apiError)
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
      const expectedModels = [
        'gpt-oss-120b',
        'qwen3-235b-a22b-instruct-2507',
        'qwen3-235b-a22b-thinking-2507',
        'kimi-k2-instruct',
        'deepseek-r1-0528',
        'qwen3-235b-a22b',
        'llama-v3p1-405b-instruct',
      ]
      expect(supportedModels).toEqual(expectedModels)
    })

    it('should prefix model name with accounts/fireworks/models/', async () => {
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: `accounts/fireworks/models/${validRequestBody.model}`,
        }),
      )
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
})

