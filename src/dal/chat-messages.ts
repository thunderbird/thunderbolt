import { and, desc, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { chatMessagesTable } from '../db/tables'
import type { ChatMessage, ThunderboltUIMessage, UIMessageMetadata } from '../types'
import { convertUIMessageToDbChatMessage } from '../lib/utils'
import { getChatThread, updateChatThread } from './chat-threads'

/**
 * Gets a single chat message by ID (excluding soft-deleted)
 */
export const getMessage = async (messageId: string): Promise<ChatMessage | undefined> => {
  const db = DatabaseSingleton.instance.db
  return (await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.id, messageId), isNull(chatMessagesTable.deletedAt)))
    .get()) as ChatMessage | undefined
}

/**
 * Gets all chat messages for a specific thread (excluding soft-deleted)
 */
export const getChatMessages = async (threadId: string): Promise<ChatMessage[]> => {
  const db = DatabaseSingleton.instance.db
  return (await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
    .orderBy(chatMessagesTable.id)) as ChatMessage[]
}

/**
 * Gets the last message in a thread (excluding soft-deleted)
 */
export const getLastMessage = async (threadId: string): Promise<ChatMessage | null> => {
  const db = DatabaseSingleton.instance.db

  const lastMessage = await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
    .orderBy(desc(chatMessagesTable.id))
    .limit(1)
    .get()

  return (lastMessage ?? null) as ChatMessage | null
}

/**
 * Saves messages to a chat thread and updates context size if available
 * @param threadId - The ID of the chat thread
 * @param messages - Array of UI messages to save
 * @returns The saved database messages
 * @throws Error if thread is not found
 */
export const saveMessagesWithContextUpdate = async (
  threadId: string,
  messages: ThunderboltUIMessage[],
): Promise<ChatMessage[]> => {
  const db = DatabaseSingleton.instance.db

  // Verify thread exists
  const thread = await getChatThread(threadId)
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

  // Insert-first pattern for PowerSync compatibility.
  // PowerSync uses views which don't support ON CONFLICT, so we can't use upsert.
  // Try insert first, then update on unique constraint violation to avoid race conditions
  // when multiple components save messages simultaneously.
  for (const msg of dbChatMessages) {
    try {
      await db.insert(chatMessagesTable).values(msg)
    } catch {
      await db
        .update(chatMessagesTable)
        .set({
          content: msg.content,
          parts: msg.parts,
          role: msg.role,
          parentId: msg.parentId,
          metadata: msg.metadata,
        })
        .where(eq(chatMessagesTable.id, msg.id))
    }
  }

  // Update context size if available in latest message
  const latestMessage = messages[messages.length - 1]
  const metadata = latestMessage?.metadata as UIMessageMetadata | undefined

  if (metadata?.usage?.totalTokens) {
    await updateChatThread(threadId, { contextSize: metadata.usage.totalTokens })
  }

  return dbChatMessages
}

/**
 * Updates a specific cache field for a message
 * Uses flat key-value storage with camelCase namespace (e.g., "linkPreview/https://example.com")
 */
export const updateMessageCache = async (messageId: string, cacheKey: string, value: unknown): Promise<void> => {
  const db = DatabaseSingleton.instance.db

  // Fetch current message
  const message = await getMessage(messageId)

  if (!message) {
    throw new Error('Message not found')
  }

  // Simple flat key-value storage
  const updatedCache = { ...(message.cache || {}), [cacheKey]: value } as typeof message.cache
  await db.update(chatMessagesTable).set({ cache: updatedCache }).where(eq(chatMessagesTable.id, messageId))
}

export const updateMessage = async (messageId: string, message: Partial<ChatMessage>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(chatMessagesTable).set(message).where(eq(chatMessagesTable.id, messageId))
}
