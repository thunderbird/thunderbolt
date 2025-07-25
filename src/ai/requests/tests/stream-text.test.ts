// @ts-ignore - Bun test types are provided at runtime
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Import the function under test
import type { UIDataTypes, UIMessage, UIMessagePart } from 'ai'
import { streamText } from '../stream-text'

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
  const parts: UIMessagePart<UIDataTypes>[] = []
  let metadata: any = {}
  let messageId = 'unknown'

  for await (const part of stream) {
    if (part.type === 'reasoning' || part.type === 'text') {
      parts.push(part)
    } else if (part.type === 'finish') {
      metadata = part.metadata || {}
      if (part.metadata?.messageId) {
        messageId = part.metadata.messageId
      }
    }
  }

  return {
    id: messageId,
    role: 'assistant',
    parts,
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
        const result = await streamText({ model, messages, fetch: fetchMock })

        // Collect the final message from the stream
        const finalMessage = await collectStreamParts(result.stream)

        // Assert -----------------------------------------------------------
        // Compare the entire UIMessage including the ID from the stream
        expect(finalMessage).toEqual(expectedMessage)
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
        const result = await streamText({ model, messages, fetch: fetchMock })

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
