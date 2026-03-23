import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatMessagesTable, chatThreadsTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { type ChatThread, type Model } from '@/types'
import { getModel } from './models'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Checks if a chat thread ID exists as a soft-deleted record.
 * Used to detect when a user visits a URL for a deleted chat.
 */
export const isChatThreadDeleted = async (db: AnyDrizzleDatabase, id: string): Promise<boolean> => {
  const thread = await db
    .select({ id: chatThreadsTable.id })
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, id), isNotNull(chatThreadsTable.deletedAt)))
    .get()
  return thread !== undefined
}

/**
 * Gets all chat threads ordered by creation date (excluding soft-deleted)
 */
export const getAllChatThreads = (db: AnyDrizzleDatabase) => {
  const query = db
    .select()
    .from(chatThreadsTable)
    .where(isNull(chatThreadsTable.deletedAt))
    .orderBy(desc(chatThreadsTable.id))
  return query as typeof query & DrizzleQueryWithPromise<ChatThread>
}

/**
 * Gets a specific chat thread by ID (excluding soft-deleted)
 */
export const getChatThread = async (db: AnyDrizzleDatabase, id: string): Promise<ChatThread | null> => {
  const thread = await db
    .select()
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, id), isNull(chatThreadsTable.deletedAt)))
    .get()
  return (thread ?? null) as ChatThread | null
}

/**
 * Create a new chat thread
 * @param model - Resolved model (caller must fetch via getModel);
 */
export const createChatThread = async (
  db: AnyDrizzleDatabase,
  data: Pick<ChatThread, 'contextSize' | 'id' | 'title' | 'triggeredBy' | 'wasTriggeredByAutomation'> & {
    agentId?: string | null
  },
  model: Model,
): Promise<void> => {
  await db.insert(chatThreadsTable).values({ ...data, isEncrypted: model.isConfidential })
}

/**
 * Update a chat thread
 */
export const updateChatThread = async (
  db: AnyDrizzleDatabase,
  id: string,
  data: Partial<
    Pick<ChatThread, 'agentId' | 'contextSize' | 'modeId' | 'title' | 'triggeredBy' | 'wasTriggeredByAutomation'>
  >,
): Promise<void> => {
  await db.update(chatThreadsTable).set(data).where(eq(chatThreadsTable.id, id))
}

/**
 * Gets a specific chat thread by ID or create a new one with the provided ID
 */
export const getOrCreateChatThread = async (
  db: AnyDrizzleDatabase,
  id: string,
  modelId: string,
  agentId?: string | null,
): Promise<ChatThread> => {
  const thread = await getChatThread(db, id)

  if (thread?.id) {
    return thread
  }

  // Model may not exist in local DB for external ACP agents whose model IDs
  // come from the agent's session config rather than our models table.
  const model = await getModel(db, modelId)

  await createChatThread(
    db,
    {
      id,
      title: 'New Chat',
      contextSize: null,
      triggeredBy: null,
      wasTriggeredByAutomation: 0,
      agentId: agentId ?? null,
    },
    model ?? ({ isConfidential: 0 } as Model),
  )

  return (await getChatThread(db, id))! // We know the thread exists because we just created it
}

/**
 * Gets the context size for a chat thread (excluding soft-deleted)
 * @param threadId - The ID of the chat thread
 * @returns The context size in tokens, or null if not found/not known
 */
export const getContextSizeForThread = (db: AnyDrizzleDatabase, threadId: string) => {
  const query = db
    .select({ contextSize: chatThreadsTable.contextSize })
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, threadId), isNull(chatThreadsTable.deletedAt)))
  return query as typeof query & DrizzleQueryWithPromise<{ contextSize: number | null }>
}

/**
 * Soft deletes a specific chat thread by ID (sets deletedAt datetime)
 * Also soft-deletes all associated messages that haven't been deleted yet
 * Scrubs all nullable columns for privacy
 */
export const deleteChatThread = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  const deletedAt = nowIso()
  await db.transaction(async (tx) => {
    await tx
      .update(chatMessagesTable)
      .set({ ...clearNullableColumns(chatMessagesTable), deletedAt })
      .where(and(eq(chatMessagesTable.chatThreadId, id), isNull(chatMessagesTable.deletedAt)))
    await tx
      .update(chatThreadsTable)
      .set({ ...clearNullableColumns(chatThreadsTable), deletedAt })
      .where(and(eq(chatThreadsTable.id, id), isNull(chatThreadsTable.deletedAt)))
  })
}

/**
 * Soft deletes all chat threads (sets deletedAt datetime)
 * Also soft-deletes all associated messages
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteAllChatThreads = async (db: AnyDrizzleDatabase): Promise<void> => {
  const deletedAt = nowIso()
  await db.transaction(async (tx) => {
    await tx
      .update(chatMessagesTable)
      .set({ ...clearNullableColumns(chatMessagesTable), deletedAt })
      .where(isNull(chatMessagesTable.deletedAt))
    await tx
      .update(chatThreadsTable)
      .set({ ...clearNullableColumns(chatThreadsTable), deletedAt })
      .where(isNull(chatThreadsTable.deletedAt))
  })
}
