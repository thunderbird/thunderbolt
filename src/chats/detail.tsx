import { chatMessagesTable, chatThreadsTable, modelsTable, settingsTable } from '@/db/tables'
import { useDatabase } from '@/hooks/use-database'
import { createModel } from '@/lib/ai'
import { convertDbChatMessageToUIMessage, convertUIMessageToDbChatMessage } from '@/lib/utils'
import { SaveMessagesFunction } from '@/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UIMessage, generateText } from 'ai'
import { eq, sql } from 'drizzle-orm'
import { useParams } from 'react-router'
import Chat from './chat'

export default function ChatDetailPage() {
  const params = useParams()
  const { db } = useDatabase()
  const queryClient = useQueryClient()

  const {
    data: messages,
    isLoading,
    isError,
  } = useQuery<UIMessage[], Error>({
    queryKey: ['chatMessages', params.chatThreadId],
    queryFn: async () => {
      const chatMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, params.chatThreadId!)).orderBy(chatMessagesTable.id)
      return chatMessages.map(convertDbChatMessageToUIMessage)
    },
    enabled: !!params.chatThreadId,
  })

  const addMessagesMutation = useMutation({
    mutationFn: async (messages: UIMessage[]) => {
      if (!params.chatThreadId) {
        throw new Error('No chat thread ID')
      }

      const dbChatMessages = messages.map((message) => convertUIMessageToDbChatMessage(message, params.chatThreadId!))

      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, params.chatThreadId!)).get()

      if (!thread) {
        throw new Error('Thread not found')
      }

      // Check if this is the first message and if we're using a confidential model
      const existingMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, params.chatThreadId!)).limit(1)

      if (existingMessages.length === 0 && !thread.isEncrypted) {
        // Get the selected model to check if it's confidential
        const selectedModelId = await db.select().from(settingsTable).where(eq(settingsTable.key, 'selected_model')).get()
        if (selectedModelId) {
          const model = await db
            .select()
            .from(modelsTable)
            .where(eq(modelsTable.id, selectedModelId.value as string))
            .get()

          if (model && model.isConfidential) {
            // Update thread to be encrypted
            await db.update(chatThreadsTable).set({ isEncrypted: 1 }).where(eq(chatThreadsTable.id, params.chatThreadId!))
          }
        }
      }

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

      if (thread.title !== 'New Chat') {
        return dbChatMessages
      }

      try {
        // Generate a title based on the first message
        const firstMessage = messages.find((msg) => msg.role === 'user')
        if (!firstMessage) {
          throw new Error('No first message found')
        }

        // Extract text content from message parts
        const messageContent =
          firstMessage.parts
            ?.filter((part) => part.type === 'text')
            .map((part) => (part as any).text)
            .join(' ') || ''

        if (messageContent) {
          const model = await createModel({
            id: 'system',
            name: 'System',
            provider: 'thunderbolt',
            model: 'llama-v3p1-70b-instruct',
            url: null,
            apiKey: null,
            isSystem: 1,
            enabled: 1,
            toolUsage: 0,
            isConfidential: 0,
          })

          const { text } = await generateText({
            model,
            prompt: `Generate a concise title-cased title (max 30 characters) for a chat conversation that starts with this message: "${messageContent}". Return only the title, no quotes or punctuation.`,
          })

          // Update the thread title
          await db.update(chatThreadsTable).set({ title: text.trim() }).where(eq(chatThreadsTable.id, params.chatThreadId!))
        }
      } catch (error) {
        console.error('Error generating title:', error)
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
          <Chat key={params.chatThreadId} id={params.chatThreadId} initialMessages={messages} saveMessages={saveMessages} />
        ) : (
          <div>Error loading chat</div>
        )}
      </div>
    </>
  ) : (
    <div>No chat thread ID</div>
  )
}
