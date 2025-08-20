import { hermesToolMiddleware } from '@ai-sdk-tool/parser'
import type { LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider'
import { describe, expect, it } from 'bun:test'

/**
 * Helper to create proper usage object that matches LanguageModelV2Usage type
 */
const createUsage = (): LanguageModelV2Usage => ({
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
})

/**
 * Mock stream that simulates the problematic behavior where a provider
 * emits text-start and text-end events with its own IDs alongside text-delta events.
 * This creates ID mismatches when used with hermesToolMiddleware.
 */
const createProblematicProviderStream = (
  chunks: string[],
  streamId: string = 'provider-123-abc',
): ReadableStream<LanguageModelV2StreamPart> => {
  return new ReadableStream({
    start(controller) {
      // Provider emits text-start with its own ID
      controller.enqueue({
        type: 'text-start',
        id: streamId,
      })

      // Emit text deltas with the same ID
      for (const chunk of chunks) {
        controller.enqueue({
          type: 'text-delta',
          id: streamId,
          delta: chunk,
        })
      }

      // Provider emits text-end with its own ID
      controller.enqueue({
        type: 'text-end',
        id: streamId,
      })

      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        usage: createUsage(),
      })

      controller.close()
    },
  })
}

/**
 * Mock stream that simulates the correct behavior where a provider
 * only emits text-delta events, allowing middleware to control text boundaries.
 * This is how the Flower provider is actually implemented.
 */
const createCorrectProviderStream = (
  chunks: string[],
  streamId: string = 'provider-123-abc',
): ReadableStream<LanguageModelV2StreamPart> => {
  return new ReadableStream({
    start(controller) {
      // Provider only emits text-delta events (no text-start/text-end)
      for (const chunk of chunks) {
        controller.enqueue({
          type: 'text-delta',
          id: streamId,
          delta: chunk,
        })
      }

      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        usage: createUsage(),
      })

      controller.close()
    },
  })
}

/**
 * Helper to collect all stream parts from a readable stream
 */
const collectStreamParts = async (
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> => {
  const parts: LanguageModelV2StreamPart[] = []
  const reader = stream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return parts
}

/**
 * Type guard for stream parts that have an ID property
 */
type StreamPartWithId = LanguageModelV2StreamPart & { id: string }

const hasId = (part: LanguageModelV2StreamPart): part is StreamPartWithId => {
  return 'id' in part && typeof (part as StreamPartWithId).id === 'string'
}

/**
 * Type guard for text-delta stream parts
 */
type TextDeltaPart = LanguageModelV2StreamPart & { type: 'text-delta'; id: string; delta: string }

const isTextDelta = (part: LanguageModelV2StreamPart): part is TextDeltaPart => {
  return part.type === 'text-delta' && 'delta' in part && 'id' in part
}

/**
 * Mock middleware wrapStream parameters (simplified for testing)
 */
type MockWrapStreamParams = {
  doStream: () => Promise<{ stream: ReadableStream<LanguageModelV2StreamPart> }>
  params: {
    prompt: any[]
    tools: any
    providerOptions: Record<string, any>
  }
}

describe('hermesToolMiddleware ID consistency', () => {
  it('should handle ID mismatches when provider emits text-start/text-end with own IDs', async () => {
    const originalProviderId = 'provider-test-123'

    const mockDoStream = async () => {
      const stream = createProblematicProviderStream(['Hello', ' world', '!'], originalProviderId)
      return { stream }
    }

    // Apply hermesToolMiddleware to the problematic stream
    const middleware = hermesToolMiddleware
    const mockParams: MockWrapStreamParams = {
      doStream: mockDoStream,
      params: {
        prompt: [],
        tools: undefined,
        providerOptions: {},
      },
    }
    const wrappedResult = await (middleware.wrapStream as any)(mockParams)

    const parts = await collectStreamParts(wrappedResult.stream)

    // Extract text events with IDs
    const textStartParts = parts.filter((p) => p.type === 'text-start' && hasId(p))
    const textEndParts = parts.filter((p) => p.type === 'text-end' && hasId(p))
    const textDeltaParts = parts.filter((p) => p.type === 'text-delta' && hasId(p))

    // Should have text events
    expect(textStartParts.length).toBeGreaterThan(0)
    expect(textEndParts.length).toBeGreaterThan(0)
    expect(textDeltaParts.length).toBeGreaterThan(0)

    // Collect all IDs used
    const allTextIds = [
      ...textStartParts.map((p) => p.id),
      ...textEndParts.map((p) => p.id),
      ...textDeltaParts.map((p) => p.id),
    ]
    const uniqueIds = new Set(allTextIds)

    // This demonstrates the potential ID mismatch issue
    // In practice, middleware might create new IDs for text-start/text-end
    // while preserving original IDs for text-delta events
    expect(uniqueIds.size).toBeGreaterThan(1) // Demonstrates ID mismatch issue

    // At minimum, text-start and text-end should have matching IDs
    if (textStartParts.length > 0 && textEndParts.length > 0) {
      expect(textStartParts[0].id).toBe(textEndParts[0].id)
    }
  })

  it('should maintain consistent IDs when provider only emits text-delta events (Flower approach)', async () => {
    const originalProviderId = 'flower-test-123'

    const mockDoStream = async () => {
      const stream = createCorrectProviderStream(['Hello', ' world', '!'], originalProviderId)
      return { stream }
    }

    // Apply hermesToolMiddleware to the correct stream
    const middleware = hermesToolMiddleware
    const mockParams: MockWrapStreamParams = {
      doStream: mockDoStream,
      params: {
        prompt: [],
        tools: undefined,
        providerOptions: {},
      },
    }
    const wrappedResult = await (middleware.wrapStream as any)(mockParams)

    const parts = await collectStreamParts(wrappedResult.stream)

    // Extract text events with IDs
    const textStartParts = parts.filter((p) => p.type === 'text-start' && hasId(p))
    const textEndParts = parts.filter((p) => p.type === 'text-end' && hasId(p))
    const textDeltaParts = parts.filter((p) => p.type === 'text-delta' && hasId(p))

    // hermesToolMiddleware should create consistent text boundaries
    expect(textStartParts.length).toBe(1)
    expect(textEndParts.length).toBe(1)

    // All text events should use consistent IDs (controlled by middleware)
    const allTextIds = [
      ...textStartParts.map((p) => p.id),
      ...textEndParts.map((p) => p.id),
      ...textDeltaParts.map((p) => p.id),
    ]
    const uniqueIds = new Set(allTextIds)

    // Should use consistent IDs across all text events
    expect(uniqueIds.size).toBe(1)

    // Start and end IDs should match
    expect(textStartParts[0].id).toBe(textEndParts[0].id)

    // Middleware should control the ID (might be different from original provider ID)
    const middlewareId = textStartParts[0].id
    expect(typeof middlewareId).toBe('string')
    expect(middlewareId.length).toBeGreaterThan(0)
  })

  it('should work correctly with the actual Flower provider approach', async () => {
    // This test documents how the Flower provider actually works
    const chunks = ['Hi', ' Chris', '!', ' How', ' can', ' I', ' assist', ' you', ' today', '?']

    const mockDoStream = async () => {
      // Simulate actual Flower provider behavior: only text-delta events
      const stream = createCorrectProviderStream(chunks)
      return { stream }
    }

    const middleware = hermesToolMiddleware
    const mockParams: MockWrapStreamParams = {
      doStream: mockDoStream,
      params: {
        prompt: [],
        tools: undefined,
        providerOptions: {},
      },
    }
    const wrappedResult = await (middleware.wrapStream as any)(mockParams)

    const parts = await collectStreamParts(wrappedResult.stream)

    // Should have proper text boundaries created by middleware
    const textStartParts = parts.filter((p) => p.type === 'text-start')
    const textEndParts = parts.filter((p) => p.type === 'text-end')
    const textDeltaParts = parts.filter((p) => p.type === 'text-delta')

    expect(textStartParts.length).toBe(1)
    expect(textEndParts.length).toBe(1)
    expect(textDeltaParts.length).toBe(chunks.length)

    // Verify the text content is preserved
    const combinedText = textDeltaParts
      .filter(isTextDelta)
      .map((p) => p.delta)
      .join('')
    expect(combinedText).toBe(chunks.join(''))

    // Should end with finish event
    const finishParts = parts.filter((p) => p.type === 'finish')
    expect(finishParts.length).toBe(1)
  })
})
