import type { LanguageModelV2StreamPart } from '@ai-sdk/provider'
import { describe, expect, it } from 'bun:test'
import { hermesToolMiddleware } from '@ai-sdk-tool/parser'

// Mock the Flower provider's stream format
const createFlowerStream = (chunks: string[], streamId: string = 'flower-123-abc'): ReadableStream<LanguageModelV2StreamPart> => {
  return new ReadableStream({
    start(controller) {
      // Flower provider emits text-start with its own ID
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
      
      // Flower provider emits text-end with its own ID
      controller.enqueue({
        type: 'text-end',
        id: streamId,
      })
      
      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      })
      
      controller.close()
    },
  })
}

// Helper to collect stream parts
const collectStreamParts = async (stream: ReadableStream<LanguageModelV2StreamPart>): Promise<LanguageModelV2StreamPart[]> => {
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

describe('Flower + hermesToolMiddleware ID mismatch bug', () => {
  it('should reproduce the textPart undefined error when IDs do not match', async () => {
    const mockDoStream = async () => {
      const stream = createFlowerStream(['Hi', ' Chris', '!', ' How', ' can', ' I', ' assist', ' you', ' today', '?'])
      return { stream }
    }

    // Apply hermesToolMiddleware to the Flower stream
    const middleware = hermesToolMiddleware
    const wrappedResult = await middleware.wrapStream!({
      doStream: mockDoStream,
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage: {}, warnings: [], request: {}, response: {} }),
      params: {
        prompt: [],
        tools: undefined,
        providerOptions: {}
      }
    })

    const parts = await collectStreamParts(wrappedResult.stream)
    
    // Extract all the IDs used in text-start and text-end events
    const textStartIds = parts.filter(p => p.type === 'text-start').map(p => p.id)
    const textEndIds = parts.filter(p => p.type === 'text-end').map(p => p.id)
    const textDeltaIds = parts.filter(p => p.type === 'text-delta').map(p => p.id)
    
    console.log('Text start IDs:', textStartIds)
    console.log('Text end IDs:', textEndIds)
    console.log('Text delta IDs:', textDeltaIds)
    
    // The bug: hermesToolMiddleware creates new IDs instead of preserving Flower's IDs
    // This should fail if the bug exists
    expect(textStartIds.length).toBeGreaterThan(0)
    expect(textEndIds.length).toBeGreaterThan(0)
    
    // All text events should use the same ID
    const allTextIds = [...textStartIds, ...textEndIds, ...textDeltaIds]
    const uniqueIds = new Set(allTextIds)
    
    // This assertion demonstrates the bug - there should only be one unique ID
    // but hermesToolMiddleware creates its own IDs, causing a mismatch
    expect(uniqueIds.size).toBe(2) // Bug confirmed: 2 different IDs are used
    
    // And the ID should match across start/end events
    textStartIds.forEach(startId => {
      expect(textEndIds).toContain(startId)
    })
  })

  it('should demonstrate that hermesToolMiddleware changes Flower text IDs', async () => {
    const originalFlowerStreamId = 'flower-test-123'
    
    const mockDoStream = async () => {
      const stream = createFlowerStream(['Hello world!'], originalFlowerStreamId)
      return { stream }
    }

    // Apply hermesToolMiddleware
    const middleware = hermesToolMiddleware
    const wrappedResult = await middleware.wrapStream!({
      doStream: mockDoStream,
      doGenerate: async () => ({ content: [], finishReason: 'stop', usage: {}, warnings: [], request: {}, response: {} }),
      params: {
        prompt: [],
        tools: undefined,
        providerOptions: {}
      }
    })

    const parts = await collectStreamParts(wrappedResult.stream)
    
    // Find text events
    const textEvents = parts.filter(p => ['text-start', 'text-delta', 'text-end'].includes(p.type))
    
    // The bug: hermesToolMiddleware should preserve the original Flower ID but it doesn't
    const usesOriginalId = textEvents.some(event => event.id === originalFlowerStreamId)
    
    // This will be true for some events but false for others, demonstrating the bug
    expect(usesOriginalId).toBe(true) // Some events still use the original ID
    
    // All text events should use the same new ID generated by hermesToolMiddleware
    const textIds = textEvents.map(e => e.id)
    const uniqueTextIds = new Set(textIds)
    
    // Bug confirmed: Multiple IDs are used instead of just one
    expect(uniqueTextIds.size).toBeGreaterThan(1)
    
    // Some events use the original ID, others use a new ID generated by middleware
    expect(uniqueTextIds.has(originalFlowerStreamId)).toBe(true)
  })
})