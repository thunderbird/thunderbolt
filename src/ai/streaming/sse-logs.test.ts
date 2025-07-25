import { beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Import the function under test
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { extractReasoningMiddleware, streamText, wrapLanguageModel } from 'ai'
import { createSimulatedFetch, parseSseLog, streamTextToUIMessage } from './util'

// ---------------------------------------------------------------------------
// Test Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers all test cases by finding .sse files in the sse-logs directory
 */
function discoverTestCases(): Array<{ name: string; streamFile: string }> {
  const sseLogsDir = join(__dirname, 'sse-logs')

  try {
    const entries = readdirSync(sseLogsDir)
    const testCases: Array<{ name: string; streamFile: string }> = []

    for (const entry of entries) {
      const entryPath = join(sseLogsDir, entry)

      // Check if it's a .sse file
      if (entry.endsWith('.sse')) {
        try {
          // Check if file exists and is readable
          readFileSync(entryPath, 'utf8')

          // Use filename without extension as test name
          const name = entry.replace('.sse', '')

          testCases.push({
            name,
            streamFile: entryPath,
          })
        } catch {
          // Skip if file is not readable
          console.warn(`Warning: Cannot read SSE file ${entry}`)
        }
      }
    }

    return testCases
  } catch {
    // If sse-logs directory doesn't exist or can't be read
    console.warn('Warning: sse-logs directory not found or not readable')
    return []
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE -> UIMessage:', () => {
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
    it(testCase.name, async () => {
      // Arrange ----------------------------------------------------------
      // Load and parse SSE data from file
      const sseData = readFileSync(testCase.streamFile, 'utf8')
      const chunks = parseSseLog(sseData)

      // Create simulated fetch with the parsed chunks
      const simulatedFetch = createSimulatedFetch(chunks, {
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      })

      // Set up the model with the same pattern as sse.test.ts
      const provider = createOpenAICompatible({
        name: 'local-test',
        baseURL: 'http://localhost:3000',
        fetch: simulatedFetch,
      })

      const model = provider('test-model')

      const wrappedModel = wrapLanguageModel({
        model,
        middleware: [extractReasoningMiddleware({ tagName: 'think' })],
      })

      // Act --------------------------------------------------------------
      const result = streamText({
        model: wrappedModel,
        prompt: '<test>',
      })

      // Collect the final message from the stream
      const actualMessage = await streamTextToUIMessage(result)

      // Assert -----------------------------------------------------------
      // Use snapshot testing instead of comparing to JSON files
      expect(JSON.stringify(actualMessage, null, 2)).toMatchSnapshot()
    })
  }
})
