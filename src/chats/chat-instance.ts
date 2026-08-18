/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { connectToAgent as defaultConnectToAgent } from '@/acp'
import {
  getOrConnectAdapter as defaultGetOrConnectAdapter,
  wakeAdapterReconnect as defaultWakeAdapterReconnect,
} from '@/acp/adapter-cache'
import type { AcpCommand, SessionSideEffect } from '@/acp/translators/acp-to-ai-sdk'
import { useAgentCommandsStore } from '@/acp/agent-commands-store'
import {
  createTurnBudget as defaultCreateTurnBudget,
  createTurnBudgetExhaustedError,
  type TurnBudget,
} from '@/ai/retry-budget'
import { createTurnTelemetry as defaultCreateTurnTelemetry, type TurnTelemetry } from '@/ai/turn-telemetry'
import { createWebToolBudget, resolveWebToolIntent, type WebToolBudget } from '@/ai/web-tool-budget'
import { updateChatThread as defaultUpdateChatThread } from '@/dal/chat-threads'
import { getAllSkills as defaultGetAllSkills } from '@/dal'
import { isBuiltInAgent } from '@/defaults/agents'
import { loadProjectContextForThread as defaultLoadProjectContext } from '@/projects/load-project-context'
import { buildProjectPromptSection } from '@/projects/project-prompt'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { getDb as defaultGetDb } from '@/db/database'
import {
  beginDebugTranscriptTurn,
  finishDebugTranscriptTurn,
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
  isContentRejectionError,
  isContextOverflowError,
  isRateLimitError,
} from '@/lib/error-utils'
import type { HttpClient } from '@/lib/http'
import { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { DefaultChatTransport, type ChatInit } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { deriveToolKey, findAllowOption, useChatStore } from './chat-store'

export const maxRetries = 3
const baseRetryDelayMs = 2000
const emptyTurnRetryDelayMs = 250

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Jitter prevents synchronized retries from overwhelming servers.
 */
const getRetryDelay = (attempt: number) => baseRetryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random())

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
): Promise<RequestPermissionResponse> => {
  const toolKey = deriveToolKey(request)
  const allowOption = findAllowOption(request.options)

  if (allowOption && useChatStore.getState().isAlwaysAllowed(agentId, toolKey)) {
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } })
  }

  return new Promise<RequestPermissionResponse>((resolve) => {
    const requestId = uuidv7()
    useChatStore.getState().setPendingPermission(sessionId, { agentId, requestId, request, resolve })
  })
}

/** Forward translator side effects to the chat store + analytics. The server
 *  is the source of truth for ACP-side mode and config option state, so a
 *  mode/config emit always wins over a stale optimistic UI update.
 *
 *  This branch ships the wire but no UI surface reads it yet — when a future
 *  PR adds ACP-mode UI it will subscribe to `agentSessionState` populated
 *  here. (ACP session modes are an agent-protocol concept, unrelated to the
 *  removed local chat-mode picker.) */
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
  getOrConnectAdapter?: typeof defaultGetOrConnectAdapter
  connectToAgent?: typeof defaultConnectToAgent
  updateChatThread?: typeof defaultUpdateChatThread
  getDb?: typeof defaultGetDb
  getAllSkills?: typeof defaultGetAllSkills
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
  getTurnBudget?: () => TurnBudget
  getTurnTelemetry?: () => TurnTelemetry | undefined
  getDebugTranscriptTraceId?: () => string | undefined
  getAttempt?: () => number
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
  const loadProjectContext = deps.loadProjectContext ?? defaultLoadProjectContext
  const getTurnBudget =
    routingState.getTurnBudget ??
    (() => {
      const turnBudget = (deps.createTurnBudget ?? defaultCreateTurnBudget)()
      return () => turnBudget
    })()

  let routedAgentId: string | null = null
  let webToolBudgetState: { key: string; budget: WebToolBudget } | undefined

  const getWebToolBudget = (messages: ThunderboltUIMessage[]): WebToolBudget | undefined => {
    const lastUserMessage = messages.findLast((message) => message.role === 'user')
    if (!lastUserMessage) {
      return undefined
    }
    const key = `${lastUserMessage.id}#${routingState.webToolBudgetRevision ?? 0}`
    if (webToolBudgetState?.key === key) {
      return webToolBudgetState.budget
    }
    const budget = createWebToolBudget(resolveWebToolIntent(extractLastUserText(messages)))
    webToolBudgetState = { key, budget }
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

  return Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        throw new Error('Missing init')
      }

      const { getMcpClients, reconnectClient, sessions } = useChatStore.getState()

      // Read clients fresh per send (not a hydrate-time snapshot) so a server
      // reconnected since the last send is seen with its current client.
      const mcpClients = getMcpClients()

      const session = sessions.get(id)

      if (!session) {
        throw new Error('No session found')
      }

      const { chatThread, selectedAgent, selectedModel } = session
      const telemetry = isBuiltInAgent(selectedAgent) ? routingState.getTurnTelemetry?.() : undefined
      telemetry?.setDimensions({
        modelId: selectedModel.id,
        modelName: selectedModel.model,
        provider: selectedModel.provider,
      })

      // Save the user message before invoking the adapter. This serves three
      // purposes that previously only the built-in pipeline got for free:
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
      const debugTranscriptTraceId = routingState.getDebugTranscriptTraceId?.()
      if (debugTranscriptTraceId) {
        const lastUserMessage = requestMessages.findLast((message) => message.role === 'user')
        beginDebugTranscriptTurn({
          threadId: id,
          traceId: debugTranscriptTraceId,
          engine: isBuiltInAgent(selectedAgent) ? (telemetry?.getEngine() ?? 'legacy') : 'acp',
          model: {
            id: selectedModel.id,
            name: selectedModel.model,
            provider: selectedModel.provider,
          },
          agentId: selectedAgent.id,
          userMessageId: lastUserMessage?.id,
        })
      }
      telemetry?.startPhase('persist_user_message')
      await saveMessages({ id, messages: requestMessages })
      telemetry?.endPhase('persist_user_message')

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
      // Built-in auto-run is a product decision restoring pre-#1032 behavior for all tools, including network-capable tools.
      const requestPermission = isBuiltInAgent(selectedAgent)
        ? undefined
        : (request: RequestPermissionRequest) => requestPermissionViaStore(id, selectedAgent.id, request)

      const turnBudget = getTurnBudget().consumer
      if (!turnBudget.tryConsumeRequest()) {
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

      const response = await adapter.fetch(init, {
        threadId: id,
        chatThread,
        acpSessionId: chatThread?.acpSessionId ?? null,
        saveMessages,
        selectedModel,
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
        onSessionSideEffect: applySessionSideEffect,
      })
      return wrapResponseForFirstContent(response, telemetry)
    },
    {
      preconnect: () => Promise.resolve(false),
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
  telemetry: TurnTelemetry | undefined
  modelProperties: TurnModelProperties | undefined
  traceId: string | undefined
  engine: DebugTranscriptEngine | undefined
  agentId: string | undefined
  completed: boolean
}

/** Create isolated telemetry state for one chat turn. */
const createTurnState = (): TurnState => ({
  telemetry: undefined,
  modelProperties: undefined,
  traceId: undefined,
  engine: undefined,
  agentId: undefined,
  completed: false,
})

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
    turn.modelProperties = {
      model_id: session.selectedModel.id,
      model_name: session.selectedModel.model,
      provider: session.selectedModel.provider,
    }
    turn.agentId = session.selectedAgent.id
    if (!isBuiltInAgent(session.selectedAgent)) {
      turn.engine = 'acp'
      turn.traceId = uuidv7()
      return
    }
    turn.telemetry = createTurnTelemetry()
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

  const emitTurnCompleted = (
    turn: TurnState,
    outcome: 'success' | 'error' | 'abort',
    message?: ThunderboltUIMessage,
  ) => {
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
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    turnBudget = createTurnBudget()
    routingState.webToolBudgetRevision = (routingState.webToolBudgetRevision ?? 0) + 1
    retryCount = 0
    lastError = null
    currentTurn = createTurnState()
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
  }

  const startNewTurn = () => {
    resetRetryStateForNewTurn()
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

  const instance = createChat({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message, isError, isAbort }) => {
      const finishedTurn = currentTurn
      const resetRetryStateIfUnswapped = () => {
        if (currentTurn !== finishedTurn) {
          return
        }
        resetRetryStateForNewTurn()
      }

      if (isAbort) {
        // Persist whatever streamed before the user hit Stop. Streaming partial
        // saves are throttled and their pending trailing write is cancelled the
        // moment streaming stops (see SavePartialAssistantMessagesHandler), so
        // onFinish is the authoritative final save on abort just as it is on
        // success — without this, the last streamed chunk of an aborted turn
        // would be lost on reload.
        const completedMessage = message ? withDebugMetadata(finishedTurn, message) : undefined
        if (completedMessage?.parts?.length) {
          finishedTurn.telemetry?.startPhase('final_save')
          await saveMessages({ id, messages: [completedMessage] })
          finishedTurn.telemetry?.endPhase('final_save')
        }
        emitTurnCompleted(finishedTurn, 'abort', completedMessage)
        resetRetryStateIfUnswapped()
        return
      }

      // Handle successful responses: message exists, no error, and has parts
      if (!isError && message && message.parts?.length) {
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

        finishedTurn.telemetry?.startPhase('final_save')
        await saveMessages({ id, messages: [completedMessage] })
        finishedTurn.telemetry?.endPhase('final_save')

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

      // A transport loss may have interrupted the turn after the agent performed
      // side effects. Only the user may choose to submit it again.
      if (getChatErrorKind(lastError) === 'connection-lost') {
        markRetriesExhausted(finishedTurn)
        return
      }

      // Don't auto-retry rate limit errors — retrying immediately makes it worse
      if (isRateLimitError(lastError)) {
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
        isContextOverflowError(lastError) ||
        isContentRejectionError(lastError) ||
        getErrorRetryable(lastError) === false
      ) {
        markRetriesExhausted(finishedTurn)
        return
      }

      const isEmptyTurn = !isError && !lastError && !message?.parts?.length
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

        const retryDelayMs = isEmptyTurn && retryCount === 1 ? emptyTurnRetryDelayMs : getRetryDelay(retryCount)

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
    },
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

  /** Mark and start one response regeneration so persistent agents rebuild from
   *  the request transcript while ordinary sends keep their live session. */
  const regenerateResponse = (): Promise<void> => {
    routingState.regenerationRevision = (routingState.regenerationRevision ?? 0) + 1
    return originalRegenerate()
  }

  // Reset retry count on manual regenerate (Retry button) so auto-retries work again
  instance.regenerate = async function () {
    startNewTurn()
    getOrCreateTurnTelemetry()
    const agentId = useChatStore.getState().sessions.get(id)?.selectedAgent.id
    if (agentId) {
      wakeAdapterReconnect(agentId)
    }
    return regenerateResponse()
  }

  const originalSendMessage = instance.sendMessage.bind(instance)

  // Override the sendMessage method to check if the model is available for the chat thread
  instance.sendMessage = async function (message, options) {
    // Cancel any pending auto-retry and reset error state for the new message
    startNewTurn()

    const { sessions } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const { chatThread, selectedModel } = session

    if (!selectedModel) {
      throw new Error('No selected model')
    }

    if (chatThread && chatThread.isEncrypted !== selectedModel.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    const telemetry = getOrCreateTurnTelemetry()
    getOrCreateDebugTranscriptTraceId()
    const debugTranscript = debugMetadataForTurn(currentTurn)
    const userDebugTranscript = debugTranscript
      ? { ...debugTranscript, engine: null }
      : message?.metadata?.debugTranscript
    const messageMetadata: NonNullable<ThunderboltUIMessage['metadata']> = {
      ...message?.metadata,
      modelId: selectedModel.id,
    }
    if (userDebugTranscript) {
      messageMetadata.debugTranscript = userDebugTranscript
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

  return instance
}
