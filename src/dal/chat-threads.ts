import { desc, eq } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { chatThreadsTable } from '../db/tables'

/**
 * Gets all chat threads ordered by creation date
 */
export const getAllChatThreads = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))
}

/**
 * Gets a specific chat thread by ID
 */
export const getChatThread = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
}

/**
 * Create a new chat thread
 */
export const createChatThread = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  await db.insert(chatThreadsTable).values({ id, title: 'New Chat' })
}

/**
 * Gets a specific chat thread by ID or create a new one with the provided ID
 */
export const getOrCreateChatThread = async (id: string) => {
  const thread = await getChatThread(id)

  if (thread?.id) {
    return thread
  }

  await createChatThread(id)

  return await getChatThread(id)
}

/**
 * Gets the context size for a chat thread
 * @param threadId - The ID of the chat thread
 * @returns The context size in tokens, or null if not found/not known
 */
export const getContextSizeForThread = async (threadId: string): Promise<number | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db
    .select({ contextSize: chatThreadsTable.contextSize })
    .from(chatThreadsTable)
    .where(eq(chatThreadsTable.id, threadId))
    .get()

  return thread?.contextSize ?? null
}

/**
 * Deletes a specific chat thread by ID
 */
export const deleteChatThread = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  await db.delete(chatThreadsTable).where(eq(chatThreadsTable.id, id))
}

/**
 * Deletes all chat threads
 */
export const deleteAllChatThreads = async () => {
  const db = DatabaseSingleton.instance.db
  await db.delete(chatThreadsTable)
}
