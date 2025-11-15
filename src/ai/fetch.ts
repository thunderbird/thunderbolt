import { createPrompt } from '@/ai/prompt'
import { getSettings } from '@/dal'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import { isTestEnv } from '@/lib/env'
import { fetch } from '@/lib/fetch'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2 } from '@ai-sdk/provider'
import ky, { type KyInstance } from 'ky'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import {
  convertToModelMessages,
  extractReasoningMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type experimental_createMCPClient,
  type ToolSet,
} from 'ai'
import { eq } from 'drizzle-orm'

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
  httpClient?: KyInstance
}

export const createModel = async (modelConfig: Model): Promise<LanguageModelV2> => {
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
      const openaiCompatible = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL: cloudUrl,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: modelConfig.apiKey || '',
        fetch,
        headers: {
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      })
      return anthropic(modelConfig.model)
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
  httpClient,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined
  const { messages, id } = body as { messages: ThunderboltUIMessage[]; id: string }

  await saveMessages({ id, messages })

  const db = DatabaseSingleton.instance.db

  // Fetch all settings in a single query (returns camelCase by default)
  const settings = await getSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
  })

  const model = await db.query.modelsTable.findFirst({
    where: eq(modelsTable.id, modelId),
  })

  if (!model) throw new Error('Model not found')

  const supportsTools = model.toolUsage !== 0

  let toolset: ToolSet = {}
  if (supportsTools) {
    // Use provided httpClient for tests, otherwise use plain ky for external APIs
    const toolsHttpClient = httpClient || ky
    const availableTools = await getAvailableTools(toolsHttpClient)
    toolset = { ...createToolset(availableTools) }

    for (const mcpClient of mcpClients || []) {
      const mcpTools = await mcpClient.tools()
      Object.assign(toolset, mcpTools)
    }
  } else {
    console.log('Model does not support tools, skipping tool setup')
  }

  const systemPrompt = createPrompt({
    preferredName: settings.preferredName,
    location: {
      name: settings.locationName,
      lat: settings.locationLat ? parseFloat(settings.locationLat) : undefined,
      lng: settings.locationLng ? parseFloat(settings.locationLng) : undefined,
    },
    localization: {
      distanceUnit: settings.distanceUnit,
      temperatureUnit: settings.temperatureUnit,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      currency: settings.currency,
    },
  })

  try {
    const baseModel = await createModel(model)

    const wrappedModel = wrapLanguageModel({
      providerId: model.provider,
      model: baseModel,
      middleware: [
        extractReasoningMiddleware({
          tagName: 'think',
          startWithReasoning: Boolean(model.startWithReasoning),
        }),
      ],
    })

    const MAX_STEPS = 20

    const result = streamText({
      temperature: 0.25,
      model: wrappedModel,
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      tools: supportsTools ? toolset : undefined,
      stopWhen: stepCountIs(MAX_STEPS),

      // Guarantee the last allowed step cannot call tools
      prepareStep: ({ steps, stepNumber, messages }) => {
        if (steps.length >= MAX_STEPS - 1) {
          console.log(`Final step ${stepNumber} - telling model to wrap it up...`)
          return {
            activeTools: [],
            messages: [
              ...messages,
              {
                // You might think that "system" would make more sense, but it many providers ignore system messages in the middle of the conversation.
                role: 'user',
                content:
                  'This is the LAST STEP. You MUST reply with a final message NOW. If you have enough information to provide me with a high quality response using prior tool results, respond with your final answer. If you do not have enough information, ask if I would like you to continue.',
              },
            ],
          }
        }
      },

      abortSignal,
      // providerOptions: {
      //   custom: {
      //     // reasoningEffort: 'low',
      //   } satisfies OpenAICompatibleProviderOptions,
      // },
      onStepFinish: (step) => {
        if (isTestEnv()) return

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
        if (isTestEnv()) return

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
