/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { updateChatThread } from '@/dal/chat-threads'
import { getDb } from '@/db/database'
import { type NamedMCPClient, type ReconnectClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { Agent } from '@/types/acp'
import type { AutomationRun, ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
import { create } from 'zustand'
import type { Chat } from '@ai-sdk/react'
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
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
  retryCount: number
  retriesExhausted: boolean
  selectedAgent: Agent
  selectedMode: Mode
  selectedModel: Model
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  alwaysAllowedAgentIds: Set<string>
  alwaysAllowedAgentToolKeys: Set<string>
  currentSessionId: string | null
  getMcpClients: () => NamedMCPClient[]
  reconnectClient: ReconnectClient
  modes: Mode[]
  models: Model[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  allowAlwaysForAgent(agentId: string): void
  allowAlwaysForTool(agentId: string, toolKey: string): void
  createSession(session: ChatSession): void
  applyAgentWireIdentityChange(agent: Agent): void
  isAlwaysAllowed(agentId: string, toolKey: string): boolean
  setCurrentSessionId(id: string): void
  setGetMcpClients(getMcpClients: () => NamedMCPClient[]): void
  setReconnectClient(reconnectClient: ReconnectClient): void
  setModes(modes: Mode[]): void
  setModels(models: Model[]): void
  setPendingPermission(id: string, permission: PendingPermission | null): void
  resolvePendingPermission(id: string, response: RequestPermissionResponse): void
  setSelectedAgent(id: string, agent: Agent): Promise<void>
  setSelectedMode(id: string, modeId: string | null): Promise<void>
  setSelectedModel(id: string, modelId: string | null): Promise<void>
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
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
  modes: [],
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

  setModes: (modes) => {
    set({ modes })
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
    // `setSelectedModel`/`setSelectedMode`). The per-thread write above keeps
    // existing chats pinned to their own agent.
    await updateSettings(db, { selected_agent: agent.id })

    trackEvent('agent_select', { agent: agent.id })
  },

  setSelectedMode: async (id, modeId) => {
    const { modes, sessions } = get()

    const mode = modes.find((m) => m.id === modeId)

    if (!mode) {
      throw new Error('Mode not found')
    }

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, selectedMode: mode })

    set({ sessions: nextSessions })

    const db = getDb()
    await updateSettings(db, { selected_mode: mode.id })

    trackEvent('mode_select', { mode: mode.id })
  },

  setSelectedModel: async (id, modelId) => {
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
