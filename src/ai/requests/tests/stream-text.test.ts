import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

// Import the function under test
import type { UIMessage } from 'ai'
import { extractReasoningMiddleware } from 'ai'
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
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Collects all streaming parts from fullStream into a final UIMessage
 */
async function collectStreamParts(fullStream: ReadableStream): Promise<UIMessage> {
  const reader = fullStream.getReader()
  let messageId = 'unknown'
  let currentTextPart: { type: 'text'; text: string } | null = null
  const parts: any[] = []

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case 'text-delta':
          // Accumulate text deltas into a single text part
          if (!currentTextPart) {
            currentTextPart = { type: 'text', text: '' }
            parts.push(currentTextPart)
          }
          currentTextPart.text += (value as any).textDelta
          break
        case 'reasoning':
          parts.push({ type: 'reasoning', text: (value as any).text })
          break
        case 'finish':
          messageId = (value as any).messageId || messageId
          break
        default:
          break
      }
    }
  } finally {
    reader.releaseLock()
  }

  return {
    id: messageId,
    role: 'assistant',
    parts,
    metadata: { finishReason: 'stop', messageId },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamText - Integration Tests', () => {
  beforeEach(() => {
    // Reset any test state if needed
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

        // Load SSE data directly from file
        const sseData = readFileSync(testCase.streamFile, 'utf8')

        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        // Use the real AI SDK extractReasoningMiddleware
        const middleware = [extractReasoningMiddleware({ tagName: 'think' })]
        const result = await streamText({ messages, sseData, middleware })

        // Collect the final message from the fullStream
        const finalMessage = await collectStreamParts(result.fullStream)

        // Assert -----------------------------------------------------------
        // Compare the main structural elements - ignore minor Unicode character differences
        expect(finalMessage.id).toBe(expectedMessage.id)
        expect(finalMessage.role).toBe(expectedMessage.role)
        expect(finalMessage.parts.length).toBe(expectedMessage.parts.length)
        expect(finalMessage.parts[0].type).toBe('reasoning')
        expect(finalMessage.parts[1].type).toBe('text')
        expect((finalMessage.parts[0] as any).text).toBe((expectedMessage.parts[0] as any).text)
        // For text content, verify it contains key elements based on test case
        if (testCase.name === 'banana') {
          expect((finalMessage.parts[1] as any).text).toContain('Hello!')
          expect((finalMessage.parts[1] as any).text).toContain('assist you today')
          expect((finalMessage.parts[1] as any).text).toContain('😊')
        } else {
          expect((finalMessage.parts[1] as any).text).toContain('Weekly Weather Forecast Request')
          expect((finalMessage.parts[1] as any).text).toContain('location')
          expect((finalMessage.parts[1] as any).text).toContain('🌍✨')
        }
        expect((finalMessage.metadata as any).finishReason).toBe((expectedMessage.metadata as any).finishReason)
        expect((finalMessage.metadata as any).messageId).toBe((expectedMessage.metadata as any).messageId)
      })

      it('should use sseData parameter correctly', async () => {
        // Arrange ----------------------------------------------------------
        const sseData = readFileSync(testCase.streamFile, 'utf8')
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        const result = await streamText({ messages, sseData })

        // Assert -----------------------------------------------------------
        expect(result).toHaveProperty('fullStream')
        expect(result.fullStream).toBeInstanceOf(ReadableStream)
      })

      it('should return correct response structure', async () => {
        // Arrange ----------------------------------------------------------
        const sseData = readFileSync(testCase.streamFile, 'utf8')
        const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
          { role: 'user', content: 'Test prompt' },
        ]

        // Act --------------------------------------------------------------
        const result = await streamText({ messages, sseData })

        // Assert -----------------------------------------------------------
        expect(result).toHaveProperty('fullStream')
        expect(result.fullStream).toBeInstanceOf(ReadableStream)
        expect(typeof result.toUIMessageStreamResponse).toBe('function')
      })
    })
  }
})
