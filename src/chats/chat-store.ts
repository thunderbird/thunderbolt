import type { AcpClient } from '@/acp/client'
import { updateSettings } from '@/dal'
import { getDb } from '@/db/database'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { Agent, AutomationRun, ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
import type { SessionConfigOption, SessionMode } from '@agentclientprotocol/sdk'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

export type ChatSession = {
  id: string
  chatThread: ChatThread | null
  acpClient: AcpClient
  agentConfig: Agent

  // ACP session state (from capability negotiation)
  availableModes: SessionMode[]
  currentModeId: string | null
  configOptions: SessionConfigOption[]

  // Reactive message state (replaces Chat's internal state)
  messages: ThunderboltUIMessage[]
  status: ChatStatus
  error: Error | null

  // Backward-compat convenience for built-in agent features (context tracking, encryption)
  selectedModel: Model
  selectedMode: Mode

  retryCount: number
  retriesExhausted: boolean
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  currentSessionId: string | null
  agents: Agent[]
  mcpClients: MCPClient[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  createSession(session: ChatSession): void
  setAgents(agents: Agent[]): void
  setCurrentSessionId(id: string): void
  setMcpClients(mcpClients: MCPClient[]): void
  setSelectedAgent(id: string, agentId: string | null): Promise<void>
  setSelectedMode(id: string, modeId: string | null): Promise<void>
  setSelectedModel(id: string, modelId: string | null): Promise<void>
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
  appendMessage(id: string, message: ThunderboltUIMessage): void
  updateLastMessage(id: string, message: ThunderboltUIMessage): void
  setSessionStatus(id: string, status: ChatStatus, error?: Error | null): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  currentSessionId: null,
  agents: [],
  mcpClients: [],
  sessions: new Map(),
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,
  createSession: (session) => {
    const { sessions } = get()

    const nextSessions = new Map(sessions)

    if (nextSessions.has(session.id)) {
      throw new Error('Session already exists')
    }

    nextSessions.set(session.id, session)

    set({ sessions: nextSessions })
  },

  setAgents: (agents) => {
    set({ agents })
  },

  setCurrentSessionId: (id) => {
    set({ currentSessionId: id })
  },

  setMcpClients: (mcpClients) => {
    set({ mcpClients })
  },

  setSelectedAgent: async (id, agentId) => {
    const { agents, sessions } = get()

    const agent = agents.find((a) => a.id === agentId)

    if (!agent) {
      throw new Error('Agent not found')
    }

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, agentConfig: agent })

    set({ sessions: nextSessions })

    const db = getDb()
    await updateSettings(db, { selected_agent: agent.id })

    trackEvent('agent_select', { agent: agent.id })
  },

  setSelectedMode: async (id, modeId) => {
    const { sessions } = get()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    // Find mode in session's available modes
    const mode = session.availableModes.find((m) => m.id === modeId)
    if (!mode) {
      throw new Error('Mode not found in session available modes')
    }

    // Update via ACP
    await session.acpClient.setMode(mode.id)

    // Update session state
    const nextSessions = new Map(get().sessions)
    const currentSession = nextSessions.get(id)
    if (currentSession) {
      nextSessions.set(id, {
        ...currentSession,
        currentModeId: mode.id,
        selectedMode: {
          ...currentSession.selectedMode,
          id: mode.id,
          name: mode.id,
          label: mode.name,
        },
      })
    }

    set({ sessions: nextSessions })

    const db = getDb()
    await updateSettings(db, { selected_mode: mode.id })

    trackEvent('mode_select', { mode: mode.id })
  },

  setSelectedModel: async (id, modelId) => {
    const { sessions } = get()

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    // Update via ACP config option — response contains updated configOptions
    const response = await session.acpClient.setConfigOption('model', modelId ?? '')

    // Propagate updated configOptions back to session state so the UI reflects the change
    if (response?.configOptions) {
      const nextSessions = new Map(get().sessions)
      const currentSession = nextSessions.get(id)
      if (currentSession) {
        nextSessions.set(id, { ...currentSession, configOptions: response.configOptions })
      }
      set({ sessions: nextSessions })
    }

    const db = getDb()
    await updateSettings(db, { selected_model: modelId ?? '' })

    trackEvent('model_select', { model: modelId })
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

  appendMessage: (id, message) => {
    const { sessions } = get()
    const session = sessions.get(id)
    if (!session) {
      return
    }
    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, messages: [...session.messages, message] })
    set({ sessions: nextSessions })
  },

  updateLastMessage: (id, message) => {
    const { sessions } = get()
    const session = sessions.get(id)
    if (!session || session.messages.length === 0) {
      return
    }
    const nextMessages = [...session.messages]
    nextMessages[nextMessages.length - 1] = message
    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, messages: nextMessages })
    set({ sessions: nextSessions })
  },

  setSessionStatus: (id, status, error = null) => {
    const { sessions } = get()
    const session = sessions.get(id)
    if (!session) {
      return
    }
    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, status, error })
    set({ sessions: nextSessions })
  },
}))

/**
 * Returns the current chat session, throwing if none exists.
 */
export const useCurrentChatSession = () => {
  const session = useChatStore(useShallow((state) => state.sessions.get(state.currentSessionId ?? '')))

  if (!session) {
    throw new Error('No chat session found')
  }

  return session
}
