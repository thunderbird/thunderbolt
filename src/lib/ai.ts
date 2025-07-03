import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { Model, SaveMessagesFunction } from '@/types'
import { createFireworks } from '@ai-sdk/fireworks'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createTogetherAI } from '@ai-sdk/togetherai'

import {
  convertToModelMessages,
  experimental_createMCPClient,
  extractReasoningMiddleware,
  LanguageModel,
  streamText,
  ToolInvocation,
  UIMessage,
  wrapLanguageModel,
  type ToolSet,
} from 'ai'
import { eq } from 'drizzle-orm'
import { getCloudUrl } from './config'
import { handleFlowerChatStream } from './flower'
import { createToolset, getAvailableTools } from './tools'

export type ToolInvocationWithResult<T = object> = ToolInvocation & {
  result: T
}

export type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>

type PromptParams = {
  preferredName: string
  location: {
    name?: string
    lat?: number
    lng?: number
  }
}

const createPrompt = ({ preferredName, location }: PromptParams) => {
  const prompt = [
    // —— Context ——
    `You are a helpful executive assistant.`,
    `The current date and time is ${new Date().toISOString()}.`,
    preferredName ? `The user's name is ${preferredName}.` : '',
    location.name
      ? `The user's location is ${location.name}${location.lat && location.lng ? ` (${location.lat}, ${location.lng})` : ''}.`
      : 'The user has not provided a location. Please ask the user for their location before using any location-based tools.',
    location.name
      ? `You must use units that are appropriate for the user's country based on the task at hand. If tools give you results in the wrong units, you must convert them. For example, if the user's location is in the United States, use miles and Fahrenheit and miles per hour. If the user's location is in Canada, use kilometers, Celsius and kilometers per hour.`
      : '',

    // —— Live-data discipline ——
    `❖ You MAY have access to tools that give you access to real-time or external data.`,
    `❖ Whenever the user asks for information that depends on real-time or external data, you MUST attempt to call an appropriate tool.`,
    `❖ If the user asks for information that you do not have access to, be honest and say so.`,
    `❖ Do not talk about your tools or mention tool names unless the user asks.`,
    `❖ Many questions about topics like news, current events, etc can be answered with the search tool if there is not a more specific tool that can be used.`,

    // —— Self-consistency check ——
    `Before sending your final reply, silently ask yourself:`,
    `"Did I *successfully* call a tool to obtain every live fact I'm about to state?"`,
    `If the answer is "no", refuse as instructed above.`,
    `Is the message that I'm about to send to the user actually useful for a human or do I need to call more tools to make it useful?`,

    // —— Style guide ——
    `Respond in Markdown that is pleasant, concise, and helpful. Use subheaders, bullet points, and bold / italics to help structure the response. Use emojis where appropriate.`,
    `Never invent information unless the user explicitly requests creative fiction.`,
  ]

  return prompt.filter(Boolean).join('\n')
}

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
})

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  saveMessages: SaveMessagesFunction
  model: Model
  mcpClients?: MCPClient[]
}

export const createModel = async (modelConfig: Model): Promise<LanguageModel> => {
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      // Use centralized config function
      const cloudUrl = await getCloudUrl()

      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: `${cloudUrl}/openai`,
      })
      return openaiCompatible(modelConfig.model) as LanguageModel
    }
    case 'openai': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
      })
      const model = openai(modelConfig.model)

      return model
    }
    case 'fireworks': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const fireworks = createFireworks({
        apiKey: modelConfig.apiKey,
      })

      const model = fireworks(modelConfig.model)

      return model as LanguageModel
    }
    case 'openai_compatible': {
      if (!modelConfig.url) {
        throw new Error('No URL provided for OpenAI Compatible provider')
      }

      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: modelConfig.url,
        apiKey: modelConfig.apiKey || undefined,
      })

      return openaiCompatible(modelConfig.model) as LanguageModel
    }
    case 'together': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const together = createTogetherAI({
        apiKey: modelConfig.apiKey,
      })

      const model = together(modelConfig.model)

      return model as LanguageModel
    }
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export const aiFetchStreamingResponse = async ({
  init,
  saveMessages,
  model: modelConfig,
  mcpClients,
}: AiFetchStreamingResponseOptions) => {
  try {
    const options = init as RequestInit & { body: string }
    const body = JSON.parse(options.body)

    const { messages, chatId } = body as { messages: UIMessage[]; chatId: string }

    await saveMessages({
      id: chatId,
      messages,
    })

    console.log('Using model', modelConfig.provider, modelConfig.model)

    const db = DatabaseSingleton.instance.db

    const locationNameResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name')).get()
    const locationLatResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat')).get()
    const locationLngResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng')).get()
    const preferredNameResult = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, 'preferred_name'))
      .get()

    // Check if model supports tool usage (default to true for backward compatibility)
    const supportsTools = modelConfig.toolUsage !== 0

    // Build toolset only if model supports tools
    let toolset: ToolSet = {}

    if (supportsTools) {
      const availableTools = await getAvailableTools()
      toolset = {
        ...createToolset(availableTools),
      }

      // Add MCP tools if persistent client is available
      if (mcpClients && mcpClients.length > 0) {
        try {
          // Collect tools from all enabled MCP clients
          for (const mcpClient of mcpClients) {
            const mcpTools = await mcpClient.tools()
            Object.assign(toolset, mcpTools)
          }
          console.log(`MCP tools loaded successfully from ${mcpClients.length} clients`)
        } catch (error) {
          console.error('Failed to load MCP tools:', error)
        }
      } else {
        console.warn('No MCP clients available, MCP tools will not be included')
      }
    } else {
      console.log('Model does not support tools, skipping tool setup')
    }

    // Add system prompt as first message if not already present
    const systemPrompt = createPrompt({
      preferredName: preferredNameResult?.value as string,
      location: {
        name: locationNameResult?.value as string,
        lat: locationLatResult?.value
          ? typeof locationLatResult.value === 'number'
            ? locationLatResult.value
            : parseFloat(locationLatResult.value as string)
          : undefined,
        lng: locationLngResult?.value
          ? typeof locationLngResult.value === 'number'
            ? locationLngResult.value
            : parseFloat(locationLngResult.value as string)
          : undefined,
      },
    })

    // Flower is a special case that uses a custom SDK that is not compatible with the Vercel AI SDK.
    if (modelConfig.provider === 'flower') {
      const tools = modelConfig.toolUsage === 1 ? await getAvailableTools() : undefined
      return handleFlowerChatStream({
        messages,
        systemPrompt,
        model: modelConfig.model,
        tools,
      })
    }

    const baseModel = await createModel(modelConfig)

    const wrappedModel = wrapLanguageModel({
      model: baseModel,
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })

    const model = wrappedModel

    const result = streamText({
      model,
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      toolCallStreaming: supportsTools,
      tools: supportsTools ? toolset : undefined,
      maxSteps: 10,
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
    })
  } catch (error) {
    console.error('Error in aiFetchStreamingResponse:', error)
    throw error
  }
}
