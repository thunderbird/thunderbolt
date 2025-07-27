import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Import the function under test
import { normalizeUIMessage, sseToUIMessage } from './util'

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
  const testCases = discoverTestCases()

  if (testCases.length === 0) {
    it('should have at least one test case', () => {
      expect(testCases.length).toBeGreaterThan(0)
    })
  }

  for (const testCase of testCases) {
    it(testCase.name, async () => {
      const sseData = readFileSync(testCase.streamFile, 'utf8')
      const message = await sseToUIMessage(sseData)
      const normalizedMessage = normalizeUIMessage(message)
      expect(JSON.stringify(normalizedMessage, null, 2)).toMatchSnapshot()
    })
  }
})
