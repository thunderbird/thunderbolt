import {
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSettings,
  getTriggerPromptForThread,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { trackEvent } from '@/lib/posthog'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { useChatStore } from './chat-store'
import { aiFetchStreamingResponse } from '@/ai/fetch'
import { useMCP } from '@/lib/mcp-provider'
import { generateTitle } from '@/lib/title-generator'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { useQueryClient } from '@tanstack/react-query'

type UseHydrateChatStoreParams = {
  id: string
  isNew: boolean
}

const createChatInstance = (id: string, messages: ThunderboltUIMessage[], saveMessages: SaveMessagesFunction) => {
  // Stable fetch function that always reads the latest model id from the ref
  const customFetch = Object.assign(
    async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
      if (!init) throw new Error('Missing init')

      const { mcpClients, selectedModel } = useChatStore.getState()

      if (!selectedModel) throw new Error('No model selected')

      return aiFetchStreamingResponse({
        init,
        saveMessages,
        modelId: selectedModel.id,
        mcpClients,
      })
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )

  const instance = new Chat<ThunderboltUIMessage>({
    id,
    messages,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    // Automatically send messages when the last one is a user message (used for automations)
    sendAutomaticallyWhen: ({ messages }) => messages.length > 0 && messages[messages.length - 1].role === 'user',
    onFinish: async ({ message }) => {
      const { selectedModel } = useChatStore.getState()

      await saveMessages({ id, messages: [message] })

      trackEvent('chat_receive_reply', {
        model: selectedModel,
        length: message.parts?.reduce((acc, part) => acc + (part.type === 'text' ? part.text.length : 0), 0) || 0,
        reply_number: instance.messages.length + 1,
      })
    },
    onError: (error) => {
      console.error('Chat error:', error)
      // The error will be available in chatHelpers.error for the UI to display
    },
  })

  return instance
}

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
  const navigate = useNavigate()

  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients } = useMCP()

  const queryClient = useQueryClient()

  const updateThreadTitle = useCallback(
    async (messages: ThunderboltUIMessage[], threadId: string) => {
      const firstUserMessage = messages.find((msg) => msg.role === 'user')
      if (!firstUserMessage) return

      const textContent = firstUserMessage.parts
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')

      if (!textContent) return

      const title = await generateTitle(textContent)
      await updateChatThread(threadId, { title })

      // Also invalidate chat threads to update the sidebar
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    },
    [queryClient],
  )

  const saveMessages = useCallback<SaveMessagesFunction>(
    async ({ messages }) => {
      const selectedModel = useChatStore.getState().selectedModel

      if (!selectedModel) {
        throw new Error('No selected model')
      }

      // Fetch thread info to check if we need to generate a title
      const thread = await getOrCreateChatThread(id!, selectedModel.id)

      // Save messages and update context size using DAL
      await saveMessagesWithContextUpdate(id!, messages)

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', id] })

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, id!)
      }

      if (isNew) {
        navigate(`/chats/${id}`, { relative: 'path' })
      }
    },
    [id, isNew, navigate, queryClient, updateThreadTitle],
  )

  const hydrateChatStore = useCallback(async () => {
    const settings = await getSettings({ selected_model: String })

    const [defaultModel, chatThread, initialMessages, models, triggerData, mcpClients] = await Promise.all([
      getDefaultModelForThread(id, settings.selectedModel ?? undefined),
      getChatThread(id),
      getChatMessages(id),
      getAvailableModels(),
      getTriggerPromptForThread(id),
      getEnabledClients(),
    ])

    const chatInstance = createChatInstance(
      id,
      initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
      saveMessages,
    )

    const { hydrate, reset } = useChatStore.getState()

    reset()

    hydrate({
      chatInstance,
      chatThread,
      hasMessages: initialMessages.length > 0,
      id,
      mcpClients,
      models,
      selectedModel: defaultModel,
      triggerData,
    })

    setIsReady(true)
  }, [getEnabledClients, id, saveMessages])

  return { hydrateChatStore, isReady, saveMessages }
}
