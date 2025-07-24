// @ts-ignore - Bun test types are provided at runtime
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Import the function under test
import { streamText } from '../stream-text'

// ---------------------------------------------------------------------------
// Test Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers all test cases by finding .text-stream files and their corresponding .message.json files
 */
function discoverTestCases(): Array<{ name: string; streamFile: string; expectedFile: string }> {
  const testsDir = __dirname
  const files = readdirSync(testsDir)

  const testCases: Array<{ name: string; streamFile: string; expectedFile: string }> = []

  for (const file of files) {
    if (file.endsWith('.text-stream')) {
      const testName = file.replace('.text-stream', '')
      const expectedFile = join(testsDir, `${testName}.message.json`)
      const streamFile = join(testsDir, file)

      // Check if corresponding message.json exists
      try {
        readFileSync(expectedFile, 'utf8')
        testCases.push({
          name: testName,
          streamFile,
          expectedFile,
        })
      } catch {
        // Skip if message.json doesn't exist
        console.warn(`Warning: No ${testName}.message.json found for ${testName}.text-stream`)
      }
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
 * Collects all parts from a stream and builds the final message
 */
async function collectStreamParts(stream: any): Promise<{ role: string; content: string; metadata: any }> {
  const parts: Array<{ type: string; [key: string]: any }> = []

  for await (const part of stream) {
    parts.push(part)
  }

  // Extract role (should be in the first delta, but we'll default to 'assistant')
  const role = 'assistant'

  // Concatenate all text parts
  const content = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')

  // Get finish metadata
  const finishPart = parts.find((p) => p.type === 'finish')
  const metadata = finishPart?.metadata || {}

  return { role, content, metadata }
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
        const expectedMessage = JSON.parse(readFileSync(testCase.expectedFile, 'utf8'))

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
        expect(finalMessage.role).toBe(expectedMessage.role)
        expect(finalMessage.content).toBe(expectedMessage.content)
        expect(finalMessage.metadata.finishReason).toBe(expectedMessage.metadata.finishReason)
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
