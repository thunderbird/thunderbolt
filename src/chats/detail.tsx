import { chatThreadsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { getChatThreadById, saveMessagesWithContextUpdate } from '@/lib/dal'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { useParams } from 'react-router'
import Chat from './chat'
import { getChatMessagesByThreadId } from '@/lib/dal'

export default function ChatDetailPage() {
  const params = useParams()
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) return

    const textContent = firstUserMessage.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')

    if (!textContent) return

    try {
      const title = await generateTitle(textContent)
      await db.update(chatThreadsTable).set({ title }).where(eq(chatThreadsTable.id, threadId))
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    } catch (error) {
      console.error('Error generating title:', error)
    }
  }

  const {
    data: messages,
    isLoading,
    isError,
  } = useQuery<ThunderboltUIMessage[], Error>({
    queryKey: ['chatMessages', params.chatThreadId],
    queryFn: async () => {
      const chatMessages = await getChatMessagesByThreadId(params.chatThreadId!)
      return chatMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]
    },
    enabled: !!params.chatThreadId,
  })

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: ThunderboltUIMessage[]) => {
      if (!params.chatThreadId) {
        throw new Error('No chat thread ID')
      }

      // Save messages and update context size using DAL
      const dbChatMessages = await saveMessagesWithContextUpdate(params.chatThreadId, messages)

      // Fetch thread info to check if we need to generate a title
      const thread = await getChatThreadById(params.chatThreadId)

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, params.chatThreadId)
      }

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', params.chatThreadId] })

      return dbChatMessages
    },
    onSuccess: () => {
      // Invalidate and refetch messages after adding a new one
      queryClient.invalidateQueries({ queryKey: ['chatMessages', params.chatThreadId] })
      // Also invalidate chat threads to update the sidebar
      queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
    },
  })

  const saveMessages: SaveMessagesFunction = async ({ messages }) => {
    await addMessagesMutation.mutateAsync(messages)
  }

  return params.chatThreadId ? (
    <>
      <div className="h-full w-full">
        {isLoading ? (
          <div>Loading chat...</div>
        ) : isError ? (
          <div>Error loading chat</div>
        ) : messages ? (
          <Chat
            key={params.chatThreadId}
            id={params.chatThreadId}
            initialMessages={messages}
            saveMessages={saveMessages}
          />
        ) : (
          <div>Error loading chat</div>
        )}
      </div>
    </>
  ) : (
    <div>No chat thread ID</div>
  )
}
