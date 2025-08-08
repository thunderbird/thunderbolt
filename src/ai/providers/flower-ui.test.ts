import { readUIMessageStream, streamText, wrapLanguageModel, type UIMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { createDefaultMiddleware } from '../middleware/default'
import { createFlowerProvider } from './flower'

/**
 * Mock Flower client that simulates streaming responses
 */
const createMockFlowerClient = (chunks: string[], options?: { includeThinkTags?: boolean }) => {
  let capturedArgs: any = null

  const responseChunks = options?.includeThinkTags
    ? [
        '<think>\n',
        'Let me think about this request.\n',
        'I should provide a helpful response.\n',
        '</think>\n\n',
        ...chunks,
      ]
    : chunks

  return {
    apiKey: undefined as string | undefined,
    baseUrl: undefined as string | undefined,
    remoteHandoff: false,
    get captured() {
      return capturedArgs
    },
    async chat(args: any) {
      capturedArgs = args
      if (!args.stream) {
        return { content: responseChunks.join('') }
      }
      // Simulate streaming
      for (const chunk of responseChunks) {
        await new Promise((r) => setTimeout(r, 0))
        args.onStreamEvent?.({ chunk })
      }
    },
  }
}

/**
 * Helper to convert a Flower stream to UIMessage
 */
const streamToUIMessage = async (
  model: ReturnType<ReturnType<typeof createFlowerProvider>>,
  prompt: string,
  options?: { startWithReasoning?: boolean },
): Promise<UIMessage> => {
  const wrappedModel = wrapLanguageModel({
    model,
    middleware: createDefaultMiddleware(options?.startWithReasoning ?? false),
  })

  const result = streamText({
    model: wrappedModel,
    prompt,
  })

  // Convert to UI message stream
  const uiStream = result.toUIMessageStream({
    sendReasoning: true,
    messageMetadata: () => ({ modelId: 'flower-test' }),
  })

  // Read the full UI message
  const messageIterator = readUIMessageStream({ stream: uiStream })
  let finalMessage: UIMessage | undefined
  for await (const msg of messageIterator) {
    finalMessage = msg
  }

  if (!finalMessage) {
    throw new Error('No UIMessage produced from Flower stream')
  }

  return finalMessage
}

describe('Flower provider UI message conversion', () => {
  it('produces correct UIMessage for plain text response', async () => {
    const chunks = ['Hello', ' ', 'world', '!']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Say hello')

    // Verify the UI message structure
    expect(uiMessage.role).toBe('assistant')
    expect(uiMessage.metadata?.modelId).toBe('flower-test')

    // Check the text in parts
    if (Array.isArray(uiMessage.parts)) {
      const textPart = uiMessage.parts.find((p: any) => p.type === 'text')
      expect(textPart).toBeDefined()
      expect(textPart?.text).toBe('Hello world!')
    } else {
      // Fallback to content if parts is not an array
      expect(uiMessage.content).toBe('Hello world!')
    }
  })

  it('produces correct UIMessage with reasoning (think tags)', async () => {
    const chunks = ['The answer is ', '42', '.']
    const mockClient = createMockFlowerClient(chunks, { includeThinkTags: true })

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'What is the answer?')

    // Verify the UI message structure
    expect(uiMessage.role).toBe('assistant')

    // Check for reasoning and text parts
    if (Array.isArray(uiMessage.parts)) {
      const reasoningPart = uiMessage.parts.find((p: any) => p.type === 'reasoning')
      expect(reasoningPart).toBeDefined()
      expect(reasoningPart?.text || reasoningPart?.content).toContain('Let me think about this request')
      expect(reasoningPart?.text || reasoningPart?.content).toContain('I should provide a helpful response')

      const textPart = uiMessage.parts.find((p: any) => p.type === 'text')
      expect(textPart).toBeDefined()
      const textContent = (textPart?.text || textPart?.content || '').trim()
      expect(textContent).toBe('The answer is 42.')
    }
  })

  it('handles empty responses gracefully', async () => {
    const mockClient = createMockFlowerClient([])

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Empty test')

    expect(uiMessage.role).toBe('assistant')

    // Check for empty content
    if (Array.isArray(uiMessage.parts)) {
      const textParts = uiMessage.parts.filter((p: any) => p.type === 'text')
      if (textParts.length > 0) {
        expect(textParts[0]?.text || '').toBe('')
      }
    } else {
      expect(uiMessage.content || '').toBe('')
    }
  })

  it('correctly sets API key and base URL', async () => {
    const chunks = ['Test']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'my-api-key-123',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')

    // Trigger a stream to configure the client
    const result = streamText({
      model,
      prompt: 'Test',
    })

    // Consume the stream to trigger configuration
    await result.consumeStream()

    // Verify the client was configured correctly
    expect(mockClient.apiKey).toBe('my-api-key-123')
    // baseUrl is now set on the FlowerIntelligence class, not the instance
    expect(mockClient.remoteHandoff).toBe(true) // Changed to true for cloud processing
    expect(mockClient.captured.forceRemote).toBe(true)
  })

  it('produces streaming parts in correct order', async () => {
    const chunks = ['First', ' part', ', second', ' part', '.']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const wrappedModel = wrapLanguageModel({
      model,
      middleware: createDefaultMiddleware(false),
    })

    const result = streamText({
      model: wrappedModel,
      prompt: 'Stream test',
    })

    // Collect all text chunks
    const textChunks: string[] = []
    for await (const chunk of result.textStream) {
      textChunks.push(chunk)
    }

    // Verify we got all chunks in order
    expect(textChunks).toEqual(chunks)

    // Verify final text
    const finalText = await result.text
    expect(finalText).toBe('First part, second part.')
  })

  it('handles multi-line responses with proper formatting', async () => {
    const chunks = ['## Heading\n\n', 'This is a paragraph.\n', '\n', '- Item 1\n', '- Item 2\n', '\n', '**Bold text**']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Format test')

    // Check the formatted text in parts
    if (Array.isArray(uiMessage.parts)) {
      const textPart = uiMessage.parts.find((p: any) => p.type === 'text')
      expect(textPart).toBeDefined()
      const text = textPart?.text || ''
      expect(text).toContain('## Heading')
      expect(text).toContain('- Item 1')
      expect(text).toContain('**Bold text**')
    } else {
      const content = uiMessage.content || ''
      expect(content).toContain('## Heading')
      expect(content).toContain('- Item 1')
      expect(content).toContain('**Bold text**')
    }
  })

  it('works with startWithReasoning option', async () => {
    const chunks = ['Final answer.']
    const mockClient = createMockFlowerClient(chunks, { includeThinkTags: true })

    const provider = createFlowerProvider({
      getFlowerClient: async () => mockClient,
      getApiKey: async () => 'test-key',
      getBaseUrl: async () => 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Reasoning test', {
      startWithReasoning: true,
    })

    // With startWithReasoning, we should still get reasoning parts
    if (Array.isArray(uiMessage.parts)) {
      const reasoningPart = uiMessage.parts.find((p: any) => p.type === 'reasoning')
      expect(reasoningPart).toBeDefined()
    }
  })
})
