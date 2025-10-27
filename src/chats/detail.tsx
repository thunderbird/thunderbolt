import { getAvailableModels, getChatMessages, getOrCreateChatThread, saveMessagesWithContextUpdate } from '@/dal'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { updateChatThread } from '@/dal/chat-threads'
import ChatState from './chat-state'

type ChatId = {
  id: string | null
  isNew: boolean
}

const useChatId = (): ChatId => {
  const params = useParams()

  const isNew = useMemo(() => params.chatThreadId === 'new', [params.chatThreadId])

  const id = useMemo(() => (isNew ? uuidv7() : params.chatThreadId || null), [isNew, params.chatThreadId])

  return {
    id,
    isNew,
  }
}

const useChatQuery = (chatId: ChatId) => {
  const { data: messages = [], isLoading: isLoadingMessages } = useQuery<ThunderboltUIMessage[], Error>({
    queryKey: ['chatMessages', chatId.id],
    queryFn: async () => {
      const chatMessages = await getChatMessages(chatId.id!)
      return chatMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]
    },
    enabled: !!chatId.id && !chatId.isNew,
  })

  const { data: models = [], isLoading: isLoadingModels } = useQuery({
    queryKey: ['models'],
    queryFn: getAvailableModels,
    enabled: !!chatId.id,
  })

  return {
    isLoading: isLoadingMessages || isLoadingModels,
    messages,
    models,
  }
}

const useChatMutation = (chatId: ChatId) => {
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

  const navigate = useNavigate()

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: ThunderboltUIMessage[]) => {
      if (!chatId.id) {
        throw new Error('No chat thread ID')
      }

      const modelId = messages[0]?.metadata?.modelId

      // Fetch thread info to check if we need to generate a title
      const thread = await getOrCreateChatThread(chatId.id, modelId ?? '')

      // Save messages and update context size using DAL
      const dbChatMessages = await saveMessagesWithContextUpdate(chatId.id, messages)

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, chatId.id)
      }

      if (chatId.isNew) {
        navigate(`/chats/${chatId.id}`, { relative: 'path' })
      }

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', chatId.id] })

      return dbChatMessages
    },
    onSuccess: () => {
      // Invalidate and refetch messages after adding a new one
      queryClient.invalidateQueries({ queryKey: ['chatMessages', chatId.id] })
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

  return { saveMessages }
}

export default function ChatDetailPage() {
  const chatId = useChatId()

  const { isLoading, messages, models } = useChatQuery(chatId)

  const { saveMessages } = useChatMutation(chatId)

  if (!chatId.id) {
    return <div>No chat thread ID</div>
  }

  if (isLoading) {
    return null
  }

  return (
    <div className="h-full w-full">
      <ChatState
        key={chatId.id}
        id={chatId.id}
        initialMessages={messages}
        models={models}
        saveMessages={saveMessages}
      />
    </div>
  )
}
