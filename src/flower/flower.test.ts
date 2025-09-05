import { createFlowerMiddleware } from '@/src/ai/middleware/default'
import { streamText, wrapLanguageModel } from 'ai'
import { describe, expect, it } from 'bun:test'
import { createFlowerProvider, type FlowerChatArgs, type FlowerClient, type FlowerProviderOptions } from './flower'

type MockFlowerClient = FlowerClient & {
  captured: FlowerChatArgs | null
}

const makeMockFlowerClient = (chunks: string[]): MockFlowerClient => {
  let capturedArgs: FlowerChatArgs | null = null
  return {
    get captured() {
      return capturedArgs
    },
    async chat(args: FlowerChatArgs) {
      capturedArgs = args
      if (!args.stream) {
        return {
          ok: true as const,
          message: { content: chunks.join('') },
        }
      }
      // Simulate streaming
      for (const chunk of chunks) {
        await new Promise<void>((r) => setTimeout(r, 0))
        args.onStreamEvent?.({ chunk })
      }
      // Return the final result (this is how real Flower API works)
      return {
        ok: true as const,
        message: { content: chunks.join('') },
      }
    },
  }
}

const withProvider = (chunks: string[], opts: Partial<FlowerProviderOptions> = {}) => {
  const mock = makeMockFlowerClient(chunks)
  const provider = createFlowerProvider({
    client: mock,
    apiKey: 'test-api-key',
    baseUrl: 'http://localhost:8000/flower/v1',
    ...opts,
  })
  return { provider, mock }
}

describe('Flower provider unit tests', () => {
  it('streams plain text', async () => {
    const { provider, mock } = withProvider(['Hello', ' ', 'world!'])
    const model = provider('qwen/qwen3-235b')

    const wrapped = wrapLanguageModel({ model, middleware: createFlowerMiddleware(false) })
    const result = streamText({ model: wrapped, prompt: 'ping' })

    await result.consumeStream()
    const text = await result.text

    expect(text).toBe('Hello world!')
    expect(mock.captured?.model).toBe('qwen/qwen3-235b')
    expect(mock.captured?.forceRemote).toBe(true)
    expect(mock.captured?.stream).toBe(true)
  })

  it('does not parse tool calls when provider returns only text', async () => {
    const chunks = ['Before ', '<|tool_call_begin|>functions.search:1<|tool_call_end|>', ' After']
    const { provider } = withProvider(chunks)
    const model = provider('qwen/qwen3-235b')

    const wrapped = wrapLanguageModel({ model, middleware: createFlowerMiddleware(false) })
    const result = streamText({ model: wrapped, prompt: 'ping' })

    await result.consumeStream()
    const text = await result.text

    expect(text).toContain('Before ')
    expect(text).toContain('After')
  })
})
