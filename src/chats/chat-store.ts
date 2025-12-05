import { updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { create } from 'zustand'
import type { Chat } from '@ai-sdk/react'

type ChatSession = {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: ChatThread | null // @todo: make required
  id: string
  selectedModel: Model
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  mcpClients: MCPClient[]
  models: Model[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  createSession(session: ChatSession): void
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
  setMcpClients(mcpClients: MCPClient[]): void
  setModels(models: Model[]): void
  setSelectedModel(id: string, modelId: string | null): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  sessions: new Map(),
  mcpClients: [],
  models: [],
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

  setMcpClients: (mcpClients) => {
    set({ mcpClients })
  },

  setModels: (models) => {
    set({ models })
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

    updateSettings({ selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },
}))
