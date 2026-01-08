import { and, desc, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { chatMessagesTable, chatThreadsTable } from '../db/tables'
import { type ChatThread } from '@/types'
import { getModel } from './models'

/**
 * Gets all chat threads ordered by creation date (excluding soft-deleted)
 */
export const getAllChatThreads = async (): Promise<ChatThread[]> => {
  const db = DatabaseSingleton.instance.db
  return await db
    .select()
    .from(chatThreadsTable)
    .where(isNull(chatThreadsTable.deletedAt))
    .orderBy(desc(chatThreadsTable.id))
}

/**
 * Gets a specific chat thread by ID (excluding soft-deleted)
 */
export const getChatThread = async (id: string): Promise<ChatThread | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db
    .select()
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, id), isNull(chatThreadsTable.deletedAt)))
    .get()
  return thread ?? null
}

/**
 * Create a new chat thread
 */
export const createChatThread = async (
  data: Pick<ChatThread, 'contextSize' | 'id' | 'title' | 'triggeredBy' | 'wasTriggeredByAutomation'>,
  modelId: string,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db

  const model = await getModel(modelId)

  if (!model) {
    throw new Error('No model found')
  }

  await db.insert(chatThreadsTable).values({ ...data, isEncrypted: model.isConfidential })
}

export const updateChatThread = async (
  id: string,
  data: Partial<Pick<ChatThread, 'contextSize' | 'title' | 'triggeredBy' | 'wasTriggeredByAutomation'>>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(chatThreadsTable).set(data).where(eq(chatThreadsTable.id, id))
}

/**
 * Gets a specific chat thread by ID or create a new one with the provided ID
 */
export const getOrCreateChatThread = async (id: string, modelId: string): Promise<ChatThread> => {
  const thread = await getChatThread(id)

  if (thread?.id) {
    return thread
  }

  await createChatThread(
    {
      id,
      title: 'New Chat',
      contextSize: null,
      triggeredBy: null,
      wasTriggeredByAutomation: 0,
    },
    modelId,
  )

  return (await getChatThread(id))! // We know the thread exists because we just created it
}

/**
 * Gets the context size for a chat thread (excluding soft-deleted)
 * @param threadId - The ID of the chat thread
 * @returns The context size in tokens, or null if not found/not known
 */
export const getContextSizeForThread = async (threadId: string): Promise<number | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db
    .select({ contextSize: chatThreadsTable.contextSize })
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, threadId), isNull(chatThreadsTable.deletedAt)))
    .get()

  return thread?.contextSize ?? null
}

/**
 * Soft deletes a specific chat thread by ID (sets deletedAt timestamp)
 * Also soft-deletes all associated messages that haven't been deleted yet
 */
export const deleteChatThread = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const deletedAt = Date.now()
  await db
    .update(chatMessagesTable)
    .set({ deletedAt })
    .where(and(eq(chatMessagesTable.chatThreadId, id), isNull(chatMessagesTable.deletedAt)))
  await db
    .update(chatThreadsTable)
    .set({ deletedAt })
    .where(and(eq(chatThreadsTable.id, id), isNull(chatThreadsTable.deletedAt)))
}

/**
 * Soft deletes all chat threads (sets deletedAt timestamp)
 * Also soft-deletes all associated messages
 * Only updates records that haven't been deleted yet to preserve original deletion timestamps
 */
export const deleteAllChatThreads = async (): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const deletedAt = Date.now()
  await db.update(chatMessagesTable).set({ deletedAt }).where(isNull(chatMessagesTable.deletedAt))
  await db.update(chatThreadsTable).set({ deletedAt }).where(isNull(chatThreadsTable.deletedAt))
}
