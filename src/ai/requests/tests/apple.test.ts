// @ts-ignore - Bun test types are provided at runtime
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Apple-specific tests
// ---------------------------------------------------------------------------

/**
 * Test case-specific functionality for the "apple" test case.
 * This test focuses on verifying the specific content and behavior
 * expected from the apple SSE stream scenario.
 */
describe('Apple test case - Specific validations', () => {
  it('should have expected content structure in the apple message', () => {
    // Read the expected message
    const expectedPath = join(__dirname, 'apple.message.json')
    const expectedMessage = JSON.parse(readFileSync(expectedPath, 'utf8'))

    // Assert specific content expectations for the apple test case
    expect(expectedMessage.role).toBe('assistant')
    expect(expectedMessage.content).toContain('<think>')
    expect(expectedMessage.content).toContain('</think>')
    expect(expectedMessage.content).toContain('🌤️ **Weekly Weather Forecast Request**')
    expect(expectedMessage.content).toContain('location')
    expect(expectedMessage.content).toContain('🌍✨')
    expect(expectedMessage.metadata.finishReason).toBe('stop')
  })

  it('should contain thinking and response sections', () => {
    const expectedPath = join(__dirname, 'apple.message.json')
    const expectedMessage = JSON.parse(readFileSync(expectedPath, 'utf8'))

    // Check that the message has both thinking and response parts
    const content = expectedMessage.content
    const thinkStart = content.indexOf('<think>')
    const thinkEnd = content.indexOf('</think>')
    const responseStart = content.indexOf('🌤️')

    expect(thinkStart).toBeGreaterThanOrEqual(0)
    expect(thinkEnd).toBeGreaterThan(thinkStart)
    expect(responseStart).toBeGreaterThan(thinkEnd)

    // Verify thinking content
    const thinkingContent = content.slice(thinkStart + 7, thinkEnd) // +7 for '<think>\n'
    expect(thinkingContent).toContain('weather forecast')
    expect(thinkingContent).toContain('location')
    expect(thinkingContent).toContain('ask')

    // Verify response content
    const responseContent = content.slice(responseStart)
    expect(responseContent).toContain('Weekly Weather Forecast Request')
    expect(responseContent).toContain('accurate forecast')
    expect(responseContent).toContain("where you're located")
  })

  it('should have correct SSE stream file structure', () => {
    const streamPath = join(__dirname, 'apple.text-stream')
    const streamContent = readFileSync(streamPath, 'utf8')

    // Verify it's properly formatted SSE
    expect(streamContent).toContain('data: {')
    expect(streamContent).toContain('"choices"')
    expect(streamContent).toContain('"delta"')
    expect(streamContent).toContain('"finish_reason":"stop"')
    expect(streamContent).toContain('data: [DONE]')

    // Check for specific content chunks
    expect(streamContent).toContain('"role":"assistant"')
    expect(streamContent).toContain('<think>')
    expect(streamContent).toContain('🌤️')
    expect(streamContent).toContain('Weekly Weather Forecast')
  })
})
