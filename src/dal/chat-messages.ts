/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { isInsertConflictError } from '../lib/sqlite-errors'
import { chatMessagesTable } from '../db/tables'
import type { ChatMessage, ThunderboltUIMessage, UIMessageMetadata } from '../types'
import { clearNullableColumns, convertUIMessageToDbChatMessage, nowIso } from '../lib/utils'
import { getChatThread, updateChatThread } from './chat-threads'

/**
 * Gets a single chat message by ID (excluding soft-deleted)
 */
export const getMessage = async (db: AnyDrizzleDatabase, messageId: string): Promise<ChatMessage | undefined> => {
  return (await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.id, messageId), isNull(chatMessagesTable.deletedAt)))
    .get()) as ChatMessage | undefined
}

/**
 * Gets all chat messages for a specific thread (excluding soft-deleted)
 */
export const getChatMessages = async (db: AnyDrizzleDatabase, threadId: string): Promise<ChatMessage[]> => {
  return (await db
    .select()
    .from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
    .orderBy(chatMessagesTable.id)) as ChatMessage[]
}

/**
 * Gets the last message in a thread (excluding soft-deleted)
 */
export const getLastMessage = async (db: AnyDrizzleDatabase, threadId: string): Promise<ChatMessage | null> => {
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
  db: AnyDrizzleDatabase,
  threadId: string,
  messages: ThunderboltUIMessage[],
): Promise<ChatMessage[]> => {
  // Verify thread exists
  const thread = await getChatThread(db, threadId)
  if (!thread) {
    throw new Error('Thread not found')
  }

  // Get the last message in the thread to use as parent for new messages
  const lastMessage = await getLastMessage(db, threadId)
  const parentId = lastMessage?.id ?? null

  // Convert UI messages to DB messages with parent relationship
  const dbChatMessages = messages.map((message, index) => {
    // For the first message in this batch, use the last message in the thread as parent
    // For subsequent messages in the batch, use the previous message in the batch
    const messageParentId = index === 0 ? parentId : messages[index - 1].id
    return convertUIMessageToDbChatMessage(message, threadId, messageParentId)
  })

  await db.transaction(async (tx) => {
    // Insert-first pattern for PowerSync compatibility.
    // PowerSync uses views which don't support ON CONFLICT, so we can't use upsert.
    // Try insert first, then update on unique constraint violation to avoid race conditions
    // when multiple components save messages simultaneously.
    for (const msg of dbChatMessages) {
      try {
        await tx.insert(chatMessagesTable).values(msg)
      } catch (err) {
        if (!isInsertConflictError(err)) {
          throw err
        }
        await tx
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
      await updateChatThread(tx, threadId, { contextSize: metadata.usage.totalTokens })
    }
  })

  return dbChatMessages
}

/**
 * Updates a specific cache field for a message
 * Uses flat key-value storage with camelCase namespace (e.g., "linkPreview/https://example.com")
 */
export const updateMessageCache = async (
  db: AnyDrizzleDatabase,
  messageId: string,
  cacheKey: string,
  value: unknown,
): Promise<void> => {
  // Fetch current message
  const message = await getMessage(db, messageId)

  if (!message) {
    throw new Error('Message not found')
  }

  // Simple flat key-value storage
  const updatedCache = { ...(message.cache || {}), [cacheKey]: value } as typeof message.cache
  await db.update(chatMessagesTable).set({ cache: updatedCache }).where(eq(chatMessagesTable.id, messageId))
}

export const updateMessage = async (
  db: AnyDrizzleDatabase,
  messageId: string,
  message: Partial<ChatMessage>,
): Promise<void> => {
  await db.update(chatMessagesTable).set(message).where(eq(chatMessagesTable.id, messageId))
}

/**
 * Collect message id and all descendant ids (children, grandchildren, etc.) that are not yet soft-deleted.
 * Uses iterative BFS to avoid stack overflow and N+1 query issues with deep message trees.
 */
const getMessageAndDescendantIds = async (db: AnyDrizzleDatabase, messageId: string): Promise<string[]> => {
  const allIds: string[] = []
  let parentIds: string[] = [messageId]

  while (parentIds.length > 0) {
    allIds.push(...parentIds)
    const children = (await db
      .select({ id: chatMessagesTable.id })
      .from(chatMessagesTable)
      .where(and(inArray(chatMessagesTable.parentId, parentIds), isNull(chatMessagesTable.deletedAt)))) as {
      id: string
    }[]

    parentIds = children.map((c) => c.id)
  }

  return allIds
}

/**
 * Soft deletes a chat message and all its descendants (children, grandchildren, etc.).
 * Sets deletedAt and clears nullable columns. Only updates records not already soft-deleted.
 * Cascade is handled in the DAL; parent_id is a logical reference only.
 */
export const deleteChatMessageAndDescendants = async (db: AnyDrizzleDatabase, messageId: string): Promise<void> => {
  const idsToSoftDelete = await getMessageAndDescendantIds(db, messageId)
  if (idsToSoftDelete.length === 0) {
    return
  }

  const deletedAt = nowIso()
  await db
    .update(chatMessagesTable)
    .set({ ...clearNullableColumns(chatMessagesTable), deletedAt })
    .where(and(inArray(chatMessagesTable.id, idsToSoftDelete), isNull(chatMessagesTable.deletedAt)))
}
