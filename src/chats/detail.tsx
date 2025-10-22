import { getModel, getChatMessages, getOrCreateChatThread, saveMessagesWithContextUpdate } from '@/dal'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import Chat from './chat'
import { updateChatThread } from '@/dal/chat-threads'

export default function ChatDetailPage() {
  const params = useParams()

  const chatThreadId = useMemo(
    () => (params.chatThreadId === 'new' ? uuidv7() : params.chatThreadId),
    [params.chatThreadId],
  )

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

  const { data: messages } = useQuery<ThunderboltUIMessage[], Error>({
    queryKey: ['chatMessages', chatThreadId],
    queryFn: async () => {
      const chatMessages = await getChatMessages(chatThreadId!)
      return chatMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]
    },
    enabled: !!chatThreadId,
  })

  const navigate = useNavigate()

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: ThunderboltUIMessage[]) => {
      if (!chatThreadId) {
        throw new Error('No chat thread ID')
      }

      const modelId = messages[0]?.metadata?.modelId

      // Fetch thread info to check if we need to generate a title
      const thread = await getOrCreateChatThread(chatThreadId, modelId)

      // Save messages and update context size using DAL
      const dbChatMessages = await saveMessagesWithContextUpdate(chatThreadId, messages)

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, chatThreadId)
      }

      if (params.chatThreadId === 'new') {
        navigate(`/chats/${chatThreadId}`, { relative: 'path' })
      }

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', chatThreadId] })

      return dbChatMessages
    },
    onSuccess: () => {
      // Invalidate and refetch messages after adding a new one
      queryClient.invalidateQueries({ queryKey: ['chatMessages', chatThreadId] })
      // Also invalidate chat threads to update the sidebar
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    },
  })

  const saveMessages: SaveMessagesFunction = useCallback(
    async ({ messages }) => {
      await addMessagesMutation.mutateAsync(messages)
    },
    [addMessagesMutation.mutateAsync],
  )

  return chatThreadId ? (
    <>
      <div className="h-full w-full">
        {!!messages && (
          <Chat key={chatThreadId} id={chatThreadId} initialMessages={messages} saveMessages={saveMessages} />
        )}
      </div>
    </>
  ) : (
    <div>No chat thread ID</div>
  )
}
