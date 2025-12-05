import { updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { create } from 'zustand'

type ChatStoreState = {
  chatInstance: Chat<ThunderboltUIMessage> | null
  chatThread: ChatThread | null
  id: string | null
  mcpClients: MCPClient[]
  models: Model[]
  selectedModel: Model | null
  triggerData: AutomationRun | null
}

type ChatStoreActions = {
  hydrate(data: ChatStoreState): void
  reset(): void
  setChatThread(chatThread: ChatThread | null): void
  setSelectedModel(modelId: string | null): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState = {
  chatInstance: null,
  chatThread: null,
  id: null,
  mcpClients: [],
  models: [],
  selectedModel: null,
  triggerData: null,
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,

  hydrate: (data) => {
    set(data)
  },

  setChatThread: (chatThread) => {
    set({ chatThread })
  },

  setSelectedModel: async (modelId) => {
    const models = get().models

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    set({ selectedModel: model })

    updateSettings({ selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },

  reset: () => {
    set(initialState)
  },
}))
