import { desc, eq } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { chatThreadsTable } from '../db/tables'
import { type ChatThread } from '@/types'

/**
 * Gets all chat threads ordered by creation date
 */
export const getAllChatThreads = async (): Promise<ChatThread[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))
}

/**
 * Gets a specific chat thread by ID
 */
export const getChatThread = async (id: string): Promise<ChatThread | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
  return thread ?? null
}

/**
 * Create a new chat thread
 */
export const createChatThread = async (data: Partial<ChatThread> & Required<Pick<ChatThread, 'id'>>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(chatThreadsTable).values(data)
}

export const updateChatThread = async (
  id: string,
  data: Partial<Omit<ChatThread, 'id' | 'isEncrypted'>>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(chatThreadsTable).set(data).where(eq(chatThreadsTable.id, id))
}

/**
 * Gets a specific chat thread by ID or create a new one with the provided ID
 */
export const getOrCreateChatThread = async (id: string, isEncrypted: boolean): Promise<ChatThread> => {
  const thread = await getChatThread(id)

  if (thread?.id) {
    return thread
  }

  await createChatThread({
    id,
    title: 'New Chat',
    isEncrypted: isEncrypted ? 1 : 0,
  })

  return (await getChatThread(id))! // We know the thread exists because we just created it
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
export const deleteChatThread = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(chatThreadsTable).where(eq(chatThreadsTable.id, id))
}

/**
 * Deletes all chat threads
 */
export const deleteAllChatThreads = async (): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(chatThreadsTable)
}
