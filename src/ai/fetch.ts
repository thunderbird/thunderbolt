/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { getAllSkills, getIntegrationStatus, getModel, getModelProfile, getSettings } from '@/dal'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { getDb } from '@/db/database'
import { getLocalSetting } from '@/stores/local-settings-store'
import { isSsoMode } from '@/lib/auth-mode'
import { getAuthToken } from '@/lib/auth-token'
import { fetch as baseFetch } from '@/lib/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createToolset, getAvailableTools } from '@/lib/tools'
import type { Model, ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { HttpClient } from '@/lib/http'
import type { SecureClient } from 'tinfoil'
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

/** Wrap fetch to include credentials in SSO mode so session cookies are sent to the backend. */
const fetch: typeof baseFetch = (input, init) =>
  baseFetch(input, isSsoMode() ? { ...init, credentials: 'include' } : init)
fetch.preconnect = baseFetch.preconnect

export const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  // compatibility: 'compatible',
  apiKey: 'ollama',
  fetch,
})

// Cached so attestation runs once per page load. `tinfoil` is dynamically
// imported to code-split its attestation/crypto deps.
//
// system: HPKE body POSTs to <cloudUrl>/tinfoil; backend injects our key.
// user:   BYOK — direct to the enclave with the user's own key.
//
// System cache is keyed by cloudUrl so a dev-tools URL switch hits the new
// backend on the next call.
const systemTinfoilClients = new Map<string, SecureClient>()
let userTinfoilClient: SecureClient | null = null

export const getSystemTinfoilClient = async (): Promise<SecureClient> => {
  // cloudUrl already ends in /v1 (shared with the OpenAI chat baseURL).
  const cloudUrl = getLocalSetting('cloudUrl').replace(/\/$/, '')
  let client = systemTinfoilClients.get(cloudUrl)
  if (!client) {
    const { SecureClient } = await import('tinfoil')
    client = new SecureClient({ baseURL: `${cloudUrl}/tinfoil` })
    systemTinfoilClients.set(cloudUrl, client)
  }
  await client.ready()
  return client
}

export const getTinfoilClient = async (): Promise<SecureClient> => {
  if (!userTinfoilClient) {
    const { SecureClient } = await import('tinfoil')
    userTinfoilClient = new SecureClient()
  }
  await userTinfoilClient.ready()
  return userTinfoilClient
}

type AiFetchStreamingResponseOptions = {
  init: RequestInit
  modelId: string
  modeSystemPrompt?: string
  modeName?: string
  mcpClients?: MCPClient[]
  httpClient: HttpClient
  /** Returns the current proxy fetch. Production callers pass the getter from
   *  `ProxyFetchProvider` (`useProxyFetchGetter()`); non-React callers (eval
   *  scripts) build a `proxyFetch` directly and wrap it in `() => fn`. */
  getProxyFetch: () => FetchFn
}

export const createModel = async (modelConfig: Model, getProxyFetch: () => FetchFn) => {
  // The thunderbolt provider goes through its own SSO-aware fetch below; all
  // other providers route through the universal proxy. We resolve the proxy
  // fetch lazily so a settings change between chat creation and this call
  // (e.g. cloudUrl, proxy_enabled toggle) is picked up.
  switch (modelConfig.provider) {
    case 'thunderbolt': {
      const cloudUrl = getLocalSetting('cloudUrl')
      const token = getAuthToken() || 'thunderbolt'
      // SSO web flow authenticates via session cookies — the SSO callback is a
      // browser redirect, not an XHR, so `set-auth-token` never reaches the
      // client and getAuthToken() returns null.  The AI SDKs require an apiKey
      // to initialize, so we keep the placeholder 'thunderbolt' but strip the
      // resulting invalid Authorization header — otherwise Better Auth's bearer
      // plugin would try the placeholder first and 401 before falling back to
      // the cookie.
      //
      // Tauri desktop SSO uses a loopback server that returns a real bearer
      // token (stored via setAuthToken).  In that case we must keep the
      // Authorization header because WKWebView can't send cross-origin cookies.
      const sso = isSsoMode()
      const hasRealToken = Boolean(getAuthToken())
      const ssoFetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        headers.delete('authorization')
        return fetch(input, { ...init, headers, credentials: 'include' })
      }
      ssoFetch.preconnect = fetch.preconnect
      const providerFetch: typeof fetch = sso && !hasRealToken ? ssoFetch : fetch
      // GPT OSS (vendor: 'openai') uses createOpenAI with .chat() to force Chat Completions API
      // (AI SDK 5 defaults createOpenAI to Responses API which our backend doesn't support)
      if (modelConfig.vendor === 'openai') {
        const provider = createOpenAI({ baseURL: cloudUrl, apiKey: token, fetch: providerFetch })
        return provider.chat(modelConfig.model)
      }
      const provider = createOpenAICompatible({
        name: 'thunderbolt',
        baseURL: cloudUrl,
        apiKey: token,
        fetch: providerFetch,
      })
      return provider(modelConfig.model)
    }
    case 'anthropic': {
      // Route Anthropic through the universal proxy. Hosted mode (web) sends
      // the request to /v1/proxy with Authorization rewritten to
      // X-Proxy-Passthrough-Authorization; Standalone mode (Tauri) hits
      // Anthropic directly via the Rust HTTP plugin. Either way, the user's
      // Anthropic key never goes through Thunderbolt's session auth path.
      const anthropic = createAnthropic({
        apiKey: modelConfig.apiKey || '',
        fetch: getProxyFetch(),
      })
      return anthropic(modelConfig.model)
    }
    case 'openai': {
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const openai = createOpenAI({
        apiKey: modelConfig.apiKey,
        fetch: getProxyFetch(),
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
        fetch: getProxyFetch(),
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
        fetch: getProxyFetch(),
      })
      return openrouter(modelConfig.model)
    }
    case 'tinfoil': {
      // System Tinfoil models proxy through Thunderbolt's backend; the bearer
      // key is injected server-side, so we pass a placeholder here only to
      // satisfy the SDK's apiKey requirement. User-added Tinfoil models keep
      // the BYOK flow and require a real key.
      if (modelConfig.isSystem) {
        const client = await getSystemTinfoilClient()
        // Wrap SecureClient.fetch so the backend route's auth guard sees the
        // real Thunderbolt session token (Bearer) or cookies (SSO), not the
        // `Bearer thunderbolt-managed` placeholder the OpenAI SDK adds.
        const sso = isSsoMode()
        const token = getAuthToken()
        const wrappedFetch: typeof fetch = Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            const upstreamInit: RequestInit = { ...init, headers }
            if (sso && !token) {
              upstreamInit.credentials = 'include'
              headers.delete('authorization')
            } else if (token) {
              headers.set('Authorization', `Bearer ${token}`)
            }
            return client.fetch(input, upstreamInit)
          },
          { preconnect: fetch.preconnect },
        )
        const tinfoil = createOpenAICompatible({
          name: 'tinfoil',
          baseURL: client.getBaseURL()!,
          apiKey: 'thunderbolt-managed',
          fetch: wrappedFetch,
        })
        return tinfoil(modelConfig.model)
      }
      if (!modelConfig.apiKey) {
        throw new Error('No API key provided')
      }
      const client = await getTinfoilClient()
      const tinfoil = createOpenAICompatible({
        name: 'tinfoil',
        baseURL: client.getBaseURL()!,
        apiKey: modelConfig.apiKey,
        fetch: client.fetch,
      })
      return tinfoil(modelConfig.model)
    }
    default:
      throw new Error(`Unsupported provider: ${modelConfig.provider}`)
  }
}

export const aiFetchStreamingResponse = async ({
  init,
  modelId,
  modeSystemPrompt,
  modeName,
  mcpClients,
  httpClient,
  getProxyFetch,
}: AiFetchStreamingResponseOptions) => {
  const options = init as RequestInit & { body: string }
  const body = JSON.parse(options.body)
  const abortSignal: AbortSignal | undefined = options.signal ?? undefined
  const { messages } = body as { messages: ThunderboltUIMessage[]; id: string }

  // The chat instance saves the user message via `saveMessages` before
  // invoking the adapter — see `src/chats/chat-instance.ts`. By the time we
  // reach this function the user turn is already persisted.

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
  })

  const integrationStatus = await getIntegrationStatus(db)

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
  const computeIntegrationStatusLabel = (): string => {
    const statuses: string[] = []

    if (integrationStatus.googleConnected && !integrationStatus.googleEnabled) {
      statuses.push('GOOGLE_DISABLED')
    }
    if (integrationStatus.microsoftConnected && !integrationStatus.microsoftEnabled) {
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
    integrationStatus: computeIntegrationStatusLabel(),
    modeSystemPrompt,
  })

  const activeNudges = getNudgeMessagesFromProfile(profile, modeName)

  try {
    const baseModel = await createModel(model, getProxyFetch)

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
    // Skills v1 §4: resolve slash tokens in the most recent user message
    // into ephemeral system messages. Re-resolution happens on every send /
    // regenerate so the model sees the user's *current* skill library, not
    // a snapshot from when the message was originally typed.
    //
    // Skills v1 §OQ6: skills are intentionally available in *every* mode
    // (Chat, Search, Research). There's no per-mode gating here — a skill
    // is text injection, not a tool, and modes that disagree on tools
    // still agree on text. If a future mode wants to exclude skills it'd
    // need an explicit `noSkills` flag on the mode definition.
    //
    // The composer (`chat-prompt-input.tsx`) uses the same helpers to size
    // the context-overflow estimate so the budget and the actual prepend
    // stay in lockstep.
    const lastUserText = extractLastUserText(messages)
    const allSkills = await getAllSkills(db)
    const instructionBySlug = new Map<string, string>()
    for (const skill of allSkills) {
      if (skill.enabled === 1 && skill.name && skill.instruction) {
        instructionBySlug.set(skill.name, skill.instruction)
      }
    }
    const skillSystemMessages = resolveSkillTokenInstructions(lastUserText, instructionBySlug)

    const stream = createUIMessageStream({
      generateId: uuidv7,
      execute: async ({ writer }) => {
        const baseMessages = await convertToModelMessages(messages)
        let currentMessages: typeof baseMessages = [
          ...skillSystemMessages.map((content) => ({ role: 'system' as const, content })),
          ...baseMessages,
        ]
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
