/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull, like } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatMessagesTable, chatThreadsTable, promptsTable } from '../db/tables'
import type { AutomationRun, Prompt } from '../types'
import { clearNullableColumns, convertUIMessageToDbChatMessage, nowIso } from '../lib/utils'
import { getModel } from './models'
import { createChatThread } from './chat-threads'
import { deleteTriggersForPrompt, deleteTriggersForPrompts } from './triggers'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Returns a Drizzle query for all prompts, optionally filtered by search query (excluding soft-deleted).
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getAllPrompts = (db: AnyDrizzleDatabase, searchQuery?: string) => {
  const query = db
    .select()
    .from(promptsTable)
    .where(
      searchQuery
        ? and(like(promptsTable.prompt, `%${searchQuery}%`), isNull(promptsTable.deletedAt))
        : isNull(promptsTable.deletedAt),
    )
    .orderBy(asc(promptsTable.id))
    .limit(50)

  return query as typeof query & DrizzleQueryWithPromise<Prompt>
}

/**
 * Returns information about the automation that triggered a chat thread, if any (excluding soft-deleted)
 */
export const getTriggerPromptForThread = async (
  db: AnyDrizzleDatabase,
  threadId: string,
): Promise<AutomationRun | null> => {
  // Fetch the associated prompt and thread info in a single query via join
  // Join condition includes soft-delete check so deleted prompts return null
  const result = await db
    .select({
      prompt: promptsTable,
      wasTriggeredByAutomation: chatThreadsTable.wasTriggeredByAutomation,
      triggeredBy: chatThreadsTable.triggeredBy,
    })
    .from(chatThreadsTable)
    .leftJoin(promptsTable, and(eq(chatThreadsTable.triggeredBy, promptsTable.id), isNull(promptsTable.deletedAt)))
    .where(and(eq(chatThreadsTable.id, threadId), isNull(chatThreadsTable.deletedAt)))
    .get()

  if (!result) {
    return null
  }

  const wasTriggeredByAutomation = result.wasTriggeredByAutomation === 1
  const isAutomationDeleted = wasTriggeredByAutomation && !result.prompt

  return {
    prompt: result.prompt as Prompt | null,
    wasTriggeredByAutomation,
    isAutomationDeleted,
  }
}

/**
 * Update an automation/prompt (preserves defaultHash for modification tracking)
 */
export const updateAutomation = async (db: AnyDrizzleDatabase, id: string, updates: Partial<Prompt>): Promise<void> => {
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Prompt> & { defaultHash?: string }
  await db.update(promptsTable).set(updateFields).where(eq(promptsTable.id, id))
}

/**
 * Reset an automation to its default state
 */
export const resetAutomationToDefault = async (
  db: AnyDrizzleDatabase,
  id: string,
  defaultAutomation: Prompt,
): Promise<void> => {
  const { defaultHash, ...defaultFields } = defaultAutomation
  await db.update(promptsTable).set(defaultFields).where(eq(promptsTable.id, id))
}

/**
 * Soft deletes an automation and its associated triggers (sets deletedAt datetime)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteAutomation = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await deleteTriggersForPrompt(tx, id)
    await tx
      .update(promptsTable)
      .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
      .where(and(eq(promptsTable.id, id), isNull(promptsTable.deletedAt)))
  })
}

/**
 * Soft deletes all prompts that reference a model (sets deletedAt datetime)
 * Also soft-deletes all associated triggers for each prompt
 * Scrubs all nullable columns for privacy
 * This replaces the cascade behavior that no longer fires with soft deletes
 */
export const deletePromptsForModel = async (db: AnyDrizzleDatabase, modelId: string): Promise<void> => {
  const prompts = await db
    .select({ id: promptsTable.id })
    .from(promptsTable)
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))

  const promptIds = prompts.map((p) => p.id)

  await deleteTriggersForPrompts(db, promptIds)
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))
}

export const getPrompt = async (db: AnyDrizzleDatabase, id: string): Promise<Prompt | null> => {
  const prompt = await db
    .select()
    .from(promptsTable)
    .where(and(eq(promptsTable.id, id), isNull(promptsTable.deletedAt)))
    .get()

  return (prompt ?? null) as Prompt | null
}

/**
 * Creates a new prompt/automation
 */
export const createAutomation = async (
  db: AnyDrizzleDatabase,
  data: Partial<Prompt> & Pick<Prompt, 'id' | 'prompt' | 'modelId'>,
): Promise<void> => {
  await db.insert(promptsTable).values(data)
}

/**
 * Runs an automation by creating a new chat thread and seeding it with the prompt
 * @returns The threadId of the newly created chat thread
 */
export const runAutomation = async (db: AnyDrizzleDatabase, promptId: string): Promise<string> => {
  const prompt = await getPrompt(db, promptId)
  if (!prompt) {
    throw new Error('Prompt not found')
  }

  const model = await getModel(db, prompt.modelId)
  if (!model) {
    throw new Error('Model not found')
  }

  const threadId = uuidv7()

  await db.transaction(async (tx) => {
    await createChatThread(
      tx,
      {
        id: threadId,
        title: prompt.title ?? 'Automation',
        triggeredBy: prompt.id,
        wasTriggeredByAutomation: 1,
        contextSize: null,
      },
      model,
    )

    const userMessage = {
      id: uuidv7(),
      role: 'user' as const,
      metadata: { modelId: model.id },
      parts: [{ type: 'text' as const, text: prompt.prompt }],
    }

    await tx.insert(chatMessagesTable).values(convertUIMessageToDbChatMessage(userMessage, threadId, null))
  })

  return threadId
}
