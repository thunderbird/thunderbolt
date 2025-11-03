import { updateSetting } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { create } from 'zustand'

type ChatStoreState = {
  chatInstance: Chat<ThunderboltUIMessage> | null
  chatThread: ChatThread | null
  hasMessages: boolean
  id: string | null
  mcpClients: MCPClient[]
  models: Model[]
  selectedModel: Model | null
  triggerData: AutomationRun | null
}

type ChatStoreActions = {
  hydrate(data: ChatStoreState): void
  reset(): void
  sendMessage(text: string): Promise<void>
  setSelectedModel(modelId: string | null): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState = {
  chatInstance: null,
  chatThread: null,
  hasMessages: false,
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

  sendMessage: async (text) => {
    const { chatInstance, chatThread, selectedModel } = get()

    if (!chatInstance) {
      throw new Error('No chat instance')
    }

    if (!selectedModel) {
      throw new Error('No selected model')
    }

    if (chatThread && chatThread.isEncrypted !== selectedModel?.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

    await chatInstance.sendMessage({
      text,
      metadata: {
        modelId: selectedModel.id,
      },
    })

    set({ hasMessages: true })

    trackEvent('chat_send_prompt', {
      model: selectedModel,
      length: text.length,
      prompt_number: chatInstance.messages.length + 1,
    })
  },

  setSelectedModel: async (modelId) => {
    const models = get().models

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    set({ selectedModel: model })

    updateSetting('selected_model', model.id)

    trackEvent('model_select', { model: model.id })
  },

  reset: () => {
    set(initialState)
  },
}))
