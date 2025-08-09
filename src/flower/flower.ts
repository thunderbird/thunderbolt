import {
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2Content,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
} from '@ai-sdk/provider'

type FlowerMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type FlowerChatArgs = {
  messages: FlowerMessage[]
  model: string
  stream?: boolean
  tools?: unknown
  forceRemote?: boolean
  encrypt?: boolean
  onStreamEvent?: (event: { chunk?: string }) => void
}

type FlowerClient = {
  apiKey?: string
  baseUrl?: string
  remoteHandoff?: boolean
  chat: (args: FlowerChatArgs) => Promise<{ content?: string } | void>
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

  private convertToolsToFlowerFormat(tools: Record<string, any> | undefined): unknown {
    if (!tools || Object.keys(tools).length === 0) {
      return undefined
    }

    // Convert AI SDK tools format to OpenAI-compatible format that Flower expects
    const flowerTools = Object.entries(tools).map(([name, tool]) => ({
      type: 'function',
      function: {
        name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {}, required: [] },
      },
    }))

    return flowerTools
  }

  private async streamWithFlower(options: LanguageModelV2CallOptions) {
    const warnings: any[] = []
    const client = this.options.client
    const messages = this.convertPromptToFlowerMessages(options.prompt)
    const modelId = this.modelId
    const encrypt = this.options.encrypt

    // Convert tools to Flower-compatible format
    const flowerTools = this.convertToolsToFlowerFormat(options.tools as Record<string, any> | undefined)

    // Generate a unique ID for this stream
    const streamId = `flower-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        let finished = false
        let hasStarted = false

        // Start the chat asynchronously
        const chatArgs: any = {
          messages,
          model: modelId,
          stream: true,
          forceRemote: true,
          encrypt,
          onStreamEvent: (event: any) => {
            // According to Flower docs, StreamEvent has a 'chunk' property for text
            // and optionally a 'toolCall' property for tool calls
            if (event?.chunk !== undefined && !finished) {
              const textChunk = event.chunk

              try {
                // Send text-start on the first chunk
                if (!hasStarted) {
                  hasStarted = true
                  controller.enqueue({
                    type: 'text-start',
                    id: streamId,
                  } as LanguageModelV2StreamPart)
                }

                // Send the text delta
                controller.enqueue({
                  type: 'text-delta',
                  id: streamId,
                  delta: textChunk,
                } as LanguageModelV2StreamPart)
              } catch (e) {
                console.error('error sending text chunk', e)
                // Stream might be closed
                finished = true
              }
            }

            // Handle tool calls if present
            if (event?.toolCall && !finished) {
              // TODO: Handle tool calls when needed
            }
          },
        }

        // Add tools if available
        if (flowerTools) {
          chatArgs.tools = flowerTools
        }

        const chatPromise = client.chat(chatArgs)

        // Handle completion and errors
        chatPromise
          .then((_result) => {
            if (!finished) {
              finished = true
              try {
                // Send text-end if we started
                if (hasStarted) {
                  controller.enqueue({
                    type: 'text-end',
                    id: streamId,
                  } as LanguageModelV2StreamPart)
                } else {
                  // If we never started, send an empty response
                  controller.enqueue({
                    type: 'text-start',
                    id: streamId,
                  } as LanguageModelV2StreamPart)
                  controller.enqueue({
                    type: 'text-end',
                    id: streamId,
                  } as LanguageModelV2StreamPart)
                }

                // Send finish event
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: undefined,
                    outputTokens: undefined,
                    totalTokens: undefined,
                  },
                } as LanguageModelV2StreamPart)
                controller.close()
              } catch (e) {
                console.error('error sending text chunk', e)
                // Stream might already be closed
              }
            }
          })
          .catch((err) => {
            if (!finished) {
              finished = true
              try {
                controller.error(err)
              } catch (e) {
                console.error('error sending text chunk', e)
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

  async doGenerate(options: LanguageModelV2CallOptions): Promise<any> {
    const { stream, warnings } = await this.streamWithFlower(options)
    const reader = stream.getReader()
    const content: LanguageModelV2Content[] = []
    let textOut = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const part: any = value
      if (part?.type === 'text-delta') textOut += part.delta
    }

    if (textOut) content.push({ type: 'text', text: textOut })

    return {
      content,
      finishReason: 'stop',
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
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

export type { FlowerChatArgs, FlowerClient, FlowerMessage, FlowerProviderOptions }
