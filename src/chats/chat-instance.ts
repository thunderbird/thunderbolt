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
  builtInPlacementRefusalMessage,
  decideBuiltInPlacement as defaultDecideBuiltInPlacement,
} from '@/acp/built-in-placement'
import { announceCloudExecution as defaultAnnounceCloudExecution } from '@/acp/cloud-execution-notice'
import { resolveRunSpec as defaultResolveRunSpec } from '@/acp/runner-run-spec'
import { buildRunnerWireTarget } from '@/acp/runner-target'
import { selectCloudRunnerWsUrl, useConfigStore } from '@/api/config-store'
import { getAttachments } from '@/lib/attachments'
import {
  createTurnBudget as defaultCreateTurnBudget,
  createTurnBudgetExhaustedError,
  type TurnBudget,
} from '@/ai/retry-budget'
import { createWebToolBudget, resolveWebToolIntent, type WebToolBudget } from '@/ai/web-tool-budget'
import { updateChatThread as defaultUpdateChatThread } from '@/dal/chat-threads'
import { getAllSkills as defaultGetAllSkills } from '@/dal'
import { isBuiltInAgent } from '@/defaults/agents'
import { extractLastUserText, resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { getDb as defaultGetDb } from '@/db/database'
import {
  getChatErrorKind,
  getErrorRetryable,
  isContentRejectionError,
  isContextOverflowError,
  isRateLimitError,
} from '@/lib/error-utils'
import type { HttpClient } from '@/lib/http'
import { trackEvent } from '@/lib/posthog'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import type { RunSpec } from '@shared/acp-types'
import { Chat } from '@ai-sdk/react'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { DefaultChatTransport, type ChatInit } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import {
  deriveToolKey,
  encryptedThreadAgentErrorMessage,
  findAllowOption,
  isRemoteAgentOnEncryptedThread,
  useChatStore,
} from './chat-store'

export const maxRetries = 3
const baseRetryDelayMs = 2000

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Jitter prevents synchronized retries from overwhelming servers.
 */
const getRetryDelay = (attempt: number) => baseRetryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random())

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
    trackEvent('acp_mode_changed', { mode_id: effect.modeId })
    return
  }
  if (effect.type === 'config_options_changed') {
    trackEvent('acp_config_options_changed', { count: effect.options.length })
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
  createChat?: (init: ChatInit<ThunderboltUIMessage>) => Chat<ThunderboltUIMessage>
  createTurnBudget?: typeof defaultCreateTurnBudget
  wakeAdapterReconnect?: typeof defaultWakeAdapterReconnect
  decideBuiltInPlacement?: typeof defaultDecideBuiltInPlacement
  resolveRunSpec?: typeof defaultResolveRunSpec
  announceCloudExecution?: typeof defaultAnnounceCloudExecution
  getRunnerWsUrl?: () => string | null
}

export type AgentRoutingState = {
  regenerationRevision?: number
  webToolBudgetRevision?: number
  getTurnBudget?: () => TurnBudget
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
  const decideBuiltInPlacement = deps.decideBuiltInPlacement ?? defaultDecideBuiltInPlacement
  const resolveRunSpec = deps.resolveRunSpec ?? defaultResolveRunSpec
  const announceCloudExecution = deps.announceCloudExecution ?? defaultAnnounceCloudExecution
  const getRunnerWsUrl = deps.getRunnerWsUrl ?? (() => selectCloudRunnerWsUrl(useConfigStore.getState().config))
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

  // This thread ran a turn on the runner during this instance's life. The
  // persisted marker is authoritative across reloads, but its write round-trips
  // through sync before the store can read it back — without remembering it
  // here, a quick second send could read a stale thread and fork the
  // conversation onto this device.
  let placedOnRunner = false

  /**
   * Runner detached-turn catch-up. `chat.resumeStream()` issues a GET through
   * this same custom fetch (the AI SDK transport's `reconnectToStream`); route
   * it to the adapter's `reattach` instead of the prompt path. When the thread
   * ends in a crash-recovery partial, that message is lifted out of the chat
   * state and its id is handed to `reattach`, so the replayed turn streams
   * under the same id — replacing the partial in the UI and, via the normal
   * `onFinish` save, in the DB. Returns 204 when there is nothing to catch up
   * on (the SDK treats it as a quiet no-op).
   */
  const handleRunnerReattach = async (): Promise<Response> => {
    const noCatchUp = () => new Response(null, { status: 204 })
    const session = useChatStore.getState().sessions.get(id)
    if (!session) {
      return noCatchUp()
    }
    const { chatThread, selectedAgent, selectedModel, chatInstance } = session
    // Only a runner-owned built-in thread has a detached turn to replay, and
    // this runs before any connection exists — a looser gate would dial
    // arbitrary remote agents (including dead ones) just to learn they cannot
    // replay.
    const runnerWsUrl = getRunnerWsUrl()
    if (!isBuiltInAgent(selectedAgent) || !chatThread?.acpSessionId || !runnerWsUrl) {
      return noCatchUp()
    }
    // Corrupted state that pairs an encrypted thread with off-device execution
    // must not reach the wire. Catch-up is a background side effect the user
    // never asked for, so it stays a quiet no-op rather than raising an error.
    if (chatThread.isEncrypted === 1) {
      return noCatchUp()
    }

    const wireTarget = buildRunnerWireTarget(runnerWsUrl)
    const adapter = await getOrConnectAdapter(
      wireTarget,
      { httpClient, getProxyFetch, onAvailableCommands: makeCommandSink(wireTarget.id) },
      { connectToAgent: deps.connectToAgent },
    ).catch((err: unknown) => {
      // A runner outage must stay a quiet 204 for the user, but not invisible
      // to whoever is diagnosing why catch-up never happens.
      console.warn('runner reattach: adapter connect failed', err)
      return null
    })
    if (!adapter?.reattach) {
      return noCatchUp()
    }

    // Lift a trailing crash-recovery partial out of the chat state so the
    // replayed turn (streamed under the same message id) replaces it instead
    // of appending to it. Restored verbatim when nothing gets replayed.
    const messages = chatInstance.messages
    const last = messages[messages.length - 1]
    const partial = last?.role === 'assistant' && last.metadata?.partial === true ? last : undefined
    if (partial) {
      chatInstance.messages = messages.slice(0, -1)
    }

    // A resumed session still needs its run spec: the runner never picks a
    // model, so restoring execution state without one would leave the session
    // unable to run its next turn.
    const runSpec = await resolveRunSpec(selectedModel).catch((err: unknown) => {
      console.warn('runner reattach: run spec resolution failed', err)
      return undefined
    })

    const response = await adapter
      .reattach(
        {
          threadId: id,
          acpSessionId: chatThread.acpSessionId,
          runSpec,
          onAcpSessionId: async (newSessionId) => {
            await updateChatThread(getDb(), id, { acpSessionId: newSessionId })
          },
          requestPermission: (request) => requestPermissionViaStore(id, wireTarget.id, request),
          onSessionSideEffect: applySessionSideEffect,
        },
        partial?.id,
      )
      .catch((err: unknown) => {
        console.warn('runner reattach failed', err)
        return null
      })

    if (!response) {
      if (partial) {
        chatInstance.messages = messages
      }
      return noCatchUp()
    }
    return response
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

  return Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      if (!init) {
        throw new Error('Missing init')
      }

      // `resumeStream()` reconnects via GET (no body); everything else is the
      // POST prompt path.
      if (init.method === 'GET') {
        return handleRunnerReattach()
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

      if (isRemoteAgentOnEncryptedThread(chatThread, selectedAgent)) {
        throw new Error(encryptedThreadAgentErrorMessage)
      }

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
      await saveMessages({ id, messages: requestMessages })

      // Persist by `id`, not `chatThread.id`: on a brand-new chat the session's
      // `chatThread` snapshot is still `null` here (PowerSync hasn't re-hydrated
      // it yet), but `saveMessages` above just created the `chat_threads` row —
      // so keying off `chatThread` would silently drop the fresh ACP id and
      // break resume/load on the next reconnect. `id` is that same row's id.
      const persistAcpSessionId = async (newSessionId: string): Promise<void> => {
        await updateChatThread(getDb(), id, { acpSessionId: newSessionId })
      }

      // Selecting a different agent clears the thread's ACP session id, so a
      // remembered pin from an earlier built-in turn no longer describes this
      // thread — drop it and let a later built-in send decide placement afresh.
      if (!isBuiltInAgent(selectedAgent)) {
        placedOnRunner = false
      }

      // Where this thread's turns run. Built-in threads may execute on the cloud
      // runner instead of this device; the selected agent — and everything the
      // UI shows — is the built-in agent either way.
      const runnerWsUrl = getRunnerWsUrl()
      const placement = await decideBuiltInPlacement({
        agent: selectedAgent,
        isRunnerOwned: placedOnRunner || chatThread?.acpSessionId != null,
        isEncryptedThread: chatThread?.isEncrypted === 1,
        model: selectedModel,
        runnerWsUrl,
        hasPriorTurns: requestMessages.length > 1,
        hasMcpClients: mcpClients.length > 0,
        hasAttachments: requestMessages.some((message) => getAttachments(message).length > 0),
      })
      if (placement.placement === 'refuse') {
        throw new Error(builtInPlacementRefusalMessage(placement.reason))
      }

      const turnBudget = getTurnBudget().consumer
      if (!turnBudget.tryConsumeRequest()) {
        throw createTurnBudgetExhaustedError()
      }

      // The runner owning this thread's session is exactly "the marker was
      // written", so the persist callback is where the pin is taken.
      let ownedByRunner = placement.reason === 'runner-owned'
      const persistRunnerSessionId = async (newSessionId: string): Promise<void> => {
        await persistAcpSessionId(newSessionId)
        placedOnRunner = true
        ownedByRunner = true
      }

      /** Run this send against one wire target. `runSpec` travels only to the
       *  runner, which executes the model we name; every other agent owns its
       *  own model. */
      const sendVia = async (target: typeof selectedAgent, runSpec?: RunSpec): Promise<Response> => {
        // Surface `connecting` only when routing somewhere other than where this
        // thread last went — a warm cache resolves instantly, but the per-thread
        // UI still needs the transition for the cold-connect spinner.
        const isNewTarget = target.id !== routedAgentId
        if (isNewTarget) {
          useChatStore.getState().updateSession(id, { connectionStatus: 'connecting', connectionError: null })
        }

        const adapter = await getOrConnectAdapter(
          target,
          { httpClient, getProxyFetch, onAvailableCommands: makeCommandSink(target.id) },
          { connectToAgent: deps.connectToAgent },
        ).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err))
          useChatStore.getState().updateSession(id, { connectionStatus: 'error', connectionError: error })
          throw error
        })

        routedAgentId = target.id
        if (isNewTarget) {
          useChatStore.getState().updateSession(id, { connectionStatus: 'ready', connectionError: null })
        }

        // The in-process built-in pipeline re-resolves skill instructions itself
        // (ai/fetch.ts); every ACP target — including the runner — only receives
        // prompt text, so they are resolved here and folded into the prompt.
        const isInProcess = isBuiltInAgent(target)
        const skillInstructions = isInProcess ? undefined : await resolveAcpSkillInstructions(requestBody.messages)
        // Built-in auto-run is a product decision restoring pre-#1032 behavior for all tools, including network-capable tools.
        const requestPermission = isInProcess
          ? undefined
          : (request: RequestPermissionRequest) => requestPermissionViaStore(id, target.id, request)

        return adapter.fetch(init, {
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
          webToolBudget: getWebToolBudget(requestMessages),
          regenerationRevision: routingState.regenerationRevision ?? 0,
          skillInstructions,
          runSpec,
          onAcpSessionId: runSpec ? persistRunnerSessionId : persistAcpSessionId,
          requestPermission,
          onSessionSideEffect: applySessionSideEffect,
        })
      }

      if (placement.placement === 'local') {
        return sendVia(selectedAgent)
      }

      // `runnerWsUrl` is non-null on every runner placement — the decision
      // requires it — but the compiler can't see that through the module seam.
      const wireTarget = buildRunnerWireTarget(runnerWsUrl ?? '')
      const runSpec = await resolveRunSpec(selectedModel)
      try {
        const response = await sendVia(wireTarget, runSpec)
        placedOnRunner = true
        announceCloudExecution()
        return response
      } catch (error) {
        // Connecting or creating the session can fail before the runner holds
        // anything for this thread. On that first turn the send is still
        // unplaced, so running it here is safe and beats failing outright. Once
        // the thread is pinned there is no safe local equivalent — the runner
        // may already have executed side effects — so the error surfaces.
        if (ownedByRunner) {
          throw error
        }
        console.warn('runner placement failed on first turn; running locally', error)
        useChatStore.getState().updateSession(id, { connectionStatus: 'connecting', connectionError: null })
        return sendVia(selectedAgent)
      }
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )
}

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
  const wakeAdapterReconnect = deps.wakeAdapterReconnect ?? defaultWakeAdapterReconnect
  let turnBudget = createTurnBudget()
  const routingState: AgentRoutingState = {
    regenerationRevision: 0,
    webToolBudgetRevision: 0,
    getTurnBudget: () => turnBudget,
  }
  const customFetch = createAgentRoutingFetch(id, saveMessages, httpClient, getProxyFetch, deps, routingState)
  const createChat = deps.createChat ?? ((init: ChatInit<ThunderboltUIMessage>) => new Chat(init))

  let retryCount = 0
  let retryTimeout: ReturnType<typeof setTimeout> | null = null
  let lastError: Error | null = null

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
    useChatStore.getState().updateSession(id, { retryCount: 0, retriesExhausted: false })
  }

  /** Stop retrying this turn and record why it stopped. */
  const markRetriesExhausted = () => {
    trackEvent('chat_retries_exhausted', {
      reason: getChatErrorKind(lastError) ?? 'unknown',
      attempts: retryCount,
    })
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
      if (isAbort) {
        resetRetryStateForNewTurn()

        // Persist whatever streamed before the user hit Stop. Streaming partial
        // saves are throttled and their pending trailing write is cancelled the
        // moment streaming stops (see SavePartialAssistantMessagesHandler), so
        // onFinish is the authoritative final save on abort just as it is on
        // success — without this, the last streamed chunk of an aborted turn
        // would be lost on reload.
        if (message?.parts?.length) {
          await saveMessages({ id, messages: [message] })
        }
        return
      }

      // Handle successful responses: message exists, no error, and has parts
      if (!isError && message && message.parts?.length) {
        if (retryCount > 0) {
          trackEvent('chat_retry_success', { attempts: retryCount })
        }
        resetRetryStateForNewTurn()

        const { sessions } = useChatStore.getState()

        const session = sessions.get(id)

        if (!session) {
          throw new Error('No session found')
        }

        await saveMessages({ id, messages: [message] })

        trackEvent('chat_receive_reply', {
          model: session.selectedModel,
          length: message.parts.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0),
          reply_number: instance.messages.length + 1,
        })

        return
      }

      // A transport loss may have interrupted the turn after the agent performed
      // side effects. Only the user may choose to submit it again.
      if (getChatErrorKind(lastError) === 'connection-lost') {
        markRetriesExhausted()
        return
      }

      // Don't auto-retry rate limit errors — retrying immediately makes it worse
      if (isRateLimitError(lastError)) {
        markRetriesExhausted()
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
        markRetriesExhausted()
        return
      }

      if (retryCount < maxRetries) {
        if (turnBudget.probe.isExhausted) {
          markRetriesExhausted()
          return
        }

        retryCount++
        useChatStore.getState().updateSession(id, { retryCount })
        console.info(`Auto-retrying (${retryCount}/${maxRetries})...`)

        trackEvent('chat_auto_retry', {
          attempt: retryCount,
          max_retries: maxRetries,
          reason: getChatErrorKind(lastError) ?? 'unknown',
        })

        retryTimeout = setTimeout(() => {
          retryTimeout = null
          const { sessions, currentSessionId } = useChatStore.getState()
          // Only retry if the session still exists AND is still the current active session.
          // This prevents retries from executing when the user has switched to a different thread.
          if (!sessions.has(id) || currentSessionId !== id) {
            // Reset retry state when bailing out due to session switch, so the UI
            // doesn't show "Retrying..." when the user switches back to this session.
            resetRetryStateForNewTurn()
            return
          }
          regenerateResponse().catch((err) => {
            console.error('Auto-retry failed:', err)
            // Don't set retriesExhausted here - let onFinish handle retry logic.
            // When originalRegenerate() fails, onFinish will be called again and will
            // either schedule another retry (if retryCount < maxRetries) or set
            // retriesExhausted: true (if retries are exhausted).
          })
        }, getRetryDelay(retryCount))
      } else {
        markRetriesExhausted()
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
    resetRetryStateForNewTurn()
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
    resetRetryStateForNewTurn()

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

    trackEvent('chat_send_prompt', {
      model: selectedModel,
      length: message && 'text' in message ? (message.text?.length ?? 0) : 0,
      prompt_number: instance.messages.length + 1,
    })

    return originalSendMessage(
      {
        ...message,
        metadata: {
          ...message?.metadata,
          modelId: selectedModel.id,
        },
      } as ThunderboltUIMessage,
      options,
    )
  }

  return instance
}
