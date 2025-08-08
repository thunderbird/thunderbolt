import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { describe, expect, it } from 'bun:test'

describe('Flower via OpenAI-compatible interface', () => {
  it('should work with OpenAI-compatible streaming', async () => {
    // This simulates what fetch.ts does for Flower
    const cloudUrl = 'http://localhost:8000' // Or your actual backend URL
    const apiKey = 'test-flower-key' // This would come from getFlowerApiKey()

    const flowerCompatible = createOpenAICompatible({
      name: 'flower',
      baseURL: `${cloudUrl}/flower/v1`,
      apiKey: apiKey,
      fetch: Object.assign(
        async (url: RequestInfo | URL, options?: RequestInit) => {
          console.log('Fetch called with URL:', url)
          console.log('Fetch options:', {
            method: options?.method,
            headers: options?.headers,
            body: options?.body ? JSON.parse(options.body as string) : undefined,
          })

          // Simulate a successful streaming response
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              // Simulate OpenAI-compatible SSE format
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"qwen/qwen3-235b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
                ),
              )
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"qwen/qwen3-235b","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
                ),
              )
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"qwen/qwen3-235b","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
                ),
              )
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"qwen/qwen3-235b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
                ),
              )
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          })

          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
          })
        },
        { preconnect: () => Promise.resolve(false) },
      ),
    })

    const model = flowerCompatible('qwen/qwen3-235b')

    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'Say hello' }],
    })

    const chunks: string[] = []
    for await (const chunk of result.textStream) {
      console.log('Got chunk:', chunk)
      chunks.push(chunk)
    }

    const finalText = await result.text
    console.log('Final text:', finalText)

    expect(chunks).toEqual(['Hello', ' world'])
    expect(finalText).toBe('Hello world')
  })
})
