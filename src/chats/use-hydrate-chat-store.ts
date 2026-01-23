import {
  getAllModes,
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSelectedMode,
  getSettings,
  getTriggerPromptForThread,
  isChatThreadDeleted,
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
  isNew: boolean
}

export const useHydrateChatStore = ({ id, isNew }: UseHydrateChatStoreParams) => {
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
    const { createSession, sessions, setCurrentSessionId, setMcpClients, setModes, setModels } = useChatStore.getState()

    // Check if this ID belongs to a deleted chat - redirect to 404 if so
    const isDeleted = await isChatThreadDeleted(id)
    if (isDeleted) {
      navigate('/not-found', { replace: true })
      return
    }

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [modes, models, mcpClients] = await Promise.all([getAllModes(), getAvailableModels(), getEnabledClients()])

      setMcpClients(mcpClients)
      setModes(modes)
      setModels(models)

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings({ selected_model: String })

    const [defaultModel, selectedMode, chatThread, initialMessages, modes, models, triggerData, mcpClients] =
      await Promise.all([
        getDefaultModelForThread(id, settings.selectedModel ?? undefined),
        getSelectedMode(),
        getChatThread(id),
        getChatMessages(id),
        getAllModes(),
        getAvailableModels(),
        getTriggerPromptForThread(id),
        getEnabledClients(),
      ])

    // If chat doesn't exist and this isn't a new chat, redirect to 404
    if (!chatThread && !isNew) {
      navigate('/not-found', { replace: true })
      return
    }

    const chatInstance = createChatInstance(
      id,
      initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
      saveMessages,
    )

    createSession({
      chatInstance,
      chatThread,
      id,
      selectedMode,
      selectedModel: defaultModel,
      triggerData,
    })

    setCurrentSessionId(id)

    setMcpClients(mcpClients)
    setModes(modes)
    setModels(models)

    setIsReady(true)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
