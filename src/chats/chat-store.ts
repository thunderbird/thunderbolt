/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { prewarmSystemModel } from '@/ai/prewarm-system-model'
import { updateSettings } from '@/dal'
import { updateChatThread } from '@/dal/chat-threads'
import { getDb } from '@/db/database'
import { type NamedMCPClient, type ReconnectClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { Agent } from '@/types/acp'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { create } from 'zustand'
import type { Chat } from '@ai-sdk/react'
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { MiniAppApprovalOutcome } from '@/mini-apps/approval-outcome'
import type { MiniAppTool } from '@shared/mini-app-protocol'
import { useShallow } from 'zustand/react/shallow'

/** Outstanding ACP permission request awaiting user response. The promise
 *  resolver lives here so the dialog UI can complete it via a store action;
 *  the adapter awaits the same promise inside its `requestPermission` client
 *  handler. */
export type PendingPermission = {
  agentId: string
  requestId: string
  request: RequestPermissionRequest
  resolve: (response: RequestPermissionResponse) => void
}

/**
 * A Mini App write-tool call waiting on the user, and the promise it blocks.
 *
 * Lives on the session for the same reason {@link PendingPermission} does: the
 * decision belongs to the conversation that provoked it. Held globally, one
 * chat's prompt appeared over another chat after a switch, and the answer went
 * to whichever request happened to be at the head of the shared queue.
 *
 * A queue rather than a single slot, unlike ACP's: the AI SDK runs a step's
 * tool calls concurrently, so one response can produce two writes, and each is
 * holding its own turn open. Superseding would auto-deny the first before the
 * user ever saw it.
 *
 * `decide` is idempotent and drops this entry by identity — never by position,
 * which is what let a double-click answer the next, unseen request.
 */
export type PendingMiniAppApproval = {
  /** The app the call is for; the sweep on close/re-handshake keys on it. */
  appId: string
  /**
   * The app's display name, captured when the call was made.
   *
   * Carried rather than looked up at render time: the prompt must name the app
   * whose tool this is, which is not necessarily the app on screen by the time
   * the user answers — and an app can be deregistered in between.
   */
  appName: string
  tool: MiniAppTool
  args: unknown
  /** Resolves the blocked `execute`. Safe to call more than once. */
  decide: (outcome: MiniAppApprovalOutcome) => void
}

/** Keys a remembered allowance for this agent on the ACP tool kind. */
export const deriveToolKey = (request: RequestPermissionRequest): string => request.toolCall?.kind ?? 'unknown'

/** Finds the option used to approve a request, preferring one-time approval. */
export const findAllowOption = (options: PermissionOption[]): PermissionOption | undefined =>
  options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always')

/** Builds the stored key for an agent-specific tool allowance. */
const getToolAllowanceKey = (agentId: string, toolKey: string): string => `${agentId}::${toolKey}`

/** Connection state for the per-agent ACP adapter. `idle` covers built-in
 *  agents (no handshake) and the initial state before the first send. */
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

export type ChatSession = {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: ChatThread | null
  connectionStatus: ConnectionStatus
  connectionError: Error | null
  id: string
  pendingPermission: PendingPermission | null
  /** Mini App write-tool calls this chat is blocked on, oldest first. The head
   *  is the one on screen; the rest wait their turn. */
  miniAppApprovalQueue: PendingMiniAppApproval[]
  retryCount: number
  retriesExhausted: boolean
  selectedAgent: Agent
  selectedModel: Model
  /**
   * Owning project for this chat, or null for a loose chat. Resolved at
   * hydration from the persisted `chat_threads.project_id`, or — for a brand-new
   * chat started from a project — the `?projectId=` search param. It lives on the
   * session for the same reason `selectedAgent` does: the thread row is created
   * lazily on the first message save, so the value has to survive until then or
   * the row would be written with `project_id` null.
   */
  projectId: string | null
  /**
   * Mini App this chat was started from, or null. Rides the session for the
   * same reason `projectId` does — the row is written lazily on first save.
   */
  miniAppId: string | null
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  alwaysAllowedAgentIds: Set<string>
  alwaysAllowedAgentToolKeys: Set<string>
  currentSessionId: string | null
  getMcpClients: () => NamedMCPClient[]
  reconnectClient: ReconnectClient
  models: Model[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  allowAlwaysForAgent(agentId: string): void
  allowAlwaysForTool(agentId: string, toolKey: string): void
  createSession(session: ChatSession): void
  applyAgentWireIdentityChange(agent: Agent): void
  cancelPendingPermissionsForAgent(agentId: string): void
  isAlwaysAllowed(agentId: string, toolKey: string): boolean
  setCurrentSessionId(id: string): void
  setGetMcpClients(getMcpClients: () => NamedMCPClient[]): void
  setReconnectClient(reconnectClient: ReconnectClient): void
  setModels(models: Model[]): void
  setPendingPermission(id: string, permission: PendingPermission | null): void
  resolvePendingPermission(id: string, response: RequestPermissionResponse): void
  enqueueMiniAppApproval(id: string, pending: PendingMiniAppApproval): boolean
  dequeueMiniAppApproval(id: string, pending: PendingMiniAppApproval): void
  cancelMiniAppApprovals(appId: string): void
  setSelectedAgent(id: string, agent: Agent): Promise<void>
  setSelectedModel(id: string, modelId: string | null, deps?: SetSelectedModelDeps): Promise<void>
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
}

type SetSelectedModelDeps = {
  prewarmSystemModel?: typeof prewarmSystemModel
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  alwaysAllowedAgentIds: new Set(),
  alwaysAllowedAgentToolKeys: new Set(),
  currentSessionId: null,
  // Read fresh per send (not snapshotted) so that after a provider reconnect
  // swaps a server's client, the next send sees the new client instead of a
  // stale, closed one. Hydration replaces this with the provider's
  // `getEnabledClients` getter, which reads its live `serversRef`.
  getMcpClients: () => [],
  // Replaced by the MCP provider's `reconnectClient` on hydration. The default
  // no-op (returns null) makes `mergeMcpTools` skip a dropped server rather than
  // reconnect — correct for the pre-hydration / no-provider case.
  reconnectClient: async () => null,
  models: [],
  sessions: new Map(),
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,
  allowAlwaysForAgent: (agentId) => {
    set((state) => ({ alwaysAllowedAgentIds: new Set(state.alwaysAllowedAgentIds).add(agentId) }))
  },

  allowAlwaysForTool: (agentId, toolKey) => {
    set((state) => ({
      alwaysAllowedAgentToolKeys: new Set(state.alwaysAllowedAgentToolKeys).add(getToolAllowanceKey(agentId, toolKey)),
    }))
  },

  createSession: (session) => {
    const { sessions } = get()

    const nextSessions = new Map(sessions)

    if (nextSessions.has(session.id)) {
      throw new Error('Session already exists')
    }

    nextSessions.set(session.id, session)

    set({ sessions: nextSessions })
  },

  applyAgentWireIdentityChange: (agent) => {
    const nextSessions = new Map(get().sessions)
    let changed = false

    for (const [id, session] of nextSessions) {
      const threadMatches = session.chatThread?.agentId === agent.id
      const agentMatches = session.selectedAgent.id === agent.id
      if (!threadMatches && !agentMatches) {
        continue
      }
      changed = true
      nextSessions.set(id, {
        ...session,
        chatThread: threadMatches ? { ...session.chatThread!, acpSessionId: null } : session.chatThread,
        selectedAgent: agentMatches ? agent : session.selectedAgent,
      })
    }

    if (changed) {
      set({ sessions: nextSessions })
    }
  },

  cancelPendingPermissionsForAgent: (agentId) => {
    const matching = [...get().sessions.entries()].filter(
      ([, session]) => session.pendingPermission?.agentId === agentId,
    )
    if (matching.length === 0) {
      return
    }

    const nextSessions = new Map(get().sessions)
    for (const [id, session] of matching) {
      nextSessions.set(id, { ...session, pendingPermission: null })
    }
    set({ sessions: nextSessions })

    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    for (const [, session] of matching) {
      session.pendingPermission?.resolve(cancelled)
    }
  },

  setCurrentSessionId: (id) => {
    set({ currentSessionId: id })
  },

  isAlwaysAllowed: (agentId, toolKey) => {
    const { alwaysAllowedAgentIds, alwaysAllowedAgentToolKeys } = get()

    return alwaysAllowedAgentIds.has(agentId) || alwaysAllowedAgentToolKeys.has(getToolAllowanceKey(agentId, toolKey))
  },

  setGetMcpClients: (getMcpClients) => {
    set({ getMcpClients })
  },

  setReconnectClient: (reconnectClient) => {
    set({ reconnectClient })
  },

  setModels: (models) => {
    set({ models })
  },

  setPendingPermission: (id, permission) => {
    const { sessions } = get()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, pendingPermission: permission })
    set({ sessions: nextSessions })
  },

  resolvePendingPermission: (id, response) => {
    const { sessions } = get()

    const session = sessions.get(id)

    if (!session?.pendingPermission) {
      return
    }

    const { resolve } = session.pendingPermission

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, pendingPermission: null })
    set({ sessions: nextSessions })

    resolve(response)
  },

  /**
   * Queue an approval on the chat that provoked it.
   *
   * Returns false when that chat has no live session — a call racing a closed
   * tab has nobody to ask, and the caller denies rather than hanging the turn.
   * Deliberately not a throw like `setPendingPermission`'s: an absent session
   * here is a race, not a bug.
   */
  enqueueMiniAppApproval: (id, pending) => {
    const { sessions } = get()
    const session = sessions.get(id)

    if (!session) {
      return false
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, miniAppApprovalQueue: [...session.miniAppApprovalQueue, pending] })
    set({ sessions: nextSessions })
    return true
  },

  /** Drop one entry by identity. It may be answering from the queue's middle,
   *  if its own deadline expired while another was on screen. */
  dequeueMiniAppApproval: (id, pending) => {
    const { sessions } = get()
    const session = sessions.get(id)

    if (!session) {
      return
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, {
      ...session,
      miniAppApprovalQueue: session.miniAppApprovalQueue.filter((entry) => entry !== pending),
    })
    set({ sessions: nextSessions })
  },

  /**
   * Deny every queued approval for one app, across every chat.
   *
   * Called when the app closes or re-handshakes: the document that would have
   * serviced these calls is gone, so nothing can honour them, and an `execute`
   * awaiting a prompt nobody can answer hangs its turn. Sweeps all sessions
   * because the queues are per-chat now while the app is a single surface —
   * the same shape as `cancelPendingPermissionsForAgent`.
   *
   * `decide` dequeues itself, so this only has to call it.
   */
  cancelMiniAppApprovals: (appId) => {
    // Snapshotted before deciding: each `decide` writes back through the store,
    // so iterating the live map would walk a collection being replaced.
    const doomed = [...get().sessions.values()].flatMap((session) =>
      session.miniAppApprovalQueue.filter((pending) => pending.appId === appId),
    )
    // `unavailable`, not `denied`: the user never saw these, so telling the model
    // they were declined would put a decision in their mouth.
    doomed.forEach((pending) => pending.decide('unavailable'))
  },

  setSelectedAgent: async (id, agent) => {
    const { sessions } = get()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const agentChanged = session.selectedAgent.id !== agent.id
    const threadPatch = agentChanged ? { agentId: agent.id, acpSessionId: null } : { agentId: agent.id }
    const nextSessions = new Map(sessions)
    const nextChatThread = session.chatThread ? { ...session.chatThread, ...threadPatch } : session.chatThread
    nextSessions.set(id, { ...session, chatThread: nextChatThread, selectedAgent: agent })

    set({ sessions: nextSessions })

    const db = getDb()

    if (session.chatThread) {
      await updateChatThread(db, session.chatThread.id, threadPatch)
    }

    // Persist the global last-used agent so new chats default to it (mirrors
    // `setSelectedModel`). The per-thread write above keeps existing chats
    // pinned to their own agent.
    await updateSettings(db, { selected_agent: agent.id })

    trackEvent('agent_select', { agent: agent.id })
  },

  setSelectedModel: async (id, modelId, deps = {}) => {
    const { models, sessions } = get()

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, selectedModel: model })

    set({ sessions: nextSessions })

    // Fire-and-forget: the wrapper no-ops (before any dynamic import) unless
    // this is a Tinfoil system model, so the first send finds a warm client.
    void (deps.prewarmSystemModel ?? prewarmSystemModel)(model)

    const db = getDb()
    await updateSettings(db, { selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },

  updateSession: (id, session) => {
    const { sessions } = get()

    const existingSession = sessions.get(id)

    if (!existingSession) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...existingSession, ...session })
    set({ sessions: nextSessions })
  },
}))

/**
 * Returns the current chat session, throwing if none exists.
 *
 * Use this hook in components/hooks that fundamentally require an active session to function
 * (e.g., chat UI, message handlers). The throw ensures these components never render in an
 * invalid state.
 *
 * For components where a session is optional and they can still function without one
 * (e.g., Header, ChatListItem, useHandleIntegrationCompletion), access the store directly
 * with optional chaining: `state.sessions.get(state.currentSessionId ?? '')?.someProperty`
 */
export const useCurrentChatSession = () => {
  const session = useChatStore(useShallow((state) => state.sessions.get(state.currentSessionId ?? '')))

  if (!session) {
    throw new Error('No chat session found')
  }

  return session
}
