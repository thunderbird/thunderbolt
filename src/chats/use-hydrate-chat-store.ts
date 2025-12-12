import {
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSettings,
  getTriggerPromptForThread,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { useMCP } from '@/lib/mcp-provider'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'
import { createChatInstance } from './chat-instance'

type UseHydrateChatStoreParams = {
  id: string
}

export const useHydrateChatStore = ({ id }: UseHydrateChatStoreParams) => {
  const navigate = useNavigate()

  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients } = useMCP()

  const queryClient = useQueryClient()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) return

    const textContent = firstUserMessage.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')

    if (!textContent) return

    const title = await generateTitle(textContent)
    await updateChatThread(threadId, { title })

    // Also invalidate chat threads to update the sidebar
    queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
  }

  const saveMessages: SaveMessagesFunction = async ({ id, messages }) => {
    const { sessions, updateSession } = useChatStore.getState()

    const session = sessions.get(id)

    if (!session) throw new Error('No session found')

    // Fetch thread info to check if we need to generate a title
    const thread = await getOrCreateChatThread(id, session.selectedModel.id)

    // Save messages and update context size using DAL
    await saveMessagesWithContextUpdate(id, messages)

    // Invalidate context size query to trigger re-fetch
    queryClient.invalidateQueries({ queryKey: ['contextSize', id] })

    // Generate title in background if needed
    if (thread?.title === 'New Chat') {
      updateThreadTitle(messages, id)
    }

    if (!session.chatThread) {
      updateSession(id, { chatThread: thread })
      navigate(`/chats/${id}`, { relative: 'path' })
    }
  }

  const hydrateChatStore = async () => {
    const { createSession, sessions, setCurrentSessionId, setMcpClients, setModels } = useChatStore.getState()

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [models, mcpClients] = await Promise.all([getAvailableModels(), getEnabledClients()])

      setMcpClients(mcpClients)
      setModels(models)

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
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

    createSession({
      chatInstance,
      chatThread,
      id,
      selectedModel: defaultModel,
      triggerData,
    })

    setCurrentSessionId(id)

    setMcpClients(mcpClients)
    setModels(models)

    setIsReady(true)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
