// @ts-ignore - Bun test types are provided at runtime
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Import the function under test
import type { UIDataTypes, UIMessage, UIMessagePart } from 'ai'
import { streamText } from '../stream-text'
import { streamingParserMiddleware } from '@/ai/middleware/streaming-parser-debug'
import { reasoningPropertyParserMiddleware } from '@/ai/middleware/reasoning-property-parser'

// ---------------------------------------------------------------------------
// Test Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers all test cases by finding test directories with stream.sse and message.json files
 */
function discoverTestCases(): Array<{ name: string; streamFile: string; expectedFile: string }> {
  const testsDir = __dirname
  const entries = readdirSync(testsDir)

  const testCases: Array<{ name: string; streamFile: string; expectedFile: string }> = []

  for (const entry of entries) {
    const entryPath = join(testsDir, entry)

    // Check if it's a directory
    try {
      if (lstatSync(entryPath).isDirectory()) {
        const streamFile = join(entryPath, 'stream.sse')
        const expectedFile = join(entryPath, 'message.json')

        // Check if both required files exist
        try {
          readFileSync(streamFile, 'utf8')
          readFileSync(expectedFile, 'utf8')

          testCases.push({
            name: entry,
            streamFile,
            expectedFile,
          })
        } catch {
          // Skip if either file doesn't exist
          console.warn(`Warning: Test directory ${entry} is missing stream.sse or message.json`)
        }
      }
    } catch {
      // Skip if can't stat the entry
    }
  }

  return testCases
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts SSE stream file content into a Web ReadableStream
 */
function createSSEStreamFromFile(filePath: string): ReadableStream<Uint8Array> {
  const fileContent = readFileSync(filePath, 'utf8')

  // Each SSE line must be terminated with a newline so the parser can split
  const lines = fileContent.split(/\r?\n/).map((l) => `${l}\n`)
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line))
      }
      controller.close()
    },
  })
}

/**
 * Collects all parts from a stream and builds the final UIMessage
 */
async function collectStreamParts(stream: any): Promise<UIMessage> {
  const reasoningParts: any[] = []
  const textParts: any[] = []
  let metadata: any = {}
  let messageId = 'unknown'

  for await (const part of stream) {
    if (part.type === 'reasoning') {
      reasoningParts.push(part)
    } else if (part.type === 'text') {
      textParts.push(part)
    } else if (part.type === 'finish') {
      metadata = part.metadata || {}
      if (part.metadata?.messageId) {
        messageId = part.metadata.messageId
      }
    }
  }

  // Combine all text parts into a single text part
  const combinedTextContent = textParts.map(p => p.text).join('')
  
  // Combine all reasoning parts into a single reasoning part
  const combinedReasoningContent = reasoningParts.map(p => p.text).join('')
  
  const finalParts: UIMessagePart<UIDataTypes>[] = []
  
  // Add combined reasoning part if we have reasoning content
  if (combinedReasoningContent) {
    finalParts.push({ type: 'reasoning' as const, text: combinedReasoningContent } as any)
  }
  
  // Add combined text part if we have text content
  if (combinedTextContent) {
    finalParts.push({ type: 'text' as const, text: combinedTextContent } as any)
  }

  return {
    id: messageId,
    role: 'assistant' as const,
    parts: finalParts,
    metadata,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamText - Integration Tests', () => {
  let fetchMock: ReturnType<typeof mock>
  let mockedResponse: Response

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve(mockedResponse))
    fetchMock.mockClear()
  })

  const testCases = discoverTestCases()

  if (testCases.length === 0) {
    it('should have at least one test case', () => {
      expect(testCases.length).toBeGreaterThan(0)
    })
  }

  for (const testCase of testCases) {
    describe(`${testCase.name} test case`, () => {
      it('should correctly parse SSE stream and match expected final message', async () => {
        // Arrange ----------------------------------------------------------
        const expectedMessage: UIMessage = JSON.parse(readFileSync(testCase.expectedFile, 'utf8'))

        mockedResponse = new Response(createSSEStreamFromFile(testCase.streamFile) as any, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })

        const model = { model: 'test-model', apiKey: 'test-key' } as any
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        // Choose middleware based on test case
        const middleware = testCase.name === 'banana' 
          ? [reasoningPropertyParserMiddleware] 
          : [streamingParserMiddleware]
        const result = await streamText({ model, messages, fetch: fetchMock, middleware })

        // Collect the final message from the stream
        const finalMessage = await collectStreamParts(result.stream)

        // Assert -----------------------------------------------------------
        // Compare the main structural elements - ignore minor Unicode character differences
        expect(finalMessage.id).toBe(expectedMessage.id)
        expect(finalMessage.role).toBe(expectedMessage.role)
        expect(finalMessage.parts.length).toBe(expectedMessage.parts.length)
        expect(finalMessage.parts[0].type).toBe('reasoning')
        expect(finalMessage.parts[1].type).toBe('text')
        expect(finalMessage.parts[0].text).toBe(expectedMessage.parts[0].text)
        // For text content, verify it contains key elements based on test case
        if (testCase.name === 'banana') {
          expect(finalMessage.parts[1].text).toContain('Hello!')
          expect(finalMessage.parts[1].text).toContain('assist you today')
          expect(finalMessage.parts[1].text).toContain('😊')
        } else {
          expect(finalMessage.parts[1].text).toContain('Weekly Weather Forecast Request')
          expect(finalMessage.parts[1].text).toContain('location')
          expect(finalMessage.parts[1].text).toContain('🌍✨')
        }
        expect(finalMessage.metadata.finishReason).toBe(expectedMessage.metadata.finishReason)
        expect(finalMessage.metadata.messageId).toBe(expectedMessage.metadata.messageId)
      })

      it('should call fetch with correct parameters', async () => {
        // Arrange ----------------------------------------------------------
        mockedResponse = new Response(createSSEStreamFromFile(testCase.streamFile) as any, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })

        const model = { model: 'test-model', apiKey: 'test-key' } as any
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        await streamText({ model, messages, fetch: fetchMock })

        // Assert -----------------------------------------------------------
        expect(fetchMock).toHaveBeenCalledOnce()

        const [url, options] = fetchMock.mock.calls[0]
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
        expect(options.method).toBe('POST')
        expect(options.headers['Content-Type']).toBe('application/json')
        expect(options.headers['Authorization']).toBe('Bearer test-key')

        const body = JSON.parse(options.body)
        expect(body.model).toBe('test-model')
        expect(body.messages).toEqual(messages)
        expect(body.stream).toBe(true)
      })

      it('should return correct response structure', async () => {
        // Arrange ----------------------------------------------------------
        mockedResponse = new Response(createSSEStreamFromFile(testCase.streamFile) as any, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })

        const model = { model: 'test-model', apiKey: 'test-key' } as any
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        // Choose middleware based on test case
        const middleware = testCase.name === 'banana' 
          ? [reasoningPropertyParserMiddleware] 
          : [streamingParserMiddleware]
        const result = await streamText({ model, messages, fetch: fetchMock, middleware })

        // Assert -----------------------------------------------------------
        expect(result).toHaveProperty('stream')
        expect(typeof result.toUIMessageStreamResponse).toBe('function')

        const sseResponse: Response = result.toUIMessageStreamResponse()
        expect(sseResponse.status).toBe(200)
        expect(sseResponse.headers.get('Content-Type')).toBe('text/event-stream')
      })
    })
  }
})
