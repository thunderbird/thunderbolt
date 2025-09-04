import { createPrompt } from '@/ai/prompt'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import { getCloudUrl } from '@/lib/config'
import { getBooleanSetting, getSetting } from '@/lib/dal'
import { fetch } from '@/lib/fetch'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2 } from '@ai-sdk/provider'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import { createFlowerProvider } from '@/flower'
import {
  convertToModelMessages,
  type experimental_createMCPClient,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type ToolSet,
} from 'ai'
import { eq } from 'drizzle-orm'
import { createConfiguredFlowerClient } from './flower'
import { createDefaultMiddleware, createFlowerMiddleware } from './middleware/default'

export type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
  fetch,
})

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  saveMessages: SaveMessagesFunction
  modelId: string
  mcpClients?: MCPClient[]
}

export const createModel = async (modelConfig: Model): Promise<LanguageModelV2> => {
  switch (modelConfig.provider) {
    case 'flower': {
      // Check if encryption should be disabled via dev settings
      const disableEncryption = await getBooleanSetting('disable_flower_encryption', false)

      // Enable encryption for confidential models unless explicitly disabled in dev settings
      const shouldEncrypt = Boolean(modelConfig.isConfidential) && !disableEncryption

      const cloudUrl = await getCloudUrl()
      const client = await createConfiguredFlowerClient(cloudUrl)

      const provider = createFlowerProvider({
        client,
        encrypt: shouldEncrypt,
      })

      return provider(modelConfig.model)
    }
    case 'thunderbolt': {
      const cloudUrl = await getCloudUrl()
      const openaiCompatible = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL: `${cloudUrl}/openai`,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openai': {
      if (!modelConfig.apiKey) throw new Error('No API key provided')
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
        fetch,
      })
      return openai(modelConfig.model)
    }
    case 'custom': {
      if (!modelConfig.url) throw new Error('No URL provided for custom provider')
      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: modelConfig.url,
        apiKey: modelConfig.apiKey || undefined,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openrouter': {
      if (!modelConfig.apiKey) throw new Error('No API key provided')
      // Using OpenAI-compatible approach until @openrouter/ai-sdk-provider supports Vercel AI SDK v5
      // https://github.com/OpenRouterTeam/ai-sdk-provider/pull/77
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: modelConfig.apiKey,
        fetch,
      })
      return openrouter(modelConfig.model)
    }
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export const aiFetchStreamingResponse = async ({
  init,
  saveMessages,
  modelId,
  mcpClients,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined

  const { messages, chatId } = body as { messages: ThunderboltUIMessage[]; chatId: string }

  await saveMessages({ id: chatId, messages })

  const db = DatabaseSingleton.instance.db

  const locationName = await getSetting<string>('location_name')
  const locationLat = await getSetting<string>('location_lat')
  const locationLng = await getSetting<string>('location_lng')
  const preferredName = await getSetting<string>('preferred_name')

  const model = await db.query.modelsTable.findFirst({
    where: eq(modelsTable.id, modelId),
  })

  if (!model) throw new Error('Model not found')

  const supportsTools = model.toolUsage !== 0

  let toolset: ToolSet = {}
  if (supportsTools) {
    const availableTools = await getAvailableTools()
    toolset = { ...createToolset(availableTools) }

    for (const mcpClient of mcpClients || []) {
      const mcpTools = await mcpClient.tools()
      Object.assign(toolset, mcpTools)
    }
  } else {
    console.log('Model does not support tools, skipping tool setup')
  }

  const systemPrompt = createPrompt({
    preferredName: preferredName as string,
    location: {
      name: locationName as string,
      lat: locationLat ? parseFloat(locationLat as string) : undefined,
      lng: locationLng ? parseFloat(locationLng as string) : undefined,
    },
  })

  try {
    const baseModel = await createModel(model)

    // Use Flower-specific middleware for the Flower provider to enable enhanced tool support
    // Other providers already have native function calling support
    const middleware =
      model.provider === 'flower'
        ? createFlowerMiddleware(Boolean(model.startWithReasoning))
        : createDefaultMiddleware(Boolean(model.startWithReasoning))

    const wrappedModel = wrapLanguageModel({
      providerId: model.provider,
      model: baseModel,
      middleware,
    })

    const result = streamText({
      temperature: 0.25,
      model: wrappedModel,
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      tools: supportsTools ? toolset : undefined,
      stopWhen: stepCountIs(20),
      abortSignal,
      // providerOptions: {
      //   custom: {
      //     // reasoningEffort: 'low',
      //   } satisfies OpenAICompatibleProviderOptions,
      // },
      onStepFinish: (step) => {
        if (process.env.NODE_ENV === 'test') return

        console.log('step', {
          text: step.text,
          finishReason: step.finishReason,
          toolCallCount: step.toolCalls?.length || 0,
        })

        // When a step includes tool calls, log their names and arguments for easier debugging
        step.toolCalls?.forEach((call, idx) => {
          console.groupCollapsed(`Tool call #${idx + 1}: ${call.toolName}`)
          console.log('Arguments:', call.input)
          console.groupEnd()
        })
      },
      onFinish: async (finish) => {
        if (process.env.NODE_ENV === 'test') return

        console.log('finish', {
          text: finish.text,
          finishReason: finish.finishReason,
          toolCallCount: finish.toolCalls?.length || 0,
          usage: finish.totalUsage,
        })
      },
      onError: (error) => {
        console.error('error', error)
      },
      onChunk: () => {
        // console.log('chunk')
      },
    })

    return result.toUIMessageStreamResponse<ThunderboltUIMessage>({
      sendReasoning: true,
      messageMetadata: ({ part }) => {
        switch (part.type) {
          case 'finish-step':
            return {
              modelId,
              usage: part.usage,
            }
          case 'finish':
            return {
              modelId,
              // If you wanted to get the total usage for the entire conversation, you could do this:
              // usage: part.totalUsage,
            }
          default:
            return {
              modelId,
            }
        }
      },
    })
  } catch (error) {
    console.error('aiFetchStreamingResponse error', error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
