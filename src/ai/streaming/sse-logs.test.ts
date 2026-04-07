import { getClock } from '@/testing-library'
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUIMessage, parseEnhancedSseFile, sseToUIMessage } from './util'

// ---------------------------------------------------------------------------
// Test Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers all test cases by finding .sse files in the sse-logs directory
 */
const discoverTestCases = (): Array<{
  name: string
  streamFile: string
  description?: string
  metadata: Record<string, any>
}> => {
  const sseLogsDir = join(__dirname, 'sse-logs')

  try {
    const entries = readdirSync(sseLogsDir).sort()
    const testCases: Array<{
      name: string
      streamFile: string
      description?: string
      metadata: Record<string, any>
    }> = []

    for (const entry of entries) {
      const entryPath = join(sseLogsDir, entry)

      // Check if it's a .sse file
      if (entry.endsWith('.sse')) {
        try {
          // Read and parse the enhanced SSE file
          const fileContent = readFileSync(entryPath, 'utf8')
          const { metadata } = parseEnhancedSseFile(fileContent)

          // Use filename without extension as test name
          const name = entry.replace('.sse', '')

          testCases.push({
            name,
            streamFile: entryPath,
            description: metadata.description,
            metadata,
          })
        } catch (error) {
          // Skip if file is not readable or parseable
          console.warn('Warning: Cannot parse SSE file %s:', entry, error)
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
  const testCases = discoverTestCases()

  if (testCases.length === 0) {
    it('should have at least one test case', () => {
      expect(testCases.length).toBeGreaterThan(0)
    })
  }

  for (const testCase of testCases) {
    const testDescription = testCase.description ? `${testCase.name} - ${testCase.description}` : testCase.name

    it(testDescription, async () => {
      // Note on ordering (SDK v5):
      // We use extractReasoningMiddleware to turn <think>...</think> into a separate
      // "reasoning" part and strip the tags from the visible text.
      // The middleware buffers reasoning until the closing </think> tag is seen,
      // while text (with think-tags removed) can be emitted earlier.
      // As a result, the aggregated UIMessage produced by toUIMessageStream (which
      // we snapshot here) can show text before reasoning. In contrast, the live UI
      // renders chunks as they arrive (reasoning-start before text-delta), so users
      // still see reasoning first while streaming. This difference is expected and
      // does not affect UI behavior.
      const fileContent = readFileSync(testCase.streamFile, 'utf8')
      const { metadata, responses } = parseEnhancedSseFile(fileContent)

      // Use the first response for testing (could be extended to test all responses)
      const sseData = responses[0]

      const message = await sseToUIMessage(sseData, {
        startWithReasoning: metadata.start_with_reasoning ?? false,
        initialDelayInMs: metadata.initial_delay_ms,
        chunkDelayInMs: metadata.chunk_delay_ms,
        advanceTimers: async () => {
          // Advance timers while the stream is being consumed
          await getClock().runAllAsync()
        },
      })

      const normalizedMessage = normalizeUIMessage(message)
      expect(JSON.stringify(normalizedMessage, null, 2)).toMatchSnapshot()
    })
  }
})
