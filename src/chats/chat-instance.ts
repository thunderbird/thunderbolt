/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'
import type { connectToAgent as defaultConnectToAgent } from '@/acp'
import { getChatReasoningEffort as defaultGetChatReasoningEffort } from '@/ai/reasoning-effort'
import {
  getOrConnectAdapter as defaultGetOrConnectAdapter,
  wakeAdapterReconnect as defaultWakeAdapterReconnect,
} from '@/acp/adapter-cache'
import type { AcpCommand, SessionSideEffect } from '@/acp/translators/acp-to-ai-sdk'
import { useAgentCommandsStore } from '@/acp/agent-commands-store'
import { useAcpSessionStore } from '@/acp/session-state-store'
import { sessionConfigKey } from '@/acp/session-config-store'
import type { AcpSessionEvent } from '@/acp/compaction'
import {
  createTurnBudget as defaultCreateTurnBudget,
  createTurnBudgetExhaustedError,
  type TurnBudget,
} from '@/ai/retry-budget'
import { createTurnTelemetry as defaultCreateTurnTelemetry, type TurnTelemetry } from '@/ai/turn-telemetry'
import { createWebToolBudget, type WebToolBudget } from '@/ai/web-tool-budget'
import { browserController } from '@/browser/browser-controller'
import { resolveWebToolIntent, webBudgetExhaustedMessage } from '@/ai/turn-web-budget'
import { updateChatThread as defaultUpdateChatThread } from '@/dal/chat-threads'
import { getAllSkills as defaultGetAllSkills, getAvailableModels as defaultGetAvailableModels } from '@/dal'
import { isBuiltInAgent, isHostedAgent } from '@/defaults/agents'
import { isModelReady, matchesThreadConfidentiality } from '@/settings/models/model-policy'
import { loadProjectContextForThread as defaultLoadProjectContext } from '@/projects/load-project-context'
import { buildProjectPromptSection } from '@/projects/project-prompt'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { getDb as defaultGetDb } from '@/db/database'
import {
  beginDebugTranscriptTurn,
  finishDebugTranscriptTurn,
  isDebugTranscriptCaptureEnabled,
  recordDebugTranscriptFailure,
  recordDebugTranscriptRetry,
} from '@/debug-transcript/recorder'
import { attemptsMadeFromCompletedRetries, emptyResponseRetryReason } from '@/debug-transcript/retry-metadata'
import type {
  DebugTranscriptEngine,
  DebugTranscriptMessageMetadataV1,
  DebugTranscriptTurnOutcome,
} from '@/debug-transcript/types'
import {
  getChatErrorKind,
  getErrorName,
  getErrorRetryable,
  getErrorStatusCode,
  isAgentRunInProgressError,
  isContentRejectionError,
  isContextOverflowError,
  isRateLimitError,
  isToolSupportRejectionError,
} from '@/lib/error-utils'
import type { HttpClient } from '@/lib/http'
import { hasAssistantContent } from '@/lib/message-utils'
import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import { Chat } from '@ai-sdk/react'
import { getAgentExecution } from '@/agent-execution/store'
import { getProjectExecution } from '@/agent-execution/project-execution'
import { assertProjectAgent, isProjectAgentUnavailableError } from '@/agent-execution/project-agent'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { DefaultChatTransport, type ChatInit, type ChatOnFinishCallback } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { deriveToolKey, findAllowOption, useChatStore } from './chat-store'
import { withStoppedReplyMarkers } from './stopped-prompts'
import { waitForChatThreadWrites } from './chat-thread-write'
import { applyAcpSessionEvent, getAcpCompactions } from './acp-session-events'

export const maxRetries = 3
const baseRetryDelayMs = 2000
const emptyTurnRetryDelayMs = 250

/** Access changes require an explicit user choice, never automatic retries or provider fallback. */
class ModelAccessError extends Error {
  readonly isRetryable = false
  override name = 'ModelAccessError'
}

/** Resolve current model access for every inference attempt, including regeneration and retries. */
const requireRunnableModel = (agent: Agent, selectedModel: Model): Model => {
  if (!isBuiltInAgent(agent)) {
    return selectedModel
  }
  const current = useChatStore.getState().models.find((model) => model.id === selectedModel.id && isModelReady(model))
  if (!current) {
    throw new ModelAccessError(t`Configure and select an available model before sending a message.`)
  }
  return current
}

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Jitter prevents synchronized retries from overwhelming servers.
 */
const getRetryDelay = (attempt: number) => baseRetryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random())

/** Base delay before re-sending a turn the hosted agent refused because a reply
 *  is still running. The backend holds the run slot for up to two minutes, so
 *  the three backed-off attempts (about 10s, 20s, 40s) span most of that. */
const agentRunInProgressRetryDelayMs = 10_000

/** How long to wait before auto-retry `attempt` of a failed turn. */
const getTurnRetryDelay = (attempt: number, turn: { isEmptyTurn: boolean; isRunInProgress: boolean }): number => {
  if (turn.isRunInProgress) {
    return (agentRunInProgressRetryDelayMs / baseRetryDelayMs) * getRetryDelay(attempt)
  }
  return turn.isEmptyTurn && attempt === 1 ? emptyTurnRetryDelayMs : getRetryDelay(attempt)
}

/** The engine a debug transcript records for a turn: the built-in agent reports
 *  its own, the hosted agent is `hosted`, and every other agent speaks ACP. */
const debugTranscriptEngineFor = (agent: Agent, telemetry: TurnTelemetry | undefined): DebugTranscriptEngine => {
  if (isBuiltInAgent(agent)) {
    return telemetry?.getEngine() ?? 'legacy'
  }
  return isHostedAgent(agent) ? 'hosted' : 'acp'
}

const generatedContentPayloadSchema = z.object({
  type: z.enum(['text-delta', 'reasoning-delta']),
  delta: z.string().min(1),
})
const toolDurationSchema = z.number()

/** Observe complete SSE data lines without changing or delaying stream chunks.
 *  Reports whether the line carried generated content (the first-token signal). */
const observeSseLine = (line: string, telemetry: TurnTelemetry): boolean => {
  if (!line.startsWith('data:')) {
    return false
  }
  const data = line.slice('data:'.length).trimStart()
  if (data === '[DONE]') {
    return false
  }
  try {
    if (generatedContentPayloadSchema.safeParse(JSON.parse(data)).success) {
      telemetry.markFirstToken()
      return true
    }
  } catch {
    // Telemetry must remain transparent if an adapter emits a non-JSON SSE event.
  }
  return false
}

/** Mark the first generated content delta while preserving response metadata. */
const wrapResponseForFirstContent = (response: Response, telemetry?: TurnTelemetry): Response => {
  if (!response.body || !telemetry) {
    return response
  }

  const decoder = new TextDecoder()
  const state = { lineBuffer: '', sawFirstContent: false }
  const observeLines = (text: string, flush = false): void => {
    state.lineBuffer += text
    const lines = state.lineBuffer.split(/\r?\n/)
    const finalLine = lines.pop() ?? ''
    state.lineBuffer = flush ? '' : finalLine
    for (const line of lines) {
      if (observeSseLine(line, telemetry)) {
        state.sawFirstContent = true
        return
      }
    }
    if (flush && finalLine && observeSseLine(finalLine, telemetry)) {
      state.sawFirstContent = true
    }
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        // The first-token mark is a one-shot latch: once it fires, the rest of
        // the stream passes through without decoding or JSON.parse.
        if (!state.sawFirstContent) {
          observeLines(decoder.decode(chunk, { stream: true }))
        }
        controller.enqueue(chunk)
      },
      flush: () => {
        if (!state.sawFirstContent) {
          observeLines(decoder.decode(), true)
        }
      },
    }),
  )
  return new Response(body, response)
}

/** Bridge an ACP `requestPermission` call to the chat-store dialog flow.
 *  Auto-approves remembered allowances; otherwise stashes the request until
 *  the dialog resolves it. */
const requestPermissionViaStore = (
  sessionId: string,
  agentId: string,
  request: RequestPermissionRequest,
  signal?: AbortSignal | null,
  rememberAllowances = true,
): Promise<RequestPermissionResponse> => {
  const toolKey = deriveToolKey(request)
  const allowOption = findAllowOption(request.options)

  if (rememberAllowances && allowOption && useChatStore.getState().isAlwaysAllowed(agentId, toolKey)) {
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } })
  }

  return new Promise<RequestPermissionResponse>((resolve) => {
    const requestId = uuidv7()
    const cancel = () => {
      if (useChatStore.getState().sessions.get(sessionId)?.pendingPermission?.requestId === requestId) {
        useChatStore.getState().resolvePendingPermission(sessionId, { outcome: { outcome: 'cancelled' } })
      }
    }
    useChatStore.getState().setPendingPermission(sessionId, {
      agentId,
      requestId,
      request,
      resolve: (response) => {
        signal?.removeEventListener('abort', cancel)
        resolve(response)
      },
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) {
      cancel()
    }
  })
}

/** Build the agent-level commands sink wired into the ACP connection. Stashes
 *  the agent's advertised commands so the chat input's slash menu can surface
 *  them (badged with the agent name). Keyed by agent — they're agent-level, so
 *  the same sink serves every thread that targets the agent. */
export const makeCommandSink =
  (agentId: string) =>
  (commands: AcpCommand[]): void =>
    useAgentCommandsStore.getState().setCommands(agentId, commands)

const applySessionSideEffect = (effect: SessionSideEffect): void => {
  if (effect.type === 'mode_changed') {
    defaultTrackEvent('acp_mode_changed', { mode_id: effect.modeId })
    return
  }
  if (effect.type === 'config_options_changed') {
    defaultTrackEvent('acp_config_options_changed', { count: effect.options.length })
  }
}

/** DI seams for tests. Production binds to the real ACP cache + entry point and
 *  the DAL's `updateChatThread`. Module-level functions are passed by reference
 *  so test files can swap in fakes without `mock.module()`. `connectToAgent`
 *  is forwarded through `getOrConnectAdapter` into the global cache so a test
 *  can fake the connect while exercising the real reuse path. */
export type CreateChatInstanceDeps = {
  getChatReasoningEffort?: typeof defaultGetChatReasoningEffort
  getOrConnectAdapter?: typeof defaultGetOrConnectAdapter
  connectToAgent?: typeof defaultConnectToAgent
  updateChatThread?: typeof defaultUpdateChatThread
  getDb?: typeof defaultGetDb
  getAllSkills?: typeof defaultGetAllSkills
  getAvailableModels?: () => Promise<Model[]>
  loadProjectContext?: typeof defaultLoadProjectContext
  createChat?: (init: ChatInit<ThunderboltUIMessage>) => Chat<ThunderboltUIMessage>
  createTurnBudget?: typeof defaultCreateTurnBudget
  wakeAdapterReconnect?: typeof defaultWakeAdapterReconnect
  createTurnTelemetry?: typeof defaultCreateTurnTelemetry
  trackEvent?: typeof defaultTrackEvent
}

export type AgentRoutingState = {
  regenerationRevision?: number
  webToolBudgetRevision?: number
  webToolBudgetState?: { key: string; budget: WebToolBudget }
  getTurnBudget?: () => TurnBudget
  getTurnTelemetry?: () => TurnTelemetry | undefined
  getDebugTranscriptTraceId?: () => string | undefined
  getAttempt?: () => number
  getTurnModel?: () => Model | undefined
}

/**
 * Build the `customFetch` the AI SDK's transport invokes for every
 * `chat.sendMessage(...)`. Each send routes to the GLOBAL per-agent adapter
 * cache (`getOrConnectAdapter`): one transport + one `initialize` per agent,
 * reused across every thread that targets it. Switching threads on the same
 * agent reuses the warm connection — it is never torn down here.
 *
 * Per-thread state (ACP session resolution, permission dialogs, side-effect
 * sinks) is supplied on each `adapter.fetch(init, ctx)` call, so one connection
 * multiplexes many threads without cross-thread bleed.
 *
 * `connectionStatus` reflects THIS thread's view: `connecting` is shown while
 * the cache resolves the adapter for a newly-selected agent (instant on a warm
 * cache), then `ready`. Switching the agent within a thread re-routes to a
 * different cached connection but never disposes the previous one — other
 * threads may still be using it.
 *
 * Exported separately so unit tests can drive it without spinning up
 * `@ai-sdk/react`'s `Chat` instance.
 */
export const createAgentRoutingFetch = (
  id: string,
  saveMessages: SaveMessagesFunction,
  httpClient: HttpClient,
  getProxyFetch: () => FetchFn,
  deps: CreateChatInstanceDeps = {},
  routingState: AgentRoutingState = {},
) => {
  const getOrConnectAdapter = deps.getOrConnectAdapter ?? defaultGetOrConnectAdapter
  const updateChatThread = deps.updateChatThread ?? defaultUpdateChatThread
  const getDb = deps.getDb ?? defaultGetDb
  const getAllSkills = deps.getAllSkills ?? defaultGetAllSkills
  const getAvailableModels = deps.getAvailableModels ?? (async () => defaultGetAvailableModels(getDb()))
  const loadProjectContext = deps.loadProjectContext ?? defaultLoadProjectContext
  const getTurnBudget =
    routingState.getTurnBudget ??
    (() => {
      const turnBudget = (deps.createTurnBudget ?? defaultCreateTurnBudget)()
      return () => turnBudget
    })()

  let routedAgentId: string | null = null

  const getWebToolBudget = (messages: ThunderboltUIMessage[]): WebToolBudget | undefined => {
    const lastUserMessage = messages.findLast((message) => message.role === 'user')
    if (!lastUserMessage) {
      return undefined
    }
    const key = `${lastUserMessage.id}#${routingState.webToolBudgetRevision ?? 0}`
    if (routingState.webToolBudgetState?.key === key) {
      return routingState.webToolBudgetState.budget
    }
    const budget = createWebToolBudget(
      resolveWebToolIntent(extractLastUserText(messages)),
      undefined,
      webBudgetExhaustedMessage,
    )
    routingState.webToolBudgetState = { key, budget }
    return budget
  }

  /** Resolve user-skill (`/slug`) instructions from the latest user message, so
   *  ACP agents can receive them in the prompt (the built-in pipeline injects
   *  these itself in `ai/fetch.ts`, so this only runs for non-built-in agents).
   *  Cheap-exits before touching the DB when there's no message or no `/` token. */
  const resolveAcpSkillInstructions = async (messages: ThunderboltUIMessage[] | undefined): Promise<string[]> => {
    if (!messages?.length) {
      return []
    }
    const lastUserText = extractLastUserText(messages)
    if (!lastUserText.includes('/')) {
      return []
    }
    const instructionBySlug = new Map<string, string>()
    for (const skill of await getAllSkills(getDb())) {
      if (skill.enabled === 1 && skill.name && skill.instruction) {
        instructionBySlug.set(skill.name, skill.instruction)
      }
    }
    return resolveSkillTokenInstructions(lastUserText, instructionBySlug)
  }

  /**
   * Render the chat's project context as prompt text for an ACP agent.
   *
   * `search_project_chats` is deliberately not advertised: it is an AI-SDK tool
   * registered on the built-in toolset, and an ACP agent runs its own — promising
   * it here would invite the agent to call something that does not exist.
   */
  const resolveAcpProjectSection = async (threadId: string): Promise<string | undefined> => {
    const projectContext = await loadProjectContext(getDb(), threadId)
    if (!projectContext) {
      return undefined
    }
    return buildProjectPromptSection(projectContext.prompt, { hasSearchableChats: false }) ?? undefined
  }

  const resolve = async (init: RequestInit | undefined, operation: 'prompt' | 'compact') => {
    if (!init) {
      throw new Error('Missing init')
    }

    await waitForChatThreadWrites(id)
    const { getMcpClients, reconnectClient, sessions } = useChatStore.getState()

    // Read clients fresh per send (not a hydrate-time snapshot) so a server
    // reconnected since the last send is seen with its current client.
    const mcpClients = getMcpClients()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const { chatThread, selectedAgent } = session
    assertProjectAgent(selectedAgent, session.projectId)
    const selectedModel =
      operation === 'prompt' && isBuiltInAgent(selectedAgent)
        ? (routingState.getTurnModel?.() ?? session.selectedModel)
        : session.selectedModel
    requireRunnableModel(selectedAgent, selectedModel)
    const reasoningEffort = isBuiltInAgent(selectedAgent)
      ? await (deps.getChatReasoningEffort ?? defaultGetChatReasoningEffort)(id, selectedModel)
      : undefined
    const telemetry =
      operation === 'prompt' && isBuiltInAgent(selectedAgent) ? routingState.getTurnTelemetry?.() : undefined
    telemetry?.setDimensions({
      modelId: selectedModel.id,
      modelName: selectedModel.model,
      provider: selectedModel.provider,
    })

    // Save the user message before invoking the adapter. This:
    //   1. Creates the `chat_threads` row on the first message (so the
    //      thread is persisted regardless of agent type).
    //   2. Lets `updateThreadTitle` see the first user message and replace
    //      the placeholder "New Chat" title — ACP agents only emit assistant
    //      messages from `onFinish`, so without this save the title would
    //      never be generated.
    //   3. Keeps message ordering consistent: the user turn is durable
    //      before the assistant stream starts.
    const requestBody = JSON.parse(init.body as string) as { messages?: ThunderboltUIMessage[] }
    const requestMessages = requestBody.messages ?? []
    const debugTranscriptTraceId = operation === 'prompt' ? routingState.getDebugTranscriptTraceId?.() : undefined
    if (debugTranscriptTraceId) {
      const lastUserMessage = requestMessages.findLast((message) => message.role === 'user')
      beginDebugTranscriptTurn({
        threadId: id,
        traceId: debugTranscriptTraceId,
        engine: debugTranscriptEngineFor(selectedAgent, telemetry),
        model: {
          id: selectedModel.id,
          name: selectedModel.model,
          provider: selectedModel.provider,
        },
        agentId: selectedAgent.id,
        userMessageId: lastUserMessage?.id,
      })
    }
    if (operation === 'prompt') {
      telemetry?.startPhase('persist_user_message')
      // Hydration supplies a durable prefix, and historical edits save themselves.
      // Keep the predecessor too: the SDK does not await the previous onFinish,
      // so its assistant row may still need inserting before the new user's parent is set.
      await saveMessages({ id, messages: requestMessages.slice(-2) })
      telemetry?.endPhase('persist_user_message')
    }

    // Persist by `id`, not `chatThread.id`: on a brand-new chat the session's
    // `chatThread` snapshot is still `null` here (PowerSync hasn't re-hydrated
    // it yet), but `saveMessages` above just created the `chat_threads` row —
    // so keying off `chatThread` would silently drop the fresh ACP id and
    // break resume/load on the next reconnect. `id` is that same row's id.
    const persistAcpSessionId = async (newSessionId: string): Promise<void> => {
      await updateChatThread(getDb(), id, { acpSessionId: newSessionId })
    }

    // Surface `connecting` only when routing to a different agent than this
    // thread last used — a warm cache resolves instantly, but the per-thread
    // UI still needs the transition for the cold-connect spinner.
    const isNewAgent = selectedAgent.id !== routedAgentId
    if (isNewAgent) {
      useChatStore.getState().updateSession(id, { connectionStatus: 'connecting', connectionError: null })
    }

    telemetry?.startPhase('adapter_connect')
    const adapter = await getOrConnectAdapter(
      selectedAgent,
      { httpClient, getProxyFetch, onAvailableCommands: makeCommandSink(selectedAgent.id) },
      { connectToAgent: deps.connectToAgent },
    ).catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err))
      useChatStore.getState().updateSession(id, { connectionStatus: 'error', connectionError: error })
      throw error
    })
    telemetry?.endPhase('adapter_connect')

    routedAgentId = selectedAgent.id
    if (isNewAgent) {
      useChatStore.getState().updateSession(id, { connectionStatus: 'ready', connectionError: null })
    }

    // Built-in re-resolves skill instructions itself (ai/fetch.ts); for ACP
    // agents we resolve here and fold them into the prompt via the adapter.
    const skillInstructions = isBuiltInAgent(selectedAgent)
      ? undefined
      : await resolveAcpSkillInstructions(requestMessages)
    // Same split for project context: built-in builds it in `ai/fetch.ts`, so
    // without this a chat in a project silently lost its instructions and
    // knowledge the moment it was answered by a remote or managed agent.
    // Gated on the session's own `projectId` so a chat outside a project — the
    // common case — never pays for the lookup.
    const projectSection =
      isBuiltInAgent(selectedAgent) || !session.projectId ? undefined : await resolveAcpProjectSection(id)
    const requestPermission = (request: RequestPermissionRequest, signal?: AbortSignal) =>
      requestPermissionViaStore(id, selectedAgent.id, request, signal ?? init.signal, !isBuiltInAgent(selectedAgent))

    const turnBudget = getTurnBudget().consumer
    if (operation === 'prompt' && !turnBudget.tryConsumeRequest()) {
      telemetry?.recordRetry({
        layer: 'turn_budget',
        reason: 'request_budget_exhausted',
        attempt: routingState.getAttempt?.() ?? 1,
      })
      if (debugTranscriptTraceId) {
        recordDebugTranscriptRetry(
          id,
          debugTranscriptTraceId,
          'request_budget_exhausted',
          routingState.getAttempt?.() ?? 1,
        )
      }
      throw createTurnBudgetExhaustedError()
    }

    // Sync and other tabs can change access without updating this tab's model snapshot.
    if (isBuiltInAgent(selectedAgent)) {
      useChatStore.getState().setModels(await getAvailableModels())
    }
    const runnableModel = requireRunnableModel(selectedAgent, selectedModel)
    const currentThread = useChatStore.getState().sessions.get(id)?.chatThread ?? chatThread
    if (isBuiltInAgent(selectedAgent) && !matchesThreadConfidentiality(runnableModel, currentThread)) {
      throw new ModelAccessError(t`This model no longer matches the conversation’s privacy setting.`)
    }
    const context: AgentAdapterContext = {
      threadId: id,
      chatThread: currentThread,
      acpSessionId: currentThread?.acpSessionId ?? null,
      saveMessages,
      selectedModel: runnableModel,
      reasoningEffort,
      mcpClients,
      reconnectClient,
      httpClient,
      getProxyFetch,
      turnBudget,
      telemetry,
      debugTranscriptTraceId,
      webToolBudget: getWebToolBudget(requestMessages),
      regenerationRevision: routingState.regenerationRevision ?? 0,
      skillInstructions,
      projectSection,
      onAcpSessionId: persistAcpSessionId,
      requestPermission,
      execution: isBuiltInAgent(selectedAgent)
        ? session.projectId
          ? await getProjectExecution(getDb(), session.projectId)
          : getAgentExecution(id)
        : undefined,
      workspaceId: session.projectId ? `project-${session.projectId}` : id,
      projectId: session.projectId ?? undefined,
      onSessionSideEffect: applySessionSideEffect,
      getAcpCompactions: session.chatInstance.getAcpCompactions,
      onAcpSessionEvent: session.chatInstance.onAcpSessionEvent,
      // Manual compaction reports success only after the checkpoint is saved below.
      onCompactionStatus:
        operation === 'prompt'
          ? (compactionStatus) => useChatStore.getState().updateSession(id, { compactionStatus })
          : undefined,
    }
    const modelInit = {
      ...init,
      body: JSON.stringify({
        ...requestBody,
        messages: withStoppedReplyMarkers(requestMessages, { includeLatestPrompt: operation === 'compact' }),
      }),
    }
    return { adapter, context, init: modelInit }
  }

  return Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      const route = await resolve(init, 'prompt')
      const response = await route.adapter.fetch(route.init, route.context)
      return wrapResponseForFirstContent(response, route.context.telemetry)
    },
    {
      preconnect: () => Promise.resolve(false),
      compact: async (messages: ThunderboltUIMessage[], instructions: string | undefined, signal: AbortSignal) => {
        const route = await resolve({ body: JSON.stringify({ messages }), signal }, 'compact')
        if (!route.adapter.compact) {
          throw new Error('This agent does not support context compaction')
        }
        return route.adapter.compact(route.init, route.context, instructions)
      },
    },
  )
}

const recordMessageTelemetry = (telemetry: TurnTelemetry, message: ThunderboltUIMessage): void => {
  const reasoningTime = message.metadata?.reasoningTime ?? {}
  for (const part of message.parts) {
    if (telemetry.getEngine() === 'pi' && part.type === 'step-start') {
      telemetry.recordStep()
      continue
    }
    if (!('toolCallId' in part)) {
      continue
    }
    const toolName = part.type === 'dynamic-tool' ? 'mcp' : part.type.replace(/^tool-/, '')
    const duration = toolDurationSchema.safeParse(reasoningTime[part.toolCallId])
    if (duration.success) {
      telemetry.recordTool(toolName, duration.data)
    }
  }
}

/** Stream framing alone is not a reply; usage-only metadata still needs persistence. */
const isEmptyAssistantMessage = (message: ThunderboltUIMessage | undefined): boolean =>
  message?.role === 'assistant' && !message.parts.some((part) => part.type !== 'step-start') && !message.metadata

/** A reasoning part still mid-stream keeps its spinner running (reasoning-group.tsx)
 *  even after the turn settles — true when an aborted turn stopped during thinking. */
const hasStreamingReasoning = (message: ThunderboltUIMessage | undefined): boolean =>
  !!message?.parts?.some((part) => part.type === 'reasoning' && part.state === 'streaming')

/** Mark every still-streaming reasoning part `done` so its spinner stops. */
const finalizeReasoning = (message: ThunderboltUIMessage): ThunderboltUIMessage => ({
  ...message,
  parts: message.parts.map((part) =>
    part.type === 'reasoning' && part.state === 'streaming' ? { ...part, state: 'done' as const } : part,
  ),
})

type ChatMessageInput = Parameters<Chat<ThunderboltUIMessage>['sendMessage']>[0]

/** Extract user-authored text across both AI SDK message input shapes. */
const getPromptText = (message: ChatMessageInput): string => {
  if (!message) {
    return ''
  }
  if ('parts' in message && message.parts) {
    return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  if ('text' in message) {
    return message.text ?? ''
  }
  return ''
}

/** Count user-authored text across both AI SDK message input shapes. */
const getPromptLength = (message: ChatMessageInput): number => getPromptText(message).length

const inFlightTurnMarkersSchema = z.array(
  z.object({
    traceId: z.string().min(1),
    startedAt: z.number().finite(),
  }),
)

type InFlightTurnMarker = z.infer<typeof inFlightTurnMarkersSchema>[number]

type InFlightTurnStorage = {
  clear: (traceId: string) => void
  mark: (traceId: string) => void
  recover: (trackEvent: typeof defaultTrackEvent) => void
}

/**
 * Persist privacy-safe turn markers for reload recovery in the current tab.
 * Multiple markers preserve overlapping turns while an older final save settles.
 */
const createInFlightTurnStorage = (chatId: string): InFlightTurnStorage => {
  const storageKey = `thunderbolt_chat_turn_in_flight:${chatId}`
  const read = (): InFlightTurnMarker[] => {
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (!raw) {
        return []
      }
      const parsed = inFlightTurnMarkersSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        return parsed.data
      }
      sessionStorage.removeItem(storageKey)
      return []
    } catch {
      return []
    }
  }
  const write = (markers: InFlightTurnMarker[]): void => {
    try {
      if (markers.length === 0) {
        sessionStorage.removeItem(storageKey)
        return
      }
      sessionStorage.setItem(storageKey, JSON.stringify(markers))
    } catch {
      // Telemetry recovery is best-effort when tab storage is unavailable.
    }
  }

  return {
    clear: (traceId) => {
      const markers = read()
      const remaining = markers.filter((marker) => marker.traceId !== traceId)
      if (remaining.length !== markers.length) {
        write(remaining)
      }
    },
    mark: (traceId) => {
      const markers = read()
      if (markers.some((marker) => marker.traceId === traceId)) {
        return
      }
      write([...markers, { traceId, startedAt: Date.now() }])
    },
    recover: (trackEvent) => {
      const markers = read()
      if (markers.length === 0) {
        return
      }
      write([])
      for (const marker of markers) {
        trackEvent('chat_turn_completed', {
          trace_id: marker.traceId,
          outcome: 'abort',
          total_ms: Math.max(0, Math.round(Date.now() - marker.startedAt)),
        })
      }
    },
  }
}

type TurnModelProperties = { model_id: string; model_name: string; provider: string }

type TurnState = {
  model: Model | undefined
  telemetry: TurnTelemetry | undefined
  releaseBrowserControl: (() => void) | undefined
  modelProperties: TurnModelProperties | undefined
  traceId: string | undefined
  engine: DebugTranscriptEngine | undefined
  agentId: string | undefined
  completed: boolean
}

/** Create isolated telemetry state for one chat turn. */
const createTurnState = (): TurnState => ({
  model: undefined,
  telemetry: undefined,
  releaseBrowserControl: undefined,
  modelProperties: undefined,
  traceId: undefined,
  engine: undefined,
  agentId: undefined,
  completed: false,
})

/** End only this turn's browser activity, including when final persistence fails. */
const releaseBrowserControl = (turn: TurnState): void => {
  turn.releaseBrowserControl?.()
  turn.releaseBrowserControl = undefined
}

const getTraceProperties = (telemetry: TurnTelemetry | undefined) => ({
  trace_id: telemetry?.traceId,
  engine: telemetry?.getEngine(),
})

const getTurnContextProperties = (
  telemetry: TurnTelemetry | undefined,
  modelProperties: TurnModelProperties | undefined,
) => ({ ...getTraceProperties(telemetry), ...modelProperties })

/**
 * Create one chat instance with retry state and request budget scoped to its
 * closure. New, successful, and aborted turns replace the budget while
 * automatic retries preserve it.
 */
export const createChatInstance = (
  id: string,
  messages: ThunderboltUIMessage[],
  saveMessages: SaveMessagesFunction,
  httpClient: HttpClient,
  getProxyFetch: () => FetchFn,
  deps: CreateChatInstanceDeps = {},
) => {
  const createTurnBudget = deps.createTurnBudget ?? defaultCreateTurnBudget
  const createTurnTelemetry = deps.createTurnTelemetry ?? defaultCreateTurnTelemetry
  const trackEvent = deps.trackEvent ?? defaultTrackEvent
  const wakeAdapterReconnect = deps.wakeAdapterReconnect ?? defaultWakeAdapterReconnect
  const inFlightTurns = createInFlightTurnStorage(id)
  inFlightTurns.recover(trackEvent)
  let turnBudget = createTurnBudget()
  let currentTurn = createTurnState()
  /** Capture immutable model dimensions and built-in telemetry for one turn. */
  const initializeTurnForCurrentSession = (turn: TurnState): void => {
    const session = useChatStore.getState().sessions.get(id)
    // selectedModel is non-null only by type — hydration and stale sessions can
    // violate it, and sendMessage's friendly guard runs after startNewTurn().
    if (!session?.selectedModel) {
      return
    }
    turn.model = session.selectedModel
    turn.modelProperties = {
      model_id: session.selectedModel.id,
      model_name: session.selectedModel.model,
      provider: session.selectedModel.provider,
    }
    turn.agentId = session.selectedAgent.id
    if (!isBuiltInAgent(session.selectedAgent)) {
      turn.engine = debugTranscriptEngineFor(session.selectedAgent, undefined)
      turn.traceId = uuidv7()
      return
    }
    turn.telemetry = createTurnTelemetry()
    turn.releaseBrowserControl = browserController.startAgentTurn(turn.telemetry.traceId)
    turn.engine = 'legacy'
    turn.traceId = turn.telemetry.traceId
    turn.telemetry.setDimensions({
      modelId: session.selectedModel.id,
      modelName: session.selectedModel.model,
      provider: session.selectedModel.provider,
    })
  }
  /** Lazily cover automatically submitted turns that bypass the send override. */
  const getOrCreateTurnTelemetry = (): TurnTelemetry | undefined => {
    if (!currentTurn.modelProperties) {
      initializeTurnForCurrentSession(currentTurn)
    }
    const { telemetry } = currentTurn
    if (telemetry) {
      inFlightTurns.mark(telemetry.traceId)
    }
    return telemetry
  }
  /** Lazily initialize the correlated trace for built-in and ACP turns. */
  const getOrCreateDebugTranscriptTraceId = (): string | undefined => {
    if (!currentTurn.modelProperties) {
      initializeTurnForCurrentSession(currentTurn)
    }
    return currentTurn.traceId
  }
  let retryCount = 0
  let retryTimeout: ReturnType<typeof setTimeout> | null = null
  let lastError: Error | null = null
  const getAttemptsMade = (): number => attemptsMadeFromCompletedRetries(retryCount)
  const routingState: AgentRoutingState = {
    regenerationRevision: 0,
    webToolBudgetRevision: 0,
    getTurnBudget: () => turnBudget,
    getTurnTelemetry: getOrCreateTurnTelemetry,
    getDebugTranscriptTraceId: getOrCreateDebugTranscriptTraceId,
    getAttempt: getAttemptsMade,
    getTurnModel: () => {
      if (!currentTurn.model) {
        initializeTurnForCurrentSession(currentTurn)
      }
      return currentTurn.model
    },
  }
  const customFetch = createAgentRoutingFetch(id, saveMessages, httpClient, getProxyFetch, deps, routingState)
  const createChat = deps.createChat ?? ((init: ChatInit<ThunderboltUIMessage>) => new Chat(init))

  const debugMetadataForTurn = (turn: TurnState): DebugTranscriptMessageMetadataV1 | null => {
    const { traceId, modelProperties, agentId } = turn
    const engine = turn.telemetry?.getEngine() ?? turn.engine
    if (!traceId || !modelProperties || !agentId || !engine) {
      return null
    }
    return {
      traceId,
      engine,
      modelId: modelProperties.model_id,
      modelName: modelProperties.model_name,
      provider: modelProperties.provider,
      agentId,
    }
  }

  const withDebugMetadata = (turn: TurnState, message: ThunderboltUIMessage): ThunderboltUIMessage => {
    if (!isDebugTranscriptCaptureEnabled()) {
      return message
    }
    const debugTranscript = debugMetadataForTurn(turn)
    if (!debugTranscript) {
      return message
    }
    return {
      ...message,
      metadata: {
        ...message.metadata,
        debugTranscript,
      },
    }
  }

  const finishRecordedTurn = (turn: TurnState, outcome: DebugTranscriptTurnOutcome): void => {
    const metadata = debugMetadataForTurn(turn)
    if (metadata?.engine) {
      finishDebugTranscriptTurn(id, metadata.traceId, outcome, metadata.engine)
    }
  }

  /** Set by `stop`, cleared when the user starts the next turn. Suppresses the
   *  SDK's automatic re-send — see `sendAutomaticallyWhen` below. */
  let stopRequested = false

  const emitTurnCompleted = (
    turn: TurnState,
    outcome: 'success' | 'error' | 'abort',
    message?: ThunderboltUIMessage,
  ) => {
    releaseBrowserControl(turn)
    if (turn.completed) {
      return
    }
    turn.completed = true
    const { telemetry } = turn
    if (telemetry) {
      if (message) {
        recordMessageTelemetry(telemetry, message)
      }
      trackEvent('chat_turn_completed', telemetry.buildPayload(outcome))
      inFlightTurns.clear(telemetry.traceId)
    }
    finishRecordedTurn(turn, outcome)
  }

  /** Clear retry state and replace the completed turn's request budget. */
  const resetRetryStateForNewTurn = () => {
    releaseBrowserControl(currentTurn)
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    turnBudget = createTurnBudget()
    routingState.webToolBudgetRevision = (routingState.webToolBudgetRevision ?? 0) + 1
    routingState.webToolBudgetState = undefined
    retryCount = 0
    lastError = null
    currentTurn = createTurnState()
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
  }

  /** Set or clear the stop flag on the latest prompt, which later turns turn into a stop marker
   *  (see `withStoppedReplyMarkers`). Returns the changed prompt, or nothing if it was already set. */
  const setPromptStopped = (stoppedByUser: boolean): ThunderboltUIMessage | undefined => {
    const index = instance.messages.findLastIndex((message) => message.role === 'user')
    const prompt = instance.messages[index]
    if (!prompt || Boolean(prompt.metadata?.stoppedByUser) === stoppedByUser) {
      return undefined
    }
    const updated: ThunderboltUIMessage = { ...prompt, metadata: { ...prompt.metadata, stoppedByUser } }
    instance.messages = instance.messages.map((message, i) => (i === index ? updated : message))
    return updated
  }

  const startNewTurn = () => {
    resetRetryStateForNewTurn()
    // Only an explicit send/regenerate lifts the Stop suppression — `onFinish`
    // runs `resetRetryStateForNewTurn` on the aborted turn itself, and clearing
    // the flags there would re-open the auto-sends they exist to block (the
    // SDK's `sendAutomaticallyWhen` and `useChatAutomation`'s auto-run).
    stopRequested = false
    useChatStore.getState().updateSession(id, { stopping: false, compactionStatus: 'idle' })
    initializeTurnForCurrentSession(currentTurn)
  }

  /** Stop retrying this turn and record why it stopped. */
  const markRetriesExhausted = (turn: TurnState, reason: string = getChatErrorKind(lastError) ?? 'unknown') => {
    trackEvent('chat_retries_exhausted', {
      reason,
      attempts: retryCount + 1,
      ...getTurnContextProperties(turn.telemetry, turn.modelProperties),
    })
    emitTurnCompleted(turn, 'error')
    useChatStore.getState().updateSession(id, { retriesExhausted: true })
  }

  const pendingAcpEvents: AcpSessionEvent[] = []
  let acpSave: Promise<void> | undefined
  const pendingFinishes = new Set<Promise<void>>()
  let lastFinish = Promise.resolve()
  /** A replaced agent/session must not overwrite the current context meter. */
  const acceptsAcpEvent = (event: AcpSessionEvent): boolean => {
    if (event.type !== 'usage') {
      return true
    }
    const agentId = useChatStore.getState().sessions.get(id)?.selectedAgent.id
    const activeSession = agentId && useAcpSessionStore.getState().sessions.get(sessionConfigKey(agentId, id))
    return agentId === event.usage.agentId && (!activeSession || activeSession.sessionId === event.usage.sessionId)
  }
  /** Serialize idle/replayed patches so an older snapshot cannot win the final write. */
  const saveAcpEvent = (event: AcpSessionEvent, inPrompt: boolean): boolean => {
    if (!acceptsAcpEvent(event)) {
      return true
    }
    const applied = applyAcpSessionEvent(instance.messages, event, inPrompt)
    if (!applied) {
      return false
    }
    instance.messages = applied.messages
    const previous = acpSave
    acpSave = (async () => {
      await previous
      await saveMessages({ id, messages: [applied.changed], updateContext: event.type === 'usage' })
    })().catch((error: unknown) => console.error('Could not save ACP session update:', error))
    return true
  }
  const onAcpSessionEvent = (event: AcpSessionEvent, inPrompt: boolean, replaying = false): boolean => {
    if (!acceptsAcpEvent(event)) {
      return true
    }
    // The stream may still be draining after the remote prompt settles. Apply
    // late patches after onFinish, once the SDK has stopped replacing its message.
    const streamDraining = instance.status === 'streaming' || instance.status === 'submitted'
    const deferred = pendingFinishes.size > 0 || (!inPrompt && !replaying && streamDraining)
    if (!deferred) {
      return saveAcpEvent(event, inPrompt)
    }
    if (inPrompt && !applyAcpSessionEvent(instance.messages, event, true)) {
      return false
    }
    pendingAcpEvents.push(event)
    return true
  }
  const finishWithAcpEvents =
    (finish: ChatOnFinishCallback<ThunderboltUIMessage>): ChatOnFinishCallback<ThunderboltUIMessage> =>
    (result) => {
      const finishing: Promise<void> = Promise.resolve(finish(result)).finally(async () => {
        try {
          while (pendingFinishes.size === 1 && pendingAcpEvents.length > 0) {
            for (const event of pendingAcpEvents.splice(0)) {
              saveAcpEvent(event, false)
            }
            await acpSave
          }
        } finally {
          pendingFinishes.delete(finishing)
        }
      })
      pendingFinishes.add(finishing)
      lastFinish = finishing
      return finishing
    }
  /** Older turns may still be saving after a newer turn has already finished. */
  const waitForFinishes = async (): Promise<void> => {
    while (pendingFinishes.size > 0) {
      await Promise.all(pendingFinishes)
    }
  }
  /** Keep replay/idle event writes before the next user turn in the saved timeline. */
  const waitForSessionUpdates = async (): Promise<void> => {
    const hasAcpEvents = pendingAcpEvents.length > 0 || getAcpCompactions(instance.messages).length > 0
    if (hasAcpEvents) {
      await waitForFinishes()
    }
    await acpSave
  }

  const instance = createChat({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for
    // automations). The SDK evaluates this after every turn and gates it on
    // `isError` only — not on `isAbort` — so a stopped turn whose assistant
    // message never materialized (Stop pressed while `submitted`) leaves the
    // user message trailing. The stopRequested guard prevents resending it.
    sendAutomaticallyWhen: ({ messages }) =>
      !stopRequested &&
      messages.length > 0 &&
      messages[messages.length - 1].role === 'user' &&
      !messages[messages.length - 1].metadata?.acpCommand,
    onFinish: finishWithAcpEvents(async ({ message, isError, isAbort }) => {
      const finishedTurn = currentTurn
      if (isAbort || (!isError && message && !isEmptyAssistantMessage(message))) {
        releaseBrowserControl(finishedTurn)
      }
      const resetRetryStateIfUnswapped = () => {
        if (currentTurn !== finishedTurn) {
          return
        }
        resetRetryStateForNewTurn()
      }
      /** Persist the terminal snapshot independently of mounted UI subscribers. */
      const saveFinalMessage = async (completedMessage: ThunderboltUIMessage) => {
        finishedTurn.telemetry?.startPhase('final_save')
        try {
          await saveMessages({ id, messages: [completedMessage] })
        } catch (error) {
          releaseBrowserControl(finishedTurn)
          throw error
        }
        finishedTurn.telemetry?.endPhase('final_save')
      }

      if (isAbort) {
        // Settle the aborted turn so no spinner survives the stop,
        // keyed off the trailing assistant message.
        const lastIndex = instance.messages.length - 1
        const lastMessage = instance.messages[lastIndex]
        const completedMessage = message ? withDebugMetadata(finishedTurn, message) : undefined

        if (isEmptyAssistantMessage(lastMessage)) {
          // Stopped after the turn opened but before it produced anything (the
          // model's first turn hadn't begun). The shell renders as an empty-turn
          // recovery spinner that nothing will ever recover, so drop it.
          //
          // Load-bearing: this is only safe because `stopRequested` gates
          // `sendAutomaticallyWhen`. Dropping the shell leaves the user message
          // trailing, and the SDK re-checks that predicate the moment this
          // request unwinds — ungated, the stopped turn re-sends itself.
          instance.messages = instance.messages.slice(0, -1)
        } else if (hasStreamingReasoning(lastMessage)) {
          // Stopped mid-reasoning: the reasoning part is left `streaming`, so its
          // spinner never stops. Finalize it in the live list and the saved copy.
          const finalized = withDebugMetadata(finishedTurn, finalizeReasoning(lastMessage!))
          const next = instance.messages.slice()
          next[lastIndex] = finalized
          instance.messages = next
          await saveFinalMessage(finalized)
        } else if (message && !isEmptyAssistantMessage(message)) {
          // Stopped mid-answer: persist the partial. Streaming partial saves are
          // throttled and their pending trailing write is cancelled the moment
          // streaming stops (see SavePartialAssistantMessagesHandler), so onFinish
          // is the authoritative final save on abort — without this the last
          // streamed chunk would be lost on reload.
          await saveFinalMessage(completedMessage!)
        }
        emitTurnCompleted(finishedTurn, 'abort', completedMessage)
        resetRetryStateIfUnswapped()
        return
      }

      // Handle successful responses with content or usage metadata.
      if (!isError && message && !isEmptyAssistantMessage(message)) {
        const completedMessage = withDebugMetadata(finishedTurn, message)
        if (retryCount > 0) {
          trackEvent('chat_retry_success', {
            attempts: retryCount + 1,
            ...getTurnContextProperties(finishedTurn.telemetry, finishedTurn.modelProperties),
          })
        }

        const { sessions } = useChatStore.getState()

        const session = sessions.get(id)

        if (!session) {
          throw new Error('No session found')
        }

        await saveFinalMessage(completedMessage)

        trackEvent('chat_receive_reply', {
          ...finishedTurn.modelProperties,
          length: completedMessage.parts.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0),
          reply_number: instance.messages.length + 1,
          ...getTraceProperties(finishedTurn.telemetry),
        })

        emitTurnCompleted(finishedTurn, 'success', completedMessage)
        resetRetryStateIfUnswapped()
        return
      }

      // Background chats have no mounted partial-save subscriber. Persist the
      // final error snapshot here too, before retrying or leaving the turn idle.
      // Keep a visible empty failed reply too, so reload cannot auto-run its
      // trailing prompt. Silent commands never create that live assistant row.
      if (
        isError &&
        message &&
        (!isEmptyAssistantMessage(message) ||
          instance.messages.some((item) => item.role === 'assistant' && item.id === message.id))
      ) {
        const completedMessage = withDebugMetadata(finishedTurn, finalizeReasoning(message))
        instance.messages = instance.messages.map((item) => (item.id === message.id ? completedMessage : item))
        await saveFinalMessage(completedMessage)
        if (currentTurn !== finishedTurn) {
          emitTurnCompleted(finishedTurn, 'error', completedMessage)
          return
        }
      }

      // Agent commands may finish silently. Retrying a compaction command can
      // compact twice; only an explicit user action should send it again.
      if (instance.messages.findLast((item) => item.role === 'user')?.metadata?.acpCommand) {
        if (isError) {
          markRetriesExhausted(finishedTurn)
        } else {
          emitTurnCompleted(finishedTurn, 'success', message)
          resetRetryStateIfUnswapped()
        }
        return
      }

      // A transport loss may have interrupted the turn after the agent performed
      // side effects. Only the user may choose to submit it again.
      if (getChatErrorKind(lastError) === 'connection-lost') {
        markRetriesExhausted(finishedTurn)
        return
      }

      // A model that rejects tools rejects the identical retry too.
      if (isToolSupportRejectionError(lastError)) {
        markRetriesExhausted(finishedTurn)
        return
      }

      // The hosted agent refuses a turn while the previous reply still runs. That
      // clears on its own, so it takes the retry loop below on a longer delay.
      const isRunInProgress = isAgentRunInProgressError(lastError)

      // Don't auto-retry rate limit errors — retrying immediately makes it worse
      if (isRateLimitError(lastError) && !isRunInProgress) {
        markRetriesExhausted(finishedTurn)
        lastError = null
        return
      }

      // Don't burn retries on errors that won't succeed on identical input:
      // context overflow, or anything the provider marks non-retryable (4xx
      // content/auth errors, unsupported content). Transient errors — 408/409,
      // 5xx, network — keep `isRetryable !== false` and fall through to the retry
      // loop. (The "Retrying…" UI on a deterministic error would be a lie.)
      //
      // Content rejections (400/422) are excluded too, even when the provider
      // leaves `isRetryable` undefined: they're owned by the attachment-remediation
      // layer, which re-delivers (native→text→images) on its own. Retrying the
      // identical payload here would overlap remediation's regenerate() and can't
      // succeed anyway. Remediation surfaces the error itself once the ladder is
      // exhausted, so bailing here doesn't swallow it.
      if (
        isProjectAgentUnavailableError(lastError) ||
        isContextOverflowError(lastError) ||
        isContentRejectionError(lastError) ||
        getErrorRetryable(lastError) === false
      ) {
        markRetriesExhausted(finishedTurn)
        return
      }

      // Regeneration discards this attempt's research history. Once its web
      // budget is spent, keep the partial response and let the user choose Retry.
      if (routingState.webToolBudgetState?.budget.probe.isExhausted) {
        markRetriesExhausted(finishedTurn, 'web_budget_exhausted')
        return
      }

      const isEmptyTurn = !isError && !lastError && (!message || isEmptyAssistantMessage(message))
      const retryReason = getChatErrorKind(lastError) ?? (isEmptyTurn ? emptyResponseRetryReason : 'unknown')

      if (retryCount < maxRetries) {
        const attemptsMade = getAttemptsMade()
        if (turnBudget.probe.isExhausted) {
          finishedTurn.telemetry?.recordRetry({
            layer: 'turn_budget',
            reason: 'request_budget_exhausted',
            attempt: retryCount + 1,
          })
          if (finishedTurn.traceId) {
            recordDebugTranscriptRetry(id, finishedTurn.traceId, 'request_budget_exhausted', attemptsMade)
          }
          markRetriesExhausted(finishedTurn, retryReason)
          return
        }

        retryCount++
        useChatStore.getState().updateSession(id, { retryCount })
        console.info(`Auto-retrying (${retryCount}/${maxRetries})...`)

        const retryDelayMs = getTurnRetryDelay(retryCount, { isEmptyTurn, isRunInProgress })

        trackEvent('chat_auto_retry', {
          attempt: retryCount,
          max_retries: maxRetries,
          reason: retryReason,
          ...getTurnContextProperties(finishedTurn.telemetry, finishedTurn.modelProperties),
        })
        finishedTurn.telemetry?.recordRetry({
          layer: 'auto_retry',
          reason: retryReason,
          attempt: retryCount + 1,
        })
        if (finishedTurn.traceId) {
          recordDebugTranscriptRetry(id, finishedTurn.traceId, retryReason, attemptsMade)
        }

        retryTimeout = setTimeout(() => {
          retryTimeout = null
          const { sessions, currentSessionId } = useChatStore.getState()
          // Only retry if the session still exists AND is still the current active session.
          // This prevents retries from executing when the user has switched to a different thread.
          if (!sessions.has(id) || currentSessionId !== id) {
            finishRecordedTurn(finishedTurn, 'abort')
            resetRetryStateForNewTurn()
            useChatStore.getState().updateSession(id, { retriesExhausted: true })
            return
          }
          regenerateResponse().catch((err) => {
            console.error('Auto-retry failed:', err)
            // Don't set retriesExhausted here - let onFinish handle retry logic.
            // When originalRegenerate() fails, onFinish will be called again and will
            // either schedule another retry (if retryCount < maxRetries) or set
            // retriesExhausted: true (if retries are exhausted).
          })
        }, retryDelayMs)
      } else {
        markRetriesExhausted(finishedTurn, retryReason)
      }
    }),
    // Retry logic lives in onFinish (the SDK's finally block), not here.
    // Adding retries to onError caused infinite loops in earlier iterations
    // because onFinish resets state that onError depends on. If onFinish
    // somehow doesn't fire, chatError is set by the SDK and retryCount
    // stays at 0, so the UI shows the Retry button immediately.
    onError: (error) => {
      console.error('Chat error:', error)
      lastError = error instanceof Error ? error : new Error(String(error))
      currentTurn.telemetry?.recordError(getChatErrorKind(lastError) ?? lastError.name)
      if (currentTurn.traceId) {
        recordDebugTranscriptFailure(id, currentTurn.traceId, {
          errorClass: lastError.name,
          message: lastError.message,
        })
      }
      trackEvent('chat_turn_error', {
        kind: getChatErrorKind(lastError) ?? 'unknown',
        error_name: getErrorName(lastError),
        status: getErrorStatusCode(lastError),
        retryable: getErrorRetryable(lastError),
        ...getTurnContextProperties(currentTurn.telemetry, currentTurn.modelProperties),
      })
    },
  })

  const originalRegenerate = instance.regenerate.bind(instance)

  /** Manual retries can choose a new model; automatic retries retain this logical turn's model. */
  const stampRetryModel = () => {
    // `selectedModel` can be missing at runtime; the send path guards it the same way.
    const modelId = routingState.getTurnModel?.()?.id
    const index = instance.messages.findLastIndex((message) => message.role === 'user')
    const prompt = instance.messages[index]
    if (!modelId || !prompt || prompt.metadata?.modelId === modelId) {
      return
    }
    const next = instance.messages.slice()
    next[index] = { ...prompt, metadata: { ...prompt.metadata, modelId } }
    instance.messages = next
  }

  /** Mark and start one response regeneration so persistent agents rebuild from
   *  the request transcript while ordinary sends keep their live session. */
  const regenerateResponse = (): Promise<void> => {
    routingState.regenerationRevision = (routingState.regenerationRevision ?? 0) + 1
    stampRetryModel()
    // A new attempt at the prompt; the request saves the cleared flag with the other messages.
    setPromptStopped(false)
    return originalRegenerate()
  }

  // Reset retry count on manual regenerate (Retry button) so auto-retries work again
  instance.regenerate = async function () {
    assertNotCompacting()
    await waitForSessionUpdates()
    assertNotCompacting()
    startNewTurn()
    getOrCreateTurnTelemetry()
    const agentId = useChatStore.getState().sessions.get(id)?.selectedAgent.id
    if (agentId) {
      wakeAdapterReconnect(agentId)
    }
    return regenerateResponse()
  }

  const compaction = { controller: null as AbortController | null }
  const assertNotCompacting = () => {
    if (compaction.controller) {
      throw new Error('Wait for context compaction to finish')
    }
  }

  const compactContext = async (instructions?: string): Promise<void> => {
    assertNotCompacting()
    // The SDK marks a reply ready before its final save settles. Compaction
    // rewrites that same row. Recheck here, without another await before taking
    // ownership, because a new save can start while earlier writes settle.
    for (;;) {
      const latestAcpSave = acpSave
      await Promise.all([...pendingFinishes, latestAcpSave])
      if (pendingFinishes.size === 0 && acpSave === latestAcpSave) {
        break
      }
    }
    assertNotCompacting()
    if (instance.status === 'streaming' || instance.status === 'submitted' || retryTimeout) {
      throw new Error('Wait for the current response to finish before compacting')
    }
    const session = useChatStore.getState().sessions.get(id)
    if (!session) {
      throw new Error('No session found')
    }
    if (!isBuiltInAgent(session.selectedAgent)) {
      const command = useAcpSessionStore
        .getState()
        .sessions.get(sessionConfigKey(session.selectedAgent.id, id))
        ?.commands.find((item) => item.name === 'compact')
      if (!command) {
        throw new Error('This agent does not support context compaction')
      }
      const focus = command.inputHint !== undefined ? instructions?.trim() : undefined
      await instance.sendMessage({
        text: focus ? `/compact ${focus}` : '/compact',
        metadata: { acpCommand: 'compact' },
      })
      await lastFinish
      if (instance.error) {
        throw instance.error
      }
      return
    }
    const sourceMessages = instance.messages
    // Keep unanswered user turns outside the checkpoint so Retry can replay them
    // verbatim without discarding the summary or sending them twice.
    const boundaryIndex = sourceMessages.findLastIndex(hasAssistantContent)
    const messagesToCompact = sourceMessages.slice(0, boundaryIndex + 1)
    const lastMessage = messagesToCompact.at(-1)
    if (!lastMessage) {
      throw new Error('Nothing to compact')
    }
    if (session.chatThread && !matchesThreadConfidentiality(session.selectedModel, session.chatThread)) {
      throw new Error('The selected model does not match the conversation confidentiality')
    }
    const controller = new AbortController()
    compaction.controller = controller
    useChatStore.getState().updateSession(id, { compactionStatus: 'compacting' })
    try {
      const checkpoint = await customFetch.compact(messagesToCompact, instructions, controller.signal)
      controller.signal.throwIfAborted()
      if (instance.messages !== sourceMessages) {
        throw new Error('The conversation changed during compaction. Please try again.')
      }
      const updated = {
        ...lastMessage,
        metadata: { ...lastMessage.metadata, contextCompaction: checkpoint, contextTokens: checkpoint.contextTokens },
      }
      await saveMessages({ id, messages: [updated] })
      instance.messages = instance.messages.map((message) => (message.id === updated.id ? updated : message))
      useChatStore.getState().updateSession(id, { compactionStatus: 'compacted' })
    } catch (error) {
      useChatStore.getState().updateSession(id, { compactionStatus: 'idle' })
      throw error
    } finally {
      compaction.controller = null
    }
  }

  const originalSendMessage = instance.sendMessage.bind(instance)

  // Override the sendMessage method to check if the model is available for the chat thread
  instance.sendMessage = async function (message, options) {
    assertNotCompacting()
    await waitForSessionUpdates()
    assertNotCompacting()
    // Cancel any pending auto-retry and reset error state for the new message
    startNewTurn()

    const { sessions } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const { chatThread, selectedAgent, selectedModel } = session

    if (!selectedModel) {
      throw new Error('No selected model')
    }

    requireRunnableModel(selectedAgent, selectedModel)

    // The hosted agent doesn't use the selected model, and its threads are never
    // private, so the model/thread confidentiality lock doesn't apply to it.
    if (chatThread && !isHostedAgent(selectedAgent) && !matchesThreadConfidentiality(selectedModel, chatThread)) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    const telemetry = getOrCreateTurnTelemetry()
    getOrCreateDebugTranscriptTraceId()
    const debugTranscript = isDebugTranscriptCaptureEnabled() ? debugMetadataForTurn(currentTurn) : null
    const messageMetadata: NonNullable<ThunderboltUIMessage['metadata']> = {
      ...message?.metadata,
      modelId: selectedModel.id,
    }
    if (debugTranscript) {
      messageMetadata.debugTranscript = { ...debugTranscript, engine: null }
    }
    trackEvent('chat_send_prompt', {
      model_id: selectedModel.id,
      model_name: selectedModel.model,
      provider: selectedModel.provider,
      length: getPromptLength(message),
      prompt_number: instance.messages.length + 1,
      ...getTraceProperties(telemetry),
    })

    return originalSendMessage(
      {
        ...message,
        metadata: messageMetadata,
      } as ThunderboltUIMessage,
      options,
    )
  }

  const originalStop = instance.stop.bind(instance)

  /**
   * Stop the active turn and settle to idle. In-flight aborts let
   * `onFinish({ isAbort })` settle on the correct turn — emitting/resetting here
   * would swap `currentTurn` out from under it. Backoff/recovery fires no
   * `onFinish`, so cancel the retry, drop a trailing empty shell, and settle here.
   *
   * `stopRequested` outlives this call: the SDK re-checks `sendAutomaticallyWhen`
   * once the aborted request unwinds, and only an explicit send lifts it again.
   * The session's `stopping` flag mirrors it with the same lifetime, so
   * `useChatAutomation` sees the suppression too — dropping the aborted shell
   * leaves the user message trailing, exactly the shape that hook auto-runs.
   */
  instance.stop = async function () {
    releaseBrowserControl(currentTurn)
    compaction.controller?.abort()
    stopRequested = true
    // Mirrored into the store for the two reactive consumers: the composer's
    // stopping spinner (masked with a live request in `getTurnActivity`, so
    // lingering past settle is harmless) and `useChatAutomation`'s auto-run gate.
    useChatStore.getState().updateSession(id, { stopping: true })
    const inFlight = instance.status === 'streaming' || instance.status === 'submitted'
    // Voice mode also calls `stop` when nothing is running, so flag only a reply that was running or
    // waiting to retry. Flagged before the teardown, so a prompt sent meanwhile is never the one flagged.
    const stoppedPrompt = inFlight || retryTimeout !== null ? setPromptStopped(true) : undefined
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    // A turn stopped while its tool-permission dialog is open would leave the
    // dialog on screen awaiting an answer the cancelled turn will never use.
    // No-ops when nothing is pending.
    useChatStore.getState().resolvePendingPermission(id, { outcome: { outcome: 'cancelled' } })
    if (inFlight) {
      // Tearing the turn down is asynchronous — an ACP `session/cancel` is a
      // round-trip, and the in-browser harness has to unwind its loop — so the
      // `stopping` flag also tells the composer about the wait instead of
      // leaving the button looking inert.
      void originalStop()
    } else {
      if (isEmptyAssistantMessage(instance.messages[instance.messages.length - 1])) {
        instance.messages = instance.messages.slice(0, -1)
      }
      emitTurnCompleted(currentTurn, 'abort')
      resetRetryStateForNewTurn()
    }
    // Saved last, once the turn has settled, so a turn started meanwhile is never reset.
    if (stoppedPrompt) {
      await saveMessages({ id, messages: [stoppedPrompt] })
    }
  }

  return Object.assign(instance, {
    compactContext,
    getAcpCompactions: () => getAcpCompactions(instance.messages),
    onAcpSessionEvent,
  })
}
