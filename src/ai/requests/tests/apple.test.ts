// @ts-ignore - Bun test types are provided at runtime
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Mock response that will be returned by our fetch implementation.
// The body streams the contents of the sample Server-Sent Events (SSE)
// recording located in `mocks/apple.txt`.
let mockedResponse: Response

const fetchMock = mock(() => Promise.resolve(mockedResponse))

// Import the function under test
import { streamText } from '../stream-text'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts the contents of `mocks/apple.txt` into a Web {@link ReadableStream}.
 */
function createMockSSEStream(): ReadableStream<Uint8Array> {
  const filePath = join(__dirname, '../mocks/apple.txt')
  const fileContent = readFileSync(filePath, 'utf8')

  // Each SSE line must be terminated with a newline so the parser can split.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamText', () => {
  beforeEach(() => {
    // Reset the mock call history before each test
    fetchMock.mockClear()
  })

  it('returns a stream and UIMessageStreamResponse that reflect the SSE input', async () => {
    // Arrange --------------------------------------------------------------
    mockedResponse = new Response(createMockSSEStream() as any, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })

    const model = { model: 'test-model', apiKey: 'test-key' } as any
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'user', content: 'Hello, world!' },
    ]

    // Act ------------------------------------------------------------------
    const result = await streamText({ model, messages, fetch: fetchMock })

    // Assert: basic shape ---------------------------------------------------
    expect(result).toHaveProperty('stream')
    expect(typeof result.toUIMessageStreamResponse).toBe('function')

    // The mock `fetch` should have been invoked exactly once.
    expect(fetchMock).toHaveBeenCalledOnce()

    // Collect the streamed parts so we can assert on their content.
    const parts: Array<{ type: string; [key: string]: any }> = []
    for await (const part of result.stream as any) {
      parts.push(part)
    }

    // We expect at least one text chunk and a terminating finish chunk.
    expect(parts.some((p) => p.type === 'text')).toBe(true)
    expect(parts.find((p) => p.type === 'finish')).toBeDefined()

    // The helper should be able to turn the stream into an SSE Response.
    const sseResponse: Response = result.toUIMessageStreamResponse()
    expect(sseResponse.status).toBe(200)
    expect(sseResponse.headers.get('Content-Type')).toBe('text/event-stream')
  })
})
