import {
  getAvailableModels,
  getChatMessages,
  getOrCreateChatThread,
  getTriggerPromptForThread,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { AutomationRun, ChatThread, Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, type PropsWithChildren, useCallback, useContext, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { getChatThread, updateChatThread } from '@/dal/chat-threads'

type ChatDataState = {
  chatThread: ChatThread | null
  id: string
  initialMessages: ThunderboltUIMessage[]
  models: Model[]
  saveMessages: SaveMessagesFunction
  triggerData: AutomationRun | null
}

const ChatDataContext = createContext<ChatDataState>({} as ChatDataState)

export function ChatDataProvider({ children }: PropsWithChildren) {
  const navigate = useNavigate()
  const params = useParams()

  const isNew = useMemo(() => params.chatThreadId === 'new', [params.chatThreadId])

  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [isNew, params.chatThreadId])

  const { data: chatThread = null } = useQuery({
    queryKey: ['chatThreads', id],
    queryFn: () => getChatThread(id!),
    enabled: !!id && !isNew,
  })

  const { data: initialMessages = [], isLoading: isLoadingInitialMessages } = useQuery<ThunderboltUIMessage[], Error>({
    queryKey: ['chatMessages', id],
    queryFn: async () => {
      const chatMessages = await getChatMessages(id!)
      return chatMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]
    },
    enabled: !!id && !isNew,
  })

  const { data: models = [], isLoading: isLoadingModels } = useQuery({
    queryKey: ['models'],
    queryFn: getAvailableModels,
    enabled: !!id,
  })

  // Load the automation prompt that triggered this chat, if any
  const { data: triggerData = null } = useQuery({
    queryKey: ['triggerPrompt', id],
    queryFn: () => getTriggerPromptForThread(id!),
    enabled: !!id && !isNew,
  })

  const queryClient = useQueryClient()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) return

    const textContent = firstUserMessage.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')

    if (!textContent) return

    const title = await generateTitle(textContent)
    await updateChatThread(threadId, { title })
    queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
  }

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: ThunderboltUIMessage[]) => {
      if (!id) {
        throw new Error('No chat thread ID')
      }

      const modelId = messages[0]?.metadata?.modelId

      // Fetch thread info to check if we need to generate a title
      const thread = await getOrCreateChatThread(id, modelId ?? '')

      // Save messages and update context size using DAL
      const dbChatMessages = await saveMessagesWithContextUpdate(id, messages)

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, id)
      }

      if (isNew) {
        navigate(`/chats/${id}`, { relative: 'path' })
      }

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', id] })

      return dbChatMessages
    },
    onSuccess: () => {
      // Invalidate and refetch messages after adding a new one
      queryClient.invalidateQueries({ queryKey: ['chatMessages', id] })
      // Also invalidate chat threads to update the sidebar
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    },
  })

  const saveMessages: SaveMessagesFunction = useCallback(
    async ({ messages }) => {
      await addMessagesMutation.mutateAsync(messages)
    },
    [addMessagesMutation],
  )

  if (!id) {
    return <div>No chat thread ID</div>
  }

  if (isLoadingInitialMessages || isLoadingModels) {
    return null
  }

  return (
    <ChatDataContext.Provider
      value={{
        chatThread,
        id,
        initialMessages,
        models,
        saveMessages,
        triggerData,
      }}
    >
      {children}
    </ChatDataContext.Provider>
  )
}

export const useChatData = () => {
  const context = useContext(ChatDataContext)

  if (context === undefined) throw new Error('useChatData must be used within a ChatDataProvider')

  return context
}
