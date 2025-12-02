import { updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import type { AutomationRun, ChatThread, Model, ThunderboltUIMessage } from '@/types'
import { type Chat } from '@ai-sdk/react'
import { create } from 'zustand'

type ChatItem = {
  chatInstance: Chat<ThunderboltUIMessage> | null
  chatThread: ChatThread | null
  id: string
  selectedModel: Model | null
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  chats: Map<string, ChatItem>
  selectedChatId: string | null
  mcpClients: MCPClient[]
  models: Model[]
}

type ChatStoreActions = {
  setSelectedChat(data: { chat: ChatItem; mcpClients: MCPClient[]; models: Model[] }): void
  sendMessage(text: string): Promise<void>
  setSelectedModel(modelId: string | null): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  chats: new Map(),
  selectedChatId: null,
  mcpClients: [],
  models: [],
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,

  setSelectedChat: ({ chat, mcpClients, models }) => {
    const { chats } = get()

    const updatedChats = new Map(chats)

    if (!updatedChats.has(chat.id)) {
      updatedChats.set(chat.id, chat)
    }

    set({
      chats: updatedChats,
      selectedChatId: chat.id,
      mcpClients,
      models,
    })
  },

  sendMessage: async (text) => {
    const { chats, selectedChatId } = get()

    if (!selectedChatId) {
      throw new Error('No selected chat')
    }

    const chat = chats.get(selectedChatId)

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

  setSelectedModel: async (modelId) => {
    const { models, chats, selectedChatId } = get()

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    if (!selectedChatId) {
      throw new Error('No selected chat')
    }

    const chat = chats.get(selectedChatId)

    if (!chat) {
      throw new Error('No chat found')
    }

    const updatedChats = new Map(chats)
    updatedChats.set(selectedChatId, { ...chat, selectedModel: model })

    set({ chats: updatedChats })

    updateSettings({ selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },
}))
