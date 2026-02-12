import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import type { SourceMetadata } from '@/types/source'
import { createMessageMetadata } from './message-metadata'

describe('createMessageMetadata', () => {
  const modelId = 'test-model'
  let originalDateNow: () => number

  beforeEach(() => {
    originalDateNow = Date.now
  })

  afterEach(() => {
    Date.now = originalDateNow
  })

  describe('default behavior', () => {
    it('returns modelId for unknown part types', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'unknown-type' } })

      expect(result).toEqual({ modelId })
    })

    it('returns modelId and usage for finish-step', () => {
      const metadata = createMessageMetadata(modelId)
      const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }

      const result = metadata({ part: { type: 'finish-step', usage } })

      expect(result).toEqual({ modelId, usage })
    })
  })

  describe('tool call timing', () => {
    it('returns modelId on tool-call start', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'tool-call', toolCallId: 'call-123' } })

      expect(result).toEqual({ modelId })
    })

    it('returns duration on tool-result', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'tool-call', toolCallId: 'call-123' } })

      currentTime = 1500 // 500ms later
      const result = metadata({ part: { type: 'tool-result', toolCallId: 'call-123' } })

      expect(result).toEqual({ reasoningTime: { 'call-123': 500 } })
    })

    it('uses part.id as fallback when toolCallId is missing', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'tool-call', id: 'id-456' } })

      currentTime = 2000
      const result = metadata({ part: { type: 'tool-result', id: 'id-456' } })

      expect(result).toEqual({ reasoningTime: { 'id-456': 1000 } })
    })

    it('uses "unknown" when no id is provided', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'tool-call' } })

      currentTime = 1200
      const result = metadata({ part: { type: 'tool-result' } })

      expect(result).toEqual({ reasoningTime: { unknown: 200 } })
    })

    it('returns modelId when tool-result has no matching start', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'tool-result', toolCallId: 'no-start' } })

      expect(result).toEqual({ modelId })
    })

    it('tracks multiple concurrent tool calls', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'tool-call', toolCallId: 'call-a' } })

      currentTime = 1100
      metadata({ part: { type: 'tool-call', toolCallId: 'call-b' } })

      currentTime = 1300
      const resultB = metadata({ part: { type: 'tool-result', toolCallId: 'call-b' } })

      currentTime = 1500
      const resultA = metadata({ part: { type: 'tool-result', toolCallId: 'call-a' } })

      expect(resultB).toEqual({ reasoningTime: { 'call-b': 200 } })
      expect(resultA).toEqual({ reasoningTime: { 'call-a': 500 } })
    })
  })

  describe('reasoning timing', () => {
    it('returns modelId on reasoning-start', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'reasoning-start' } })

      expect(result).toEqual({ modelId })
    })

    it('returns duration on reasoning-end', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'reasoning-start' } })

      currentTime = 1800
      const result = metadata({ part: { type: 'reasoning-end' } })

      expect(result).toEqual({ reasoningTime: { 'reasoning-0': 800 } })
    })

    it('generates incrementing reasoning IDs', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'reasoning-start' } })
      currentTime = 1100
      metadata({ part: { type: 'reasoning-end' } })

      currentTime = 2000
      metadata({ part: { type: 'reasoning-start' } })
      currentTime = 2200
      const result = metadata({ part: { type: 'reasoning-end' } })

      expect(result).toEqual({ reasoningTime: { 'reasoning-1': 200 } })
    })

    it('handles nested reasoning blocks with LIFO order', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      // Start outer reasoning
      metadata({ part: { type: 'reasoning-start' } }) // reasoning-0

      currentTime = 1100
      // Start inner reasoning
      metadata({ part: { type: 'reasoning-start' } }) // reasoning-1

      currentTime = 1300
      // End inner reasoning first (LIFO)
      const innerResult = metadata({ part: { type: 'reasoning-end' } })

      currentTime = 1500
      // End outer reasoning
      const outerResult = metadata({ part: { type: 'reasoning-end' } })

      expect(innerResult).toEqual({ reasoningTime: { 'reasoning-1': 200 } })
      expect(outerResult).toEqual({ reasoningTime: { 'reasoning-0': 500 } })
    })

    it('returns modelId when reasoning-end has no matching start', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'reasoning-end' } })

      expect(result).toEqual({ modelId })
    })
  })

  describe('mixed events', () => {
    it('handles interleaved tool calls and reasoning', () => {
      const metadata = createMessageMetadata(modelId)
      let currentTime = 1000
      Date.now = () => currentTime

      // Tool call starts
      metadata({ part: { type: 'tool-call', toolCallId: 'call-1' } })

      currentTime = 1050
      // Reasoning starts while tool is running
      metadata({ part: { type: 'reasoning-start' } })

      currentTime = 1200
      // Reasoning ends
      const reasoningResult = metadata({ part: { type: 'reasoning-end' } })

      currentTime = 1400
      // Tool completes
      const toolResult = metadata({ part: { type: 'tool-result', toolCallId: 'call-1' } })

      expect(reasoningResult).toEqual({ reasoningTime: { 'reasoning-0': 150 } })
      expect(toolResult).toEqual({ reasoningTime: { 'call-1': 400 } })
    })
  })

  describe('source propagation', () => {
    const mockSources: SourceMetadata[] = [
      { index: 1, url: 'https://example.com', title: 'Example', toolName: 'search' },
      { index: 2, url: 'https://other.com', title: 'Other', toolName: 'fetch_content' },
    ]

    it('includes sources snapshot in finish-step metadata', () => {
      const sourceCollector: SourceMetadata[] = [...mockSources]
      const metadata = createMessageMetadata(modelId, sourceCollector)

      const result = metadata({ part: { type: 'finish-step' } })

      expect(result.sources).toEqual(mockSources)
    })

    it('includes sources snapshot in tool-result metadata', () => {
      const sourceCollector: SourceMetadata[] = [...mockSources]
      const metadata = createMessageMetadata(modelId, sourceCollector)
      let currentTime = 1000
      Date.now = () => currentTime

      metadata({ part: { type: 'tool-call', toolCallId: 'call-1' } })

      currentTime = 1500
      const result = metadata({ part: { type: 'tool-result', toolCallId: 'call-1' } })

      expect(result).toEqual({
        reasoningTime: { 'call-1': 500 },
        sources: mockSources,
      })
    })

    it('omits sources key when sourceCollector is empty', () => {
      const sourceCollector: SourceMetadata[] = []
      const metadata = createMessageMetadata(modelId, sourceCollector)

      const result = metadata({ part: { type: 'finish-step' } })

      expect(result).toEqual({ modelId, usage: undefined })
      expect(result).not.toHaveProperty('sources')
    })

    it('omits sources key when sourceCollector is undefined', () => {
      const metadata = createMessageMetadata(modelId)

      const result = metadata({ part: { type: 'finish-step' } })

      expect(result).not.toHaveProperty('sources')
    })

    it('returns a copy of sources, not a reference', () => {
      const sourceCollector: SourceMetadata[] = [...mockSources]
      const metadata = createMessageMetadata(modelId, sourceCollector)

      const result = metadata({ part: { type: 'finish-step' } })

      expect(result.sources).toEqual(mockSources)
      expect(result.sources).not.toBe(sourceCollector)
    })

    it('reflects sources added after metadata creation', () => {
      const sourceCollector: SourceMetadata[] = []
      const metadata = createMessageMetadata(modelId, sourceCollector)

      sourceCollector.push(mockSources[0])

      const result = metadata({ part: { type: 'finish-step' } })

      expect(result.sources).toEqual([mockSources[0]])
    })

    it('does not include sources in tool-call events', () => {
      const sourceCollector: SourceMetadata[] = [...mockSources]
      const metadata = createMessageMetadata(modelId, sourceCollector)

      const result = metadata({ part: { type: 'tool-call', toolCallId: 'call-1' } })

      expect(result).toEqual({ modelId })
      expect(result).not.toHaveProperty('sources')
    })

    it('does not include sources in reasoning events', () => {
      const sourceCollector: SourceMetadata[] = [...mockSources]
      const metadata = createMessageMetadata(modelId, sourceCollector)

      const result = metadata({ part: { type: 'reasoning-start' } })

      expect(result).toEqual({ modelId })
      expect(result).not.toHaveProperty('sources')
    })
  })

  describe('isolation between instances', () => {
    it('each instance has independent state', () => {
      let currentTime = 1000
      Date.now = () => currentTime

      const metadata1 = createMessageMetadata('model-1')
      const metadata2 = createMessageMetadata('model-2')

      // Start tool in instance 1
      metadata1({ part: { type: 'tool-call', toolCallId: 'call-1' } })

      currentTime = 1500

      // Instance 2 should not have the start time
      const result2 = metadata2({ part: { type: 'tool-result', toolCallId: 'call-1' } })
      expect(result2).toEqual({ modelId: 'model-2' })

      // Instance 1 should have it
      const result1 = metadata1({ part: { type: 'tool-result', toolCallId: 'call-1' } })
      expect(result1).toEqual({ reasoningTime: { 'call-1': 500 } })
    })

    it('each instance has independent reasoning counter', () => {
      let currentTime = 1000
      Date.now = () => currentTime

      const metadata1 = createMessageMetadata('model-1')
      const metadata2 = createMessageMetadata('model-2')

      // Both instances start reasoning
      metadata1({ part: { type: 'reasoning-start' } })
      metadata2({ part: { type: 'reasoning-start' } })

      currentTime = 1100

      // Both should use reasoning-0 independently
      const result1 = metadata1({ part: { type: 'reasoning-end' } })
      const result2 = metadata2({ part: { type: 'reasoning-end' } })

      expect(result1).toEqual({ reasoningTime: { 'reasoning-0': 100 } })
      expect(result2).toEqual({ reasoningTime: { 'reasoning-0': 100 } })
    })
  })
})
