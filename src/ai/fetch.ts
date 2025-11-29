import { createPrompt } from '@/ai/prompt'
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
    const MAX_RETRIES = 2

    const messageMetadata = () => ({ modelId })

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
        stopWhen: stepCountIs(MAX_STEPS),

        prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
          // Check if we've had multiple tool-call steps without any text response
          // This pattern often precedes the "empty response" bug
          const toolCallStepsInARow = steps.filter((s) => s.finishReason === 'tool-calls').length
          if (toolCallStepsInARow >= 6 && steps.length >= 7) {
            return {
              messages: [
                ...stepMessages,
                {
                  role: 'user' as const,
                  content:
                    'You have gathered information from multiple tool calls. Please synthesize the results and provide your response to the user now.',
                },
              ],
            }
          }

          if (steps.length >= MAX_STEPS - 1) {
            console.info(`Final step ${stepNumber} - telling model to wrap it up...`)
            return {
              activeTools: [],
              messages: [
                ...stepMessages,
                {
                  role: 'user' as const,
                  content:
                    'RESPOND NOW. Provide your answer using the information you have gathered. Do not ask questions—give your best response immediately.',
                },
              ],
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
      })
    }

    // Use createUIMessageStream to handle retries
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        let currentMessages = convertToModelMessages(messages)
        let attemptNumber = 1

        while (attemptNumber <= MAX_RETRIES) {
          const result = runStreamText(currentMessages)

          // If this is not the last possible attempt, we need to check for empty response
          if (attemptNumber < MAX_RETRIES) {
            // Merge the stream but don't send finish event yet (we might retry)
            writer.merge(
              result.toUIMessageStream<ThunderboltUIMessage>({
                sendReasoning: true,
                sendFinish: false,
                messageMetadata,
              }),
            )

            // Wait for the stream to complete to check the result
            const response = await result.response
            const totalText = response.messages.reduce((acc, msg) => {
              if (msg.role === 'assistant' && 'content' in msg) {
                const textContent = Array.isArray(msg.content)
                  ? msg.content
                      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                      .map((c) => c.text)
                      .join('')
                  : typeof msg.content === 'string'
                    ? msg.content
                    : ''
                return acc + textContent
              }
              return acc
            }, '')

            const hadToolCalls = response.messages.some(
              (msg) =>
                msg.role === 'assistant' &&
                'content' in msg &&
                Array.isArray(msg.content) &&
                msg.content.some((c) => c.type === 'tool-call'),
            )

            // If we got a non-empty response, we're done
            if (totalText.length > 0) {
              return
            }

            // Empty response detected - prepare for retry
            if (hadToolCalls) {
              console.info('Empty response detected, retrying with nudge...')
              currentMessages = [
                ...currentMessages,
                ...response.messages,
                {
                  role: 'user' as const,
                  content:
                    'You called tools but did not provide a response. Please synthesize all the information you gathered and respond to me now. Do not call any more tools.',
                },
              ]

              attemptNumber++
              continue
            }

            // Empty response with no tool calls - nothing to retry
            return
          }

          // Last attempt or no tool calls - just stream normally
          writer.merge(
            result.toUIMessageStream<ThunderboltUIMessage>({
              sendReasoning: true,
              messageMetadata,
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
