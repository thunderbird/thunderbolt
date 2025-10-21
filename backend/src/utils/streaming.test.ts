import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { createSSEStreamFromCompletion } from './streaming'

// Mock console.log and console.error
const mockConsoleLog = jest.fn()
const mockConsoleError = jest.fn()
const originalConsoleLog = console.log
const originalConsoleError = console.error

describe('Utils - Streaming', () => {
  beforeEach(() => {
    console.log = mockConsoleLog
    console.error = mockConsoleError
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
    mockConsoleLog.mockClear()
    mockConsoleError.mockClear()
  })

  describe('createSSEStreamFromCompletion', () => {
    /**
     * Creates a mock completion stream that yields the provided chunks
     */
    const createMockCompletion = (chunks: any[]) => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    })

    /**
     * Reads all chunks from a ReadableStream and returns them as strings
     */
    const readStreamChunks = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      const chunks: string[] = []

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(decoder.decode(value))
        }
      } finally {
        reader.releaseLock()
      }

      return chunks
    }

    it('should stream completion chunks as SSE format', async () => {
      const mockChunks = [
        { id: 'chunk1', choices: [{ delta: { content: 'Hello' } }] },
        { id: 'chunk2', choices: [{ delta: { content: ' world' } }] },
      ]

      const mockCompletion = createMockCompletion(mockChunks)
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      expect(chunks).toHaveLength(3) // 2 data chunks + 1 [DONE] chunk
      expect(chunks[0]).toBe('data: {"id":"chunk1","choices":[{"delta":{"content":"Hello"}}]}\n\n')
      expect(chunks[1]).toBe('data: {"id":"chunk2","choices":[{"delta":{"content":" world"}}]}\n\n')
      expect(chunks[2]).toBe('data: [DONE]\n\n')
    })

    it('should track usage data when present', async () => {
      const mockChunks = [
        { id: 'chunk1', choices: [{ delta: { content: 'Hello' } }] },
        {
          id: 'chunk2',
          choices: [{ delta: { content: ' world' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]

      const mockCompletion = createMockCompletion(mockChunks)
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      // Verify the stream includes both content chunks and usage data
      expect(chunks).toHaveLength(3) // 2 content chunks + [DONE]
      expect(chunks[0]).toContain('Hello')
      expect(chunks[1]).toContain(' world')
      expect(chunks[1]).toContain('usage')
      expect(chunks[2]).toBe('data: [DONE]\n\n')
    })

    it('should use the latest usage data when multiple chunks have usage', async () => {
      const mockChunks = [
        {
          id: 'chunk1',
          choices: [{ delta: { content: 'Hello' } }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        },
        {
          id: 'chunk2',
          choices: [{ delta: { content: ' world' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]

      const mockCompletion = createMockCompletion(mockChunks)
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      // Verify the stream includes both content chunks with their usage data
      expect(chunks).toHaveLength(3) // 2 content chunks + [DONE]
      expect(chunks[0]).toContain('Hello')
      expect(chunks[0]).toContain('"prompt_tokens":8')
      expect(chunks[1]).toContain(' world')
      expect(chunks[1]).toContain('"prompt_tokens":10') // Latest usage
    })

    it('should not log usage when no usage data is present', async () => {
      const mockChunks = [
        { id: 'chunk1', choices: [{ delta: { content: 'Hello' } }] },
        { id: 'chunk2', choices: [{ delta: { content: ' world' } }] },
      ]

      const mockCompletion = createMockCompletion(mockChunks)
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      await readStreamChunks(stream)

      expect(mockConsoleLog).not.toHaveBeenCalled()
    })

    it('should handle empty completion stream', async () => {
      const mockCompletion = createMockCompletion([])
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      expect(chunks).toHaveLength(1) // Only [DONE] chunk
      expect(chunks[0]).toBe('data: [DONE]\n\n')
      expect(mockConsoleLog).not.toHaveBeenCalled()
    })

    it('should handle streaming errors gracefully', async () => {
      const mockError = new Error('Stream error')
      const mockCompletion = {
        async *[Symbol.asyncIterator]() {
          yield { id: 'chunk1', choices: [{ delta: { content: 'Hello' } }] }
          throw mockError
        },
      }

      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      // Stream should error when trying to read
      const reader = stream.getReader()
      await expect(async () => {
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }).toThrow('Stream error')

      expect(mockConsoleError).toHaveBeenCalledWith('OpenAI streaming error:', mockError)
    })

    it('should properly encode complex JSON data', async () => {
      const complexChunk = {
        id: 'chunk1',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'Hello, this is a "complex" message with special chars: <>&\n\t',
            },
            finish_reason: null,
          },
        ],
      }

      const mockCompletion = createMockCompletion([complexChunk])
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      expect(chunks[0]).toBe(`data: ${JSON.stringify(complexChunk)}\n\n`)
      expect(JSON.parse(chunks[0].replace('data: ', '').replace('\n\n', ''))).toEqual(complexChunk)
    })

    it('should maintain proper SSE format throughout stream', async () => {
      const mockChunks = [
        { id: 'chunk1', choices: [{ delta: { content: 'First' } }] },
        { id: 'chunk2', choices: [{ delta: { content: 'Second' } }] },
        { id: 'chunk3', choices: [{ delta: { content: 'Third' } }] },
      ]

      const mockCompletion = createMockCompletion(mockChunks)
      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')

      const chunks = await readStreamChunks(stream)

      // Verify each chunk follows SSE format: "data: {json}\n\n"
      for (let i = 0; i < chunks.length - 1; i++) {
        // Exclude [DONE] chunk
        expect(chunks[i]).toMatch(/^data: \{.*\}\n\n$/)
      }
      expect(chunks[chunks.length - 1]).toBe('data: [DONE]\n\n')
    })

    it('should handle client disconnection gracefully', async () => {
      const mockAbort = jest.fn()
      const mockChunks = [
        { id: 'chunk1', choices: [{ delta: { content: 'First' } }] },
        { id: 'chunk2', choices: [{ delta: { content: 'Second' } }] },
        { id: 'chunk3', choices: [{ delta: { content: 'Third' } }] },
      ]

      const mockCompletion = {
        ...createMockCompletion(mockChunks),
        controller: { abort: mockAbort },
      }

      const stream = createSSEStreamFromCompletion(mockCompletion as any, 'test-model')
      const reader = stream.getReader()

      // Read first chunk
      await reader.read()

      // Cancel the stream (simulating client disconnect)
      await reader.cancel()

      // Verify abort was called on the OpenAI stream
      expect(mockAbort).toHaveBeenCalled()
      expect(mockConsoleError).not.toHaveBeenCalled()
    })
  })
})
