import {
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type LanguageModelV2Usage,
} from '@ai-sdk/provider'

type FlowerTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: any
  }
}

type FlowerMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Usage interface from Flower AI SDK
 * @see https://flower.ai/docs/intelligence/ts-api-ref/interfaces/Usage.html
 */
type FlowerUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/**
 * StreamEvent interface from Flower AI SDK
 * Based on actual SDK: only has chunk and toolCall, NO usage data
 */
type FlowerStreamEvent = {
  chunk?: string
  toolCall?: {
    index: string
    name: string
    arguments: string | Record<string, string>
    complete: boolean
  }
}

type FlowerChatArgs = {
  messages: FlowerMessage[]
  model: string
  stream?: boolean
  tools?: unknown
  forceRemote?: boolean
  encrypt?: boolean
  onStreamEvent?: (event: FlowerStreamEvent) => void
}

type FlowerClient = {
  apiKey?: string
  baseUrl?: string
  remoteHandoff?: boolean
  chat: (
    args: FlowerChatArgs,
  ) => Promise<{ ok: true; message: { content: string }; usage?: FlowerUsage } | { ok: false; failure: any } | void>
}

type FlowerProviderOptions = {
  client: FlowerClient
  apiKey?: string
  baseUrl?: string
  encrypt?: boolean
}

class FlowerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2'
  readonly provider = 'flower'
  readonly modelId: string

  constructor(
    modelId: string,
    private readonly options: FlowerProviderOptions,
  ) {
    this.modelId = modelId
  }

  // Flower is text-only output for now; we don't advertise native URL support
  get supportedUrls() {
    return {}
  }

  private convertPromptToFlowerMessages(prompt: LanguageModelV2Prompt): FlowerMessage[] {
    const messages: FlowerMessage[] = []
    for (const msg of prompt) {
      if (msg.role === 'system') {
        messages.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : String(msg.content) })
        continue
      }

      if (msg.role === 'user' || msg.role === 'assistant') {
        const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }]
        const text = parts
          .map((p) => (p && p.type === 'text' ? p.text : ''))
          .join('')
          .trim()
        messages.push({ role: msg.role, content: text })
        continue
      }

      // Ignore tool role when translating to Flower; tool results are embedded by AI SDK middleware via text
    }
    return messages
  }

  /**
   * Converts AI SDK tools format to OpenAI-compatible format that Flower expects
   */
  private convertToolsToFlowerFormat(
    tools: Record<string, { description?: string; parameters?: any }> | undefined,
  ): FlowerTool[] | undefined {
    if (!tools || Object.keys(tools).length === 0) {
      return undefined
    }

    return Object.entries(tools).map(([name, tool]) => ({
      type: 'function' as const,
      function: {
        name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {}, required: [] },
      },
    }))
  }

  private async streamWithFlower(options: LanguageModelV2CallOptions) {
    const warnings: LanguageModelV2CallWarning[] = []
    const client = this.options.client
    const messages = this.convertPromptToFlowerMessages(options.prompt)
    const modelId = this.modelId
    const encrypt = this.options.encrypt

    // Convert tools to Flower-compatible format
    const flowerTools = this.convertToolsToFlowerFormat(
      options.tools as Record<string, { description?: string; parameters?: any }> | undefined,
    )

    // Generate a unique ID for this stream
    const streamId = `flower-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        let finished = false
        let accumulatedUsage: FlowerUsage | undefined

        // Start the chat asynchronously
        const chatArgs: FlowerChatArgs = {
          messages,
          model: modelId,
          stream: true,
          forceRemote: true,
          encrypt,
          onStreamEvent: (event: FlowerStreamEvent) => {
            // According to Flower docs, StreamEvent has a 'chunk' property for text
            // and optionally a 'toolCall' property for tool calls
            if (event?.chunk !== undefined && !finished) {
              const textChunk = event.chunk

              try {
                // Emit only text-delta events to avoid ID conflicts with middleware
                // Middleware like hermesToolMiddleware will handle text-start/text-end
                // with consistent IDs. This prevents the "textPart is undefined" error.
                controller.enqueue({
                  type: 'text-delta',
                  id: streamId,
                  delta: textChunk,
                } as LanguageModelV2StreamPart)
              } catch {
                // Stream might be closed
                finished = true
              }
            }

            // Handle tool calls if present
            if (event?.toolCall && !finished) {
              // TODO: Handle tool calls when needed
            }

            // Note: StreamEvent does NOT contain usage data according to Flower SDK
            // Usage data is only available in the final chat result
          },
        }

        // Add tools if available
        if (flowerTools) {
          chatArgs.tools = flowerTools
        }

        const chatPromise = client.chat(chatArgs)

        // Handle completion and errors
        chatPromise
          .then((result) => {
            if (!finished) {
              finished = true
              try {
                // Extract usage data from the successful chat result
                if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
                  const successResult = result as { ok: true; message: { content: string }; usage?: FlowerUsage }
                  if (successResult.usage) {
                    accumulatedUsage = successResult.usage
                  }
                }

                // Don't emit text-end - let middleware handle text boundaries
                // This prevents ID mismatches with hermesToolMiddleware

                // Send finish event with usage data from Flower
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: accumulatedUsage?.promptTokens,
                    outputTokens: accumulatedUsage?.completionTokens,
                    totalTokens: accumulatedUsage?.totalTokens,
                  },
                } as LanguageModelV2StreamPart)
                controller.close()
              } catch {
                // Stream might already be closed
              }
            }
          })
          .catch((err) => {
            if (!finished) {
              finished = true
              try {
                controller.error(err)
              } catch {
                // Stream might already be closed
              }
            }
          })
      },
    })

    return { stream, warnings }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    return this.streamWithFlower(options)
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const { stream, warnings } = await this.streamWithFlower(options)
    const reader = stream.getReader()
    const content: LanguageModelV2Content[] = []
    let textOut = ''
    let finalUsage: FlowerUsage | undefined

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      const part = value as LanguageModelV2StreamPart
      if (part?.type === 'text-delta') {
        textOut += part.delta
      }
      if (part?.type === 'finish' && part.usage) {
        finalUsage = part.usage
      }
    }

    if (textOut) content.push({ type: 'text', text: textOut })

    return {
      content,
      finishReason: 'stop' as LanguageModelV2FinishReason,
      usage: {
        inputTokens: finalUsage?.promptTokens ?? 0,
        outputTokens: finalUsage?.completionTokens ?? 0,
        totalTokens: finalUsage?.totalTokens ?? 0,
      } as LanguageModelV2Usage,
      warnings,
      request: {},
      response: {},
    }
  }
}

export const createFlowerProvider = (providerOptions: FlowerProviderOptions) => {
  return (modelId: string): LanguageModelV2 =>
    new FlowerLanguageModel(modelId, {
      client: providerOptions.client,
      apiKey: providerOptions.apiKey,
      baseUrl: providerOptions.baseUrl ?? providerOptions.client.baseUrl ?? 'https://api.flower.ai',
      encrypt: providerOptions.encrypt ?? false,
    })
}

export type { FlowerChatArgs, FlowerClient, FlowerMessage, FlowerProviderOptions, FlowerStreamEvent, FlowerUsage }
