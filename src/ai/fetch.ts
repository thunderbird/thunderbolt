import { createPrompt } from '@/ai/prompt'
import {
  extractTextFromMessages,
  hasToolCalls,
  isFinalStep,
  NUDGE_MESSAGES,
  shouldRetry,
  shouldShowPreventiveNudge,
} from '@/ai/step-logic'
import { getSettings } from '@/dal'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import { fetch } from '@/lib/fetch'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV2 } from '@ai-sdk/provider'
import ky, { type KyInstance } from 'ky'
import { v7 as uuidv7 } from 'uuid'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  extractReasoningMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type experimental_createMCPClient,
  type ToolSet,
} from 'ai'
import { eq } from 'drizzle-orm'
import { createMessageMetadata } from './message-metadata'

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
    modelName: model.name,
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

    const maxSteps = 20
    const maxAttempts = 2

    /**
     * Run a single streamText attempt and return the result along with metadata
     */
    const runStreamText = (inputMessages: ReturnType<typeof convertToModelMessages>) => {
      return streamText({
        temperature: 0.2,
        model: wrappedModel,
        system: systemPrompt,
        messages: inputMessages,
        tools: supportsTools ? toolset : undefined,
        stopWhen: stepCountIs(maxSteps),

        prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
          // Final step: disable tools to force a response
          if (isFinalStep(steps.length, maxSteps)) {
            console.info(`Final step ${stepNumber} - telling model to wrap it up...`)
            return {
              activeTools: [],
              messages: [...stepMessages, { role: 'user' as const, content: NUDGE_MESSAGES.finalStep }],
            }
          }

          // Nudge after many tool calls (but not on final step)
          if (shouldShowPreventiveNudge(steps)) {
            return {
              messages: [...stepMessages, { role: 'user' as const, content: NUDGE_MESSAGES.preventive }],
            }
          }
        },

        abortSignal,
        onStepFinish: (step) => {
          console.info('step', {
            text: step.text,
            finishReason: step.finishReason,
            toolCallCount: step.toolCalls?.length || 0,
          })

          // When a step includes tool calls, log their names and arguments for easier debugging
          step.toolCalls?.forEach((call, idx) => {
            console.groupCollapsed(`Tool call #${idx + 1}: ${call.toolName}`)
            console.log('Arguments:', call)
            console.groupEnd()
          })
        },
        onFinish: (finish) => {
          console.info('finish', {
            text: finish.text,
            finishReason: finish.finishReason,
            toolCallCount: finish.toolCalls?.length || 0,
            usage: finish.totalUsage,
          })
        },
        onError: (error) => {
          console.error('streamText error', error)
        },
      })
    }

    // Use createUIMessageStream to handle retries
    // Following the official SDK pattern for multi-step streams:
    // - First stream: sendFinish: false (in case we need to continue)
    // - Continuation stream: sendStart: false (continues same message)
    const stream = createUIMessageStream({
      generateId: uuidv7,
      execute: async ({ writer }) => {
        let currentMessages = convertToModelMessages(messages)
        let attemptNumber = 1
        let isRetry = false

        while (attemptNumber <= maxAttempts) {
          const result = runStreamText(currentMessages)
          const messageMetadata = createMessageMetadata(modelId)

          // If this is not the last possible attempt, we need to check for empty response
          if (attemptNumber < maxAttempts) {
            // Merge the stream without finish event (in case we need to retry)
            writer.merge(
              result.toUIMessageStream<ThunderboltUIMessage>({
                sendReasoning: true,
                messageMetadata,
                sendFinish: false,
              }),
            )

            // Wait for the stream to complete to check the result
            const response = await result.response
            const totalText = extractTextFromMessages(response.messages)
            const hadToolCalls = hasToolCalls(response.messages)

            // If we got a non-empty response, we're done - send finish event
            if (totalText.trim().length > 0) {
              writer.write({ type: 'finish' })
              return
            }

            // Empty response detected - prepare for retry if conditions are met
            if (shouldRetry(totalText, hadToolCalls, attemptNumber, maxAttempts)) {
              console.info('Empty response detected, retrying with nudge...')
              currentMessages = [
                ...currentMessages,
                ...response.messages,
                { role: 'user' as const, content: NUDGE_MESSAGES.retry },
              ]

              isRetry = true
              attemptNumber++
              continue
            }

            // Empty response with no tool calls - send finish event and return
            writer.write({ type: 'finish' })
            return
          }

          // Last attempt - continue same message if retry, otherwise normal
          writer.merge(
            result.toUIMessageStream<ThunderboltUIMessage>({
              sendReasoning: true,
              messageMetadata,
              ...(isRetry && { sendStart: false }),
            }),
          )
          return
        }
      },
    })

    return createUIMessageStreamResponse({ stream })
  } catch (error) {
    console.error('aiFetchStreamingResponse error', error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
