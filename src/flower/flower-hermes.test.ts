import { readUIMessageStream, streamText, wrapLanguageModel } from 'ai'
import { describe, expect, it } from 'bun:test'
import { createFlowerProvider } from './flower'
import { createFlowerMiddleware } from '@/src/ai/middleware/default'

// Simple mock Flower client that streams the supplied chunks
const createMockFlowerClient = (chunks: string[]) => {
  return {
    async chat(args: any) {
      if (!args.stream) {
        return { content: chunks.join('') }
      }

      for (const chunk of chunks) {
        await new Promise<void>((r) => setTimeout(r, 0))
        args.onStreamEvent?.({ chunk })
      }
    },
  }
}

describe('Flower provider + Hermes tool middleware', () => {
  it('streams without throwing when hermesToolMiddleware is enabled', async () => {
    const chunks = ['Hi', ' there', '!']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({ client: mockClient })
    const model = provider('qwen/qwen3-235b')

    const wrappedModel = wrapLanguageModel({
      model,
      middleware: createFlowerMiddleware(false),
    })

    const result = streamText({ model: wrappedModel, prompt: 'Hello' })

    // Consume the UI stream to ensure no runtime errors occur
    const uiStream = result.toUIMessageStream({ sendReasoning: true })
    const reader = readUIMessageStream({ stream: uiStream })

    for await (const _msg of reader) {
      /* just iterate to completion */
    }

    const finalText = await result.text
    expect(finalText).toBe('Hi there!')
  })
})