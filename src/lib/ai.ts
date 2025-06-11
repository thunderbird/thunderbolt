import { getDrizzleDatabase } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { Model, SaveMessagesFunction } from '@/types'
import { createFireworks } from '@ai-sdk/fireworks'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { convertToModelMessages, experimental_createMCPClient, extractReasoningMiddleware, LanguageModel, streamText, ToolInvocation, UIMessage, wrapLanguageModel, type ToolSet } from 'ai'
import { eq } from 'drizzle-orm'
import { createFlower, isFlowerModel } from './ai-providers/flower'
import { getCloudUrl } from './config'
import { createToolset, tools } from './tools'

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
    location.name ? `The user's location is ${location.name}${location.lat && location.lng ? ` (${location.lat}, ${location.lng})` : ''}.` : '',

    // —— Live-data discipline ——
    `❖ You MIGHT have access to tools that give you access to real-time or external data. They also might be disabled.`,
    `❖ Whenever the user asks for information that depends on real-time or external data, you MUST attempt to call an appropriate tool.`,
    `❖ If the call fails, or the tool is unavailable, you MUST refuse with exactly:`,
    `   "I'm sorry — I don't have live access to **{topic}** right now."`,
    `❖ Under no circumstances should you fabricate the missing data.`,

    // —— Self-consistency check ——
    `Before sending your final reply, silently ask yourself:`,
    `"Did I *successfully* call a tool to obtain every live fact I'm about to state?"`,
    `If the answer is "no", refuse as instructed above.`,

    // —— Style guide ——
    `Respond in plain text or Markdown.  Do not reveal tool names, JSON, or internal reasoning.`,
    `Be concise, friendly, and helpful.`,
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
    case 'flower': {
      // Use our custom Flower provider for true E2E encryption
      if (isFlowerModel(modelConfig.model)) {
        const flower = createFlower({
          encrypt: modelConfig.isConfidential ? true : false,
        })
        return flower(modelConfig.model) as LanguageModel
      } else {
        // Fallback to OpenAI compatible for unknown models
        const { db } = await getDrizzleDatabase()
        const cloudUrlSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url')).get()
        const cloudUrl = (cloudUrlSetting?.value as string) || 'http://localhost:8000'

        const openaiCompatible = createOpenAICompatible({
          name: 'flower',
          baseURL: `${cloudUrl}/flower`,
          apiKey: 'dynamic', // API key will be handled by the backend
        })
        return openaiCompatible(modelConfig.model) as LanguageModel
      }
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
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export const aiFetchStreamingResponse = async ({ init, saveMessages, model: modelConfig, mcpClients }: AiFetchStreamingResponseOptions) => {
  try {
    const baseModel = await createModel(modelConfig)

    const wrappedModel = wrapLanguageModel({
      model: baseModel as any, // @todo seems like Vercel AI SDK is not typed correctly
      middleware: extractReasoningMiddleware({ tagName: 'think' }),
    })

    const model = wrappedModel

    const options = init as RequestInit & { body: string }
    const body = JSON.parse(options.body)

    const { messages, chatId } = body as { messages: UIMessage[]; chatId: string }

    await saveMessages({
      id: chatId,
      messages,
    })

    console.log('Using model', modelConfig.provider, modelConfig.model)

    const { db } = await getDrizzleDatabase()

    const locationNameResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name')).get()
    const locationLatResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat')).get()
    const locationLngResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng')).get()
    const preferredNameResult = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name')).get()

    // Check if model supports tool usage (default to true for backward compatibility)
    const supportsTools = modelConfig.toolUsage !== 0

    // Build toolset only if model supports tools
    let toolset: ToolSet = {}

    if (supportsTools) {
      toolset = {
        ...createToolset(tools),
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

    const result = streamText({
      model,
      system: createPrompt({
        preferredName: preferredNameResult?.value as string,
        location: {
          name: locationNameResult?.value as string,
          lat: parseFloat(locationLatResult?.value as string),
          lng: parseFloat(locationLngResult?.value as string),
        },
      }),
      messages: convertToModelMessages(messages),
      toolCallStreaming: supportsTools,
      tools: supportsTools ? toolset : undefined,
      // continueUntil: hasToolCall('answer'),
      // continueUntil: maxSteps(5),
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
