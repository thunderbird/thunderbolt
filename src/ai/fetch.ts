import { createPrompt } from '@/ai/prompt'
import {
  buildStepOverrides,
  extractTextFromMessages,
  getNudgeMessagesFromProfile,
  hasToolCalls,
  inferenceDefaults,
  isFinalStep,
  shouldRetry,
} from '@/ai/step-logic'
import { getModel, getModelProfile, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { isOidcMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { fetch } from '@/lib/fetch'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { HttpClient } from '@/lib/http'
import { v7 as uuidv7 } from 'uuid'

// Currently @openrouter/ai-sdk-provider is NOT compatible with Vercel AI SDK v5. If you enable this, you will get the following error:
// > [Error] Chat error: – Error: Unhandled chunk type: text-start — run-tools-transformation.ts:275
// OpenRouter is working on a new version of their SDK that is compatible with Vercel AI SDK v5. We'll uncomment this when it's ready.
// import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import {
  convertToModelMessages,
  createUIMessageStream,
  InvalidToolInputError,
  NoSuchToolError,
  createUIMessageStreamResponse,
  extractReasoningMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type Tool,
  type ToolSet,
} from 'ai'
import { type MCPClient } from '@ai-sdk/mcp'
import { createMessageMetadata } from './message-metadata'

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
  modeSystemPrompt?: string
  modeName?: string
  mcpClients?: MCPClient[]
  httpClient: HttpClient
}

export const createModel = async (modelConfig: Model) => {
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      const db = getDb()
      const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })
      // OIDC mode authenticates via session cookies (Better Auth's bearer plugin
      // doesn't issue a token to the frontend because the OIDC callback is a
      // browser redirect, not an XHR — `set-auth-token` never reaches the client).
      // Send credentials so the cookie is included cross-origin and DON'T set
      // apiKey, which would otherwise add an `Authorization: Bearer <garbage>`
      // header that Better Auth's bearer plugin would attempt first and reject.
      const oidc = isOidcMode()
      const withCredentials = (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, credentials: 'include' })
      withCredentials.preconnect = fetch.preconnect
      const providerFetch: typeof fetch = oidc ? withCredentials : fetch
      const apiKey = oidc ? undefined : getAuthToken() || 'thunderbolt'
      // GPT OSS (vendor: 'openai') uses createOpenAI with .chat() to force Chat Completions API
      // (AI SDK 5 defaults createOpenAI to Responses API which our backend doesn't support)
      if (modelConfig.vendor === 'openai') {
        const provider = createOpenAI({ baseURL: cloudUrl, apiKey, fetch: providerFetch })
        return provider.chat(modelConfig.model)
      }
      const provider = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL: cloudUrl,
        apiKey,
        fetch: providerFetch,
      })
      return provider(modelConfig.model)
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: modelConfig.apiKey || '',
        fetch,
        headers: {
          // When a user adds their own Anthropic API key, calls go directly from the
          // browser to Anthropic's API (not through our backend). Anthropic blocks
          // browser-origin requests by default to prevent accidental key exposure.
          // This header opts in, acknowledging the risk.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      })
      return anthropic(modelConfig.model)
    }
    case 'openai': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
        fetch,
      })
      return openai(modelConfig.model)
    }
    case 'custom': {
      if (!modelConfig.url) {
        throw new Error('No URL provided for custom provider')
      }
      const openaiCompatible = createOpenAICompatible({
        name: 'custom',
        baseURL: modelConfig.url,
        apiKey: modelConfig.apiKey || undefined,
        fetch,
      })
      return openaiCompatible(modelConfig.model)
    }
    case 'openrouter': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
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
  modeSystemPrompt,
  modeName,
  mcpClients,
  httpClient,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined
  const { messages, id } = body as { messages: ThunderboltUIMessage[]; id: string }

  await saveMessages({ id, messages })

  const db = getDb()

  // Fetch all settings in a single query (returns camelCase by default)
  const settings = await getSettings(db, {
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    distance_unit: 'imperial',
    temperature_unit: 'f',
    date_format: 'MM/DD/YYYY',
    time_format: '12h',
    currency: 'USD',
    integrations_do_not_ask_again: false,
    integrations_google_credentials: '',
    integrations_google_is_enabled: false,
    integrations_microsoft_credentials: '',
    integrations_microsoft_is_enabled: false,
  })

  const model = await getModel(db, modelId)

  if (!model) {
    throw new Error('Model not found')
  }

  const profile = await getModelProfile(db, modelId)

  const supportsTools = model.toolUsage !== 0

  const sourceCollector: SourceMetadata[] = []

  let toolset: Record<string, Tool> = {}
  if (supportsTools) {
    const availableTools = await getAvailableTools(httpClient, sourceCollector)
    toolset = { ...createToolset(availableTools) }

    for (const mcpClient of mcpClients || []) {
      const mcpTools = await mcpClient.tools()
      for (const [name, tool] of Object.entries(mcpTools)) {
        if (toolset[name]) {
          console.warn(`MCP tool "${name}" conflicts with an existing tool and was skipped`)
          continue
        }
        toolset[name] = tool as Tool
      }
    }
  } else {
    console.log('Model does not support tools, skipping tool setup')
  }

  // Compute integration status for the model (can return multiple statuses)
  const getIntegrationStatus = (): string => {
    const statuses: string[] = []

    // Check for disabled integrations (connected but turned off)
    if (settings.integrationsGoogleCredentials && !settings.integrationsGoogleIsEnabled) {
      statuses.push('GOOGLE_DISABLED')
    }
    if (settings.integrationsMicrosoftCredentials && !settings.integrationsMicrosoftIsEnabled) {
      statuses.push('MICROSOFT_DISABLED')
    }
    // Check if user chose "Don't ask again"
    if (settings.integrationsDoNotAskAgain) {
      statuses.push('PROMPTS_DISABLED')
    }

    return statuses.length > 0 ? statuses.join(', ') : 'READY'
  }

  const systemPrompt = createPrompt({
    modelName: model.name,
    profile,
    modeName: modeName ?? null,
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
    integrationStatus: getIntegrationStatus(),
    modeSystemPrompt,
  })

  const activeNudges = getNudgeMessagesFromProfile(profile, modeName)

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

    const modelTemperature = profile?.temperature ?? inferenceDefaults.temperature
    const maxSteps = profile?.maxSteps ?? inferenceDefaults.maxSteps
    const maxAttempts = profile?.maxAttempts ?? inferenceDefaults.maxAttempts
    const nudgeThreshold = profile?.nudgeThreshold ?? inferenceDefaults.nudgeThreshold

    // Build provider options from profile + per-model DB settings
    // Uses vendor (actual model maker like 'mistral') for provider options key since the
    // backend recognizes vendor-specific options. Falls back to provider for user-created models.
    // See: https://github.com/vllm-project/vllm/issues/9019
    const providerOptionsKey = model.vendor ?? model.provider
    const rawOptions = {
      ...(model.supportsParallelToolCalls === 0 && { parallelToolCalls: false }),
      // OpenAI vendor models require systemMessageMode: 'developer' for Chat Completions API.
      // This is a transport-level requirement (not model tuning), so it's hardcoded as a baseline
      // rather than relying solely on the profile — custom OpenAI models may not have a profile.
      ...(model.vendor === 'openai' && { systemMessageMode: 'developer' as const }),
      ...profile?.providerOptions,
    }
    const providerOptions = Object.keys(rawOptions).length > 0 ? { [providerOptionsKey]: rawOptions } : undefined

    /**
     * Run a single streamText attempt and return the result along with metadata
     */
    const runStreamText = (inputMessages: Awaited<ReturnType<typeof convertToModelMessages>>) => {
      return streamText({
        temperature: modelTemperature,
        model: wrappedModel,
        system: systemPrompt,
        messages: inputMessages,
        tools: supportsTools ? (toolset as ToolSet) : undefined,
        stopWhen: stepCountIs(maxSteps),
        providerOptions,

        prepareStep: ({ steps, stepNumber, messages: stepMessages }) => {
          if (isFinalStep(steps.length, maxSteps)) {
            console.info(`Final step ${stepNumber} - telling model to wrap it up...`)
          }
          return buildStepOverrides({
            steps,
            messages: stepMessages,
            systemPrompt,
            profile,
            maxSteps,
            nudgeThreshold,
            activeNudges,
          })
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

        // Handle malformed tool calls from models with weaker tool-calling capabilities
        experimental_repairToolCall: async ({ toolCall, error }) => {
          // Don't attempt to repair calls to non-existent tools
          if (NoSuchToolError.isInstance(error)) {
            console.warn(`Tool "${toolCall.toolName}" does not exist, skipping`)
            return null
          }

          // Log invalid tool arguments and skip the call
          if (InvalidToolInputError.isInstance(error)) {
            console.warn(`Invalid arguments for tool "${toolCall.toolName}": ${error.message}`)
            return null
          }

          // For other errors, skip the tool call
          console.warn('Tool call error for "%s":', toolCall.toolName, error)
          return null
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
        let currentMessages = await convertToModelMessages(messages)
        let attemptNumber = 1
        let isRetry = false
        // Track tool calls across ALL attempts — a retry may produce no tool calls
        // but the data from attempt 1's tools is still there to synthesize
        let anyAttemptHadToolCalls = false

        while (attemptNumber <= maxAttempts) {
          const result = runStreamText(currentMessages)
          const messageMetadata = createMessageMetadata(modelId, sourceCollector)

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
            anyAttemptHadToolCalls = anyAttemptHadToolCalls || hadToolCalls

            // If we got a non-empty response, we're done - send finish event
            if (totalText.trim().length > 0) {
              writer.write({ type: 'finish' })
              return
            }

            // Empty response detected - retry if any attempt gathered tool data
            if (shouldRetry(totalText, anyAttemptHadToolCalls, attemptNumber, maxAttempts)) {
              // Escalate urgency on later retries
              const retryNudge =
                attemptNumber >= maxAttempts - 1
                  ? `${activeNudges.retry} This is your final retry — you must produce a non-empty response.`
                  : activeNudges.retry

              console.info(`Empty response detected, retrying (attempt ${attemptNumber + 1}/${maxAttempts})...`)
              currentMessages = [
                ...currentMessages,
                ...response.messages,
                { role: 'user' as const, content: retryNudge },
              ]

              isRetry = true
              attemptNumber++
              continue
            }

            // Empty response with no tool calls across any attempt - send finish event and return
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
    const status =
      (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status
    return new Response(JSON.stringify({ error: (error as Error).message, status }), {
      status: status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
