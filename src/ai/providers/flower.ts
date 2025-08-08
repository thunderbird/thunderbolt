import { getCloudUrl } from '@/lib/config'
import {
  type LanguageModelV2,
  type LanguageModelV2CallOptions,
  type LanguageModelV2Content,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
} from '@ai-sdk/provider'
import ky from 'ky'

type FlowerMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type FlowerClient = {
  apiKey?: string
  baseUrl?: string
  remoteHandoff?: boolean
  chat: (args: {
    messages: FlowerMessage[]
    model: string
    stream?: boolean
    tools?: unknown
    forceRemote?: boolean
    encrypt?: boolean
    onStreamEvent?: (event: { chunk?: string }) => void
  }) => Promise<{ content?: string } | void>
}

type FlowerProviderOptions = {
  getFlowerClient?: () => Promise<FlowerClient>
  getApiKey?: () => Promise<string | undefined>
  getBaseUrl?: () => Promise<string>
  encrypt?: boolean
}

const defaultGetBaseUrl = async (): Promise<string> => {
  // Use backend proxy to avoid CORS issues
  // Backend /flower endpoint forwards to https://api.flower.ai
  const cloudUrl = await getCloudUrl()
  return `${cloudUrl}/flower/v1`
}

const defaultGetApiKey = async (): Promise<string | undefined> => {
  const cloudUrl = await getCloudUrl()
  const response = await ky.post(`${cloudUrl}/flower/api-key`, { json: {} })
  const data = await response.json<{ api_key: string }>()
  return data.api_key
}

const getDefaultFlowerClient = async (): Promise<FlowerClient> => {
  const { FlowerIntelligence } = await import('@flwr/flwr')

  // Configure the SDK to use our backend proxy
  // The @flwr/flwr package has been patched to support custom base URLs
  const cloudUrl = await getCloudUrl()
  const baseUrl = `${cloudUrl}/flower`

  // Set the base URL statically on the class (requires our patch)
  if ('baseUrl' in FlowerIntelligence) {
    ;(FlowerIntelligence as any).baseUrl = baseUrl
  } else {
    console.warn('[Flower] SDK patch not applied - API calls will go directly to api.flower.ai')
    console.warn('[Flower] Run: patch -p0 < patches/@flwr+flwr+0.1.13.patch')
  }

  const instance = FlowerIntelligence.instance
  return instance as unknown as FlowerClient
}

class FlowerLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2'
  readonly provider = 'flower'
  readonly modelId: string

  constructor(
    modelId: string,
    private readonly options: Required<FlowerProviderOptions>,
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
          .map((p) => (p && (p as any).type === 'text' ? (p as any).text : ''))
          .join('')
          .trim()
        messages.push({ role: msg.role, content: text })
        continue
      }

      // Ignore tool role when translating to Flower; tool results are embedded by AI SDK middleware via text
    }
    return messages
  }

  private async configureClient(): Promise<FlowerClient> {
    const client = await this.options.getFlowerClient()
    const apiKey = await this.options.getApiKey()

    if (apiKey) {
      client.apiKey = apiKey
    }

    // Enable remote handoff for cloud-based processing
    // This is important for the SDK to actually send requests
    client.remoteHandoff = true

    // Note: The Flower SDK has api.flower.ai hardcoded, so we intercept fetch
    // in getDefaultFlowerClient to redirect to our backend proxy

    return client
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
    const client = await this.configureClient()
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

export const createFlowerProvider = (providerOptions: FlowerProviderOptions = {}) => {
  const options = {
    getFlowerClient: providerOptions.getFlowerClient ?? getDefaultFlowerClient,
    getApiKey: providerOptions.getApiKey ?? defaultGetApiKey,
    getBaseUrl: providerOptions.getBaseUrl ?? defaultGetBaseUrl,
    encrypt: providerOptions.encrypt ?? false,
  } as Required<FlowerProviderOptions>

  return (modelId: string): LanguageModelV2 => new FlowerLanguageModel(modelId, options)
}

export type { FlowerProviderOptions }

// Expose API key helper to reuse in OpenAI-compatible path
export const getFlowerApiKey = defaultGetApiKey
