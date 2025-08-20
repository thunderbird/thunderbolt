import { readUIMessageStream, streamText, wrapLanguageModel, type UIMessage } from 'ai'
import { describe, expect, it } from 'bun:test'
import { createDefaultMiddleware, createFlowerMiddleware } from '@/src/ai/middleware/default'
import { createFlowerProvider, type FlowerChatArgs, type FlowerClient } from './flower'

type MockFlowerClient = FlowerClient & {
  captured: FlowerChatArgs | null
}

/**
 * Mock Flower client that simulates streaming responses
 */
const createMockFlowerClient = (chunks: string[], options?: { includeThinkTags?: boolean }): MockFlowerClient => {
  let capturedArgs: FlowerChatArgs | null = null

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
    apiKey: undefined,
    baseUrl: undefined,
    remoteHandoff: false,
    get captured() {
      return capturedArgs
    },
    async chat(args: FlowerChatArgs) {
      capturedArgs = args
      if (!args.stream) {
        return { content: responseChunks.join('') }
      }
      // Simulate streaming
      for (const chunk of responseChunks) {
        await new Promise<void>((r) => setTimeout(r, 0))
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
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Say hello')

    // Verify the UI message structure
    expect(uiMessage.role).toBe('assistant')
    expect((uiMessage.metadata as { modelId?: string })?.modelId).toBe('flower-test')

    // Check the text in parts
    const textPart = uiMessage.parts.find((p) => p.type === 'text')
    expect(textPart).toBeDefined()
    expect((textPart as { type: string; text?: string })?.text).toBe('Hello world!')
  })

  it('produces correct UIMessage with reasoning (think tags)', async () => {
    const chunks = ['The answer is ', '42', '.']
    const mockClient = createMockFlowerClient(chunks, { includeThinkTags: true })

    const provider = createFlowerProvider({
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'What is the answer?')

    // Verify the UI message structure
    expect(uiMessage.role).toBe('assistant')

    // Check for reasoning and text parts
    if (Array.isArray(uiMessage.parts)) {
      const reasoningPart = uiMessage.parts.find((p) => p.type === 'reasoning')
      expect(reasoningPart).toBeDefined()
      expect((reasoningPart as { type: string; text?: string })?.text).toContain('Let me think about this request')
      expect((reasoningPart as { type: string; text?: string })?.text).toContain('I should provide a helpful response')

      const textPart = uiMessage.parts.find((p) => p.type === 'text')
      expect(textPart).toBeDefined()
      const textContent = ((textPart as { type: string; text?: string })?.text || '').trim()
      expect(textContent).toBe('The answer is 42.')
    }
  })

  it('handles empty responses gracefully', async () => {
    const mockClient = createMockFlowerClient([])

    const provider = createFlowerProvider({
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Empty test')

    expect(uiMessage.role).toBe('assistant')

    // Check for empty content
    const textParts = uiMessage.parts.filter((p) => p.type === 'text')
    if (textParts.length > 0) {
      expect((textParts[0] as { type: string; text?: string })?.text || '').toBe('')
    }
  })

  it('correctly sets API key and base URL', async () => {
    const chunks = ['Test']
    const mockClient = createMockFlowerClient(chunks)

    // Pre-configure the mock client (simulating what createConfiguredFlowerClient would do)
    mockClient.apiKey = 'my-api-key-123'
    mockClient.baseUrl = 'http://localhost:8000/flower/v1' 
    mockClient.remoteHandoff = true

    const provider = createFlowerProvider({
      client: mockClient,
      encrypt: false,
    })

    const model = provider('qwen/qwen3-235b')

    // Trigger a stream to configure the client
    const result = streamText({
      model,
      prompt: 'Test',
    })

    // Consume the stream to trigger configuration
    await result.consumeStream()

    // Verify the pre-configured client values are maintained
    expect(mockClient.apiKey).toBe('my-api-key-123')
    expect(mockClient.baseUrl).toBe('http://localhost:8000/flower/v1')
    expect(mockClient.remoteHandoff).toBe(true)
    expect(mockClient.captured?.forceRemote).toBe(true)
  })

  it('produces streaming parts in correct order', async () => {
    const chunks = ['First', ' part', ', second', ' part', '.']
    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
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
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Format test')

    // Check the formatted text in parts
    const textPart = uiMessage.parts.find((p) => p.type === 'text')
    expect(textPart).toBeDefined()
    const text = (textPart as { type: string; text?: string })?.text || ''
    expect(text).toContain('## Heading')
    expect(text).toContain('- Item 1')
    expect(text).toContain('**Bold text**')
  })

  it('works with startWithReasoning option', async () => {
    const chunks = ['Final answer.']
    const mockClient = createMockFlowerClient(chunks, { includeThinkTags: true })

    const provider = createFlowerProvider({
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')
    const uiMessage = await streamToUIMessage(model, 'Reasoning test', {
      startWithReasoning: true,
    })

    // With startWithReasoning, we should still get reasoning parts
    if (Array.isArray(uiMessage.parts)) {
      const reasoningPart = uiMessage.parts.find((p) => p.type === 'reasoning')
      expect(reasoningPart).toBeDefined()
    }
  })

  it('does not crash with Hermes middleware and SSE-like empty chunks', async () => {
    // This sequence simulates the SSE stream reported in the issue, including empty-string deltas
    const chunks = [
      '',
      'Hi',
      ' Chris',
      '!',
      ' ',
      '',
      '\u0669',
      '(',
      '\u25d5',
      '\u203f',
      '\u25d5',
      '\uff61',
      ')',
      '',
      '\u06f6',
      ' How',
      ' can',
      ' I',
      ' assist',
      ' you',
      ' today',
      '?',
      '',
    ]

    const mockClient = createMockFlowerClient(chunks)

    const provider = createFlowerProvider({
      client: mockClient,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8000/flower/v1',
    })

    const model = provider('qwen/qwen3-235b')

    const wrappedModel = wrapLanguageModel({
      model,
      middleware: createFlowerMiddleware(false),
    })

    // Convert to UI message stream
    const result = streamText({
      model: wrappedModel,
      prompt: 'Say hello',
    })

    const uiStream = result.toUIMessageStream({
      sendReasoning: true,
      messageMetadata: () => ({ modelId: 'flower-test' }),
    })

    // Read the final UI message and ensure it contains the full text without throwing
    const iterator = readUIMessageStream({ stream: uiStream })
    let finalMessage: UIMessage | undefined
    for await (const msg of iterator) {
      finalMessage = msg
    }

    expect(finalMessage).toBeDefined()
    const textPart = finalMessage!.parts.find((p) => p.type === 'text') as { type: string; text?: string }
    const text = (textPart?.text || '').trim()
    expect(text).toContain('Hi Chris!')
    expect(text).toContain('How can I assist you today?')
  })
})
