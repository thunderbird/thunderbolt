import { updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
import { create } from 'zustand'
import type { Chat } from '@ai-sdk/react'
import { useShallow } from 'zustand/react/shallow'

type ChatSession = {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: ChatThread | null
  id: string
  retryCount: number
  retriesExhausted: boolean
  selectedMode: Mode
  selectedModel: Model
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  currentSessionId: string | null
  mcpClients: MCPClient[]
  modes: Mode[]
  models: Model[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  createSession(session: ChatSession): void
  setCurrentSessionId(id: string): void
  setMcpClients(mcpClients: MCPClient[]): void
  setModes(modes: Mode[]): void
  setModels(models: Model[]): void
  setSelectedMode(id: string, modeId: string | null): void
  setSelectedModel(id: string, modelId: string | null): void
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  currentSessionId: null,
  mcpClients: [],
  modes: [],
  models: [],
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

  setCurrentSessionId: (id) => {
    set({ currentSessionId: id })
  },

  setMcpClients: (mcpClients) => {
    set({ mcpClients })
  },

  setModes: (modes) => {
    set({ modes })
  },

  setModels: (models) => {
    set({ models })
  },

  setSelectedMode: (id, modeId) => {
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

    updateSettings({ selected_mode: mode.id })

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

    await updateSettings({ selected_model: model.id })

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
