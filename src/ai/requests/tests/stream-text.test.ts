import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

// Import the function under test
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { UIMessage } from 'ai'
import { extractReasoningMiddleware, streamText, wrapLanguageModel } from 'ai'
import { createSimulatedFetch, parseSseLog, streamTextToUIMessage } from '../util'

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
      const expectedMessage: UIMessage = JSON.parse(readFileSync(testCase.expectedFile, 'utf8'))

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
      expect(actualMessage).toEqual(expectedMessage)
      expect(JSON.stringify(actualMessage, null, 2)).toMatchSnapshot()
    })
  }
})
