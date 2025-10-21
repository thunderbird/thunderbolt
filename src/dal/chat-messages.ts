import { desc, eq, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { chatMessagesTable, chatThreadsTable } from '../db/tables'
import { convertUIMessageToDbChatMessage } from '../lib/utils'
import type { ThunderboltUIMessage, UIMessageMetadata } from '../types'

/**
 * Gets a single chat message by ID
 */
export const getMessage = async (messageId: string) => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId)).get()
}

/**
 * Gets all chat messages for a specific thread
 */
export const getChatMessages = async (threadId: string) => {
  const db = DatabaseSingleton.instance.db
  const chatMessages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatThreadId, threadId))
    .orderBy(chatMessagesTable.id)
  return chatMessages
}

export const getLastMessage = async (threadId: string) => {
  const db = DatabaseSingleton.instance.db

  return await db
    .select({
      id: chatMessagesTable.id,
      chatThreadId: chatMessagesTable.chatThreadId,
      modelId: chatMessagesTable.modelId,
    })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatThreadId, threadId))
    .orderBy(desc(chatMessagesTable.id))
    .limit(1)
    .get()
}

/**
 * Saves messages to a chat thread and updates context size if available
 * @param threadId - The ID of the chat thread
 * @param messages - Array of UI messages to save
 * @returns The saved database messages
 * @throws Error if thread is not found
 */
export const saveMessagesWithContextUpdate = async (threadId: string, messages: ThunderboltUIMessage[]) => {
  const db = DatabaseSingleton.instance.db

  // Verify thread exists
  const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
  if (!thread) {
    throw new Error('Thread not found')
  }

  // Get the last message in the thread to use as parent for new messages
  const lastMessage = await getLastMessage(threadId)
  const parentId = lastMessage?.id ?? null

  // Convert UI messages to DB messages with parent relationship
  const dbChatMessages = messages.map((message, index) => {
    // For the first message in this batch, use the last message in the thread as parent
    // For subsequent messages in the batch, use the previous message in the batch
    const messageParentId = index === 0 ? parentId : messages[index - 1].id
    return convertUIMessageToDbChatMessage(message, threadId, messageParentId)
  })

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
        parentId: sql`excluded.parent_id`,
      },
    })

  // Update context size if available in latest message
  const latestMessage = messages[messages.length - 1]
  const metadata = latestMessage?.metadata as UIMessageMetadata | undefined

  if (metadata?.usage?.totalTokens) {
    await db
      .update(chatThreadsTable)
      .set({ contextSize: metadata.usage.totalTokens })
      .where(eq(chatThreadsTable.id, threadId))
  }

  return dbChatMessages
}

/**
 * Updates a specific cache field for a message
 * Uses JSON patch-like syntax for nested keys (e.g., "linkPreviews.https://example.com")
 * Note: Only splits on the FIRST dot to avoid splitting URLs
 */
export const updateMessageCache = async (messageId: string, cachePath: string, value: unknown) => {
  const db = DatabaseSingleton.instance.db

  // Fetch current message
  const message = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId)).get()

  if (!message) {
    throw new Error('Message not found')
  }

  // Split only on the first dot to handle URLs properly
  // e.g., "linkPreviews.https://example.com" -> ["linkPreviews", "https://example.com"]
  const firstDotIndex = cachePath.indexOf('.')

  if (firstDotIndex === -1) {
    // No nested path, just set at root level
    const updatedCache = { ...(message.cache || {}), [cachePath]: value }
    await db.update(chatMessagesTable).set({ cache: updatedCache }).where(eq(chatMessagesTable.id, messageId))
    return
  }

  const rootKey = cachePath.slice(0, firstDotIndex)
  const subKey = cachePath.slice(firstDotIndex + 1)

  // Create or update the nested structure
  const updatedCache: Record<string, any> = { ...(message.cache || {}) }
  if (!updatedCache[rootKey]) {
    updatedCache[rootKey] = {}
  }
  updatedCache[rootKey] = { ...updatedCache[rootKey], [subKey]: value }

  // Update the database
  await db.update(chatMessagesTable).set({ cache: updatedCache }).where(eq(chatMessagesTable.id, messageId))
}
