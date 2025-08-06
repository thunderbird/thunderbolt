import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { generateTitle } from '@/lib/title-generator'
import { convertDbChatMessageToUIMessage, convertUIMessageToDbChatMessage } from '@/lib/utils'
import { SaveMessagesFunction, type ThunderboltUIMessage } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eq, sql } from 'drizzle-orm'
import { useParams } from 'react-router'
import Chat from './chat'

export default function ChatDetailPage() {
  const params = useParams()
  const { db } = useDatabase()
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
      const chatMessages = await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatThreadId, params.chatThreadId!))
        .orderBy(chatMessagesTable.id)
      return chatMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[]
    },
    enabled: !!params.chatThreadId,
  })

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: ThunderboltUIMessage[]) => {
      if (!params.chatThreadId) {
        throw new Error('No chat thread ID')
      }

      // Fetch thread info first
      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, params.chatThreadId!)).get()

      if (!thread) {
        throw new Error('Thread not found')
      }

      // Map UI messages to DB messages, using modelId from metadata when available
      const dbChatMessages = messages.map((message) => convertUIMessageToDbChatMessage(message, params.chatThreadId!))

      // Insert messages
      await db
        .insert(chatMessagesTable)
        .values(dbChatMessages)
        .onConflictDoUpdate({
          target: chatMessagesTable.id,
          set: {
            content: sql`excluded.content`,
            parts: sql`excluded.parts`,
            role: sql`excluded.role`,
          },
        })

      // Generate title in background if needed
      if (thread.title === 'New Chat') {
        updateThreadTitle(messages, params.chatThreadId!)
      }

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
