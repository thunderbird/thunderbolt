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
import { createModel } from '@/ai/fetch'
import { getModel, getModelProfile, getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import type { AgentSideConnection, PromptResponse } from '@agentclientprotocol/sdk'
import type { MCPClient } from '@/lib/mcp-provider'
import { http } from '@/lib/http'
import {
  convertToModelMessages,
  extractReasoningMiddleware,
  InvalidToolInputError,
  NoSuchToolError,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type Tool,
  type ToolSet,
} from 'ai'

type RunBuiltInPromptParams = {
  sessionId: string
  messages: ThunderboltUIMessage[]
  modelId: string
  modeSystemPrompt?: string
  modeName?: string
  conn: AgentSideConnection
  abortSignal: AbortSignal
  mcpClients?: MCPClient[]
}

const buildToolset = async ({
  supportsTools,
  mcpClients,
  sourceCollector,
}: {
  supportsTools: boolean
  mcpClients?: MCPClient[]
  sourceCollector: SourceMetadata[]
}): Promise<Record<string, Tool>> => {
  if (!supportsTools) {
    return {}
  }

  const availableTools = await getAvailableTools(http, sourceCollector)
  const toolset: Record<string, Tool> = { ...createToolset(availableTools) }

  for (const mcpClient of mcpClients ?? []) {
    const mcpTools = await mcpClient.tools()
    for (const [name, tool] of Object.entries(mcpTools)) {
      if (toolset[name]) {
        console.warn(`MCP tool "${name}" conflicts with an existing tool and was skipped`)
        continue
      }
      toolset[name] = tool as Tool
    }
  }

  return toolset
}

/**
 * Run a prompt through the built-in agent.
 * Wraps the AI SDK streamText logic and emits ACP session updates
 * (agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update).
 */
export const runBuiltInPrompt = async ({
  sessionId,
  messages,
  modelId,
  modeSystemPrompt,
  modeName,
  conn,
  abortSignal,
  mcpClients,
}: RunBuiltInPromptParams): Promise<PromptResponse> => {
  const db = getDb()

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

  const toolset = await buildToolset({ supportsTools, mcpClients, sourceCollector })

  const getIntegrationStatus = (): string => {
    const statuses: string[] = []
    if (settings.integrationsGoogleCredentials && !settings.integrationsGoogleIsEnabled) {
      statuses.push('GOOGLE_DISABLED')
    }
    if (settings.integrationsMicrosoftCredentials && !settings.integrationsMicrosoftIsEnabled) {
      statuses.push('MICROSOFT_DISABLED')
    }
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

  const providerOptionsKey = model.vendor ?? model.provider
  const rawOptions = {
    ...(model.supportsParallelToolCalls === 0 && { parallelToolCalls: false }),
    ...(model.vendor === 'openai' && { systemMessageMode: 'developer' as const }),
    ...profile?.providerOptions,
  }
  const providerOptions = Object.keys(rawOptions).length > 0 ? { [providerOptionsKey]: rawOptions } : undefined

  const runStreamText = (inputMessages: Awaited<ReturnType<typeof convertToModelMessages>>) =>
    streamText({
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
      },
      onFinish: (finish) => {
        console.info('finish', {
          text: finish.text,
          finishReason: finish.finishReason,
          usage: finish.totalUsage,
        })
      },
      onError: (error) => {
        console.error('streamText error', error)
      },
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) {
          console.warn(`Tool "${toolCall.toolName}" does not exist, skipping`)
          return null
        }
        if (InvalidToolInputError.isInstance(error)) {
          console.warn(`Invalid arguments for tool "${toolCall.toolName}": ${error.message}`)
          return null
        }
        console.warn(`Tool call error for "${toolCall.toolName}":`, error)
        return null
      },
    })

  // Stream through ACP, handling multi-attempt retries for empty responses
  let currentMessages = await convertToModelMessages(messages)
  let attemptNumber = 1
  let anyAttemptHadToolCalls = false

  while (attemptNumber <= maxAttempts) {
    const result = runStreamText(currentMessages)

    // Iterate over the full stream and convert to ACP updates
    for await (const part of result.fullStream) {
      if (abortSignal.aborted) {
        break
      }

      switch (part.type) {
        case 'text-delta':
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: part.text },
            },
          })
          break

        case 'reasoning-delta':
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: part.text },
            },
          })
          break

        case 'tool-input-start':
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: part.id,
              title: part.title ?? part.toolName,
              kind: 'other',
              status: 'in_progress',
            },
          })
          break

        case 'tool-call':
          // Tool call completed with full args — update with result pending
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: part.toolCallId,
              status: 'in_progress',
            },
          })
          break

        case 'tool-result':
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: part.toolCallId,
              status: 'completed',
              _meta: sourceCollector.length > 0 ? { sources: [...sourceCollector] } : undefined,
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
                  },
                },
              ],
            },
          })
          break

        case 'tool-error': {
          const errorText =
            'error' in part
              ? typeof part.error === 'string'
                ? part.error
                : JSON.stringify(part.error)
              : 'Unknown error'
          await conn.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: part.toolCallId,
              status: 'failed',
              _meta: sourceCollector.length > 0 ? { sources: [...sourceCollector] } : undefined,
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: errorText,
                  },
                },
              ],
            },
          })
          break
        }

        case 'source':
          // Sources will be tracked separately via sourceCollector
          break
      }
    }

    if (abortSignal.aborted) {
      return {
        stopReason: 'cancelled' as const,
        _meta: sourceCollector.length > 0 ? { sources: sourceCollector } : undefined,
      }
    }

    // Check for empty response retry
    const response = await result.response
    const totalText = extractTextFromMessages(response.messages)
    const hadToolCalls = hasToolCalls(response.messages)
    anyAttemptHadToolCalls = anyAttemptHadToolCalls || hadToolCalls

    if (totalText.trim().length > 0 || attemptNumber >= maxAttempts) {
      break
    }

    if (shouldRetry(totalText, anyAttemptHadToolCalls, attemptNumber, maxAttempts)) {
      const retryNudge =
        attemptNumber >= maxAttempts - 1
          ? `${activeNudges.retry} This is your final retry — you must produce a non-empty response.`
          : activeNudges.retry

      console.info(`Empty response detected, retrying (attempt ${attemptNumber + 1}/${maxAttempts})...`)
      currentMessages = [...currentMessages, ...response.messages, { role: 'user' as const, content: retryNudge }]
      attemptNumber++
      continue
    }

    break
  }

  return {
    stopReason: 'end_turn' as const,
    _meta: sourceCollector.length > 0 ? { sources: sourceCollector } : undefined,
  }
}
