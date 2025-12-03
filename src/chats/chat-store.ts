import { updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { create } from 'zustand'

type ChatItem = {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: ChatThread | null
  id: string
  selectedModel: Model
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  chats: Map<string, ChatItem>
  mcpClients: MCPClient[]
  models: Model[]
}

type ChatStoreActions = {
  registerChat(chat: ChatItem): void
  updateChat(chatId: string, data: Partial<ChatItem>): void
  sendMessage(chatId: string, text: string): Promise<void>
  setSelectedModel(chatId: string, modelId: string | null): void
  setModels(models: Model[]): void
  setMcpClients(mcpClients: MCPClient[]): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  chats: new Map(),
  mcpClients: [],
  models: [],
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,

  setModels: (models: Model[]) => {
    set({ models })
  },

  setMcpClients: (mcpClients: MCPClient[]) => {
    set({ mcpClients })
  },

  registerChat: (chat) => {
    const { chats } = get()

    const updatedChats = new Map(chats)

    if (!updatedChats.has(chat.id)) {
      updatedChats.set(chat.id, chat)
    }

    set({
      chats: updatedChats,
    })
  },

  updateChat: (chatId: string, data: Partial<ChatItem>) => {
    const { chats } = get()

    const chat = chats.get(chatId)

    if (!chat) {
      throw new Error('No chat found')
    }

    const updatedChats = new Map(chats)
    updatedChats.set(chatId, { ...chat, ...data })

    set({ chats: updatedChats })
  },

  sendMessage: async (chatId, text) => {
    const { chats } = get()

    const chat = chats.get(chatId)

    if (!chat) {
      throw new Error('No chat found')
    }

    const { chatInstance, chatThread, selectedModel } = chat

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

    chatInstance.sendMessage({
      text,
      metadata: {
        modelId: selectedModel.id,
      },
    })

    trackEvent('chat_send_prompt', {
      model: selectedModel,
      length: text.length,
      prompt_number: chatInstance.messages.length + 1,
    })
  },

  setSelectedModel: async (chatId, modelId) => {
    const { models, chats } = get()

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    const chat = chats.get(chatId)

    if (!chat) {
      throw new Error('No chat found')
    }

    const updatedChats = new Map(chats)
    updatedChats.set(chatId, { ...chat, selectedModel: model })

    set({ chats: updatedChats })

    updateSettings({ selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },
}))
