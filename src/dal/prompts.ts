/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull, like } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { chatMessagesTable, chatThreadsTable, promptsTable } from '../db/tables'
import { hashPrompt } from '../defaults/automations'
import type { AutomationRun, Prompt } from '../types'
import { clearNullableColumns, convertUIMessageToDbChatMessage, nowIso } from '../lib/utils'
import { getModel } from './models'
import { createChatThread } from './chat-threads'
import { deleteTriggersForPrompt, deleteTriggersForPrompts } from './triggers'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Returns a Drizzle query for all prompts in the given workspace, optionally filtered
 * by search query (excluding soft-deleted). Use with PowerSync's toCompilableQuery, or
 * await the result to execute.
 */
export const getAllPrompts = (db: AnyDrizzleDatabase, workspaceId: string, searchQuery?: string) => {
  const query = db
    .select()
    .from(promptsTable)
    .where(
      searchQuery
        ? and(
            eq(promptsTable.workspaceId, workspaceId),
            like(promptsTable.prompt, `%${searchQuery}%`),
            isNull(promptsTable.deletedAt),
          )
        : and(eq(promptsTable.workspaceId, workspaceId), isNull(promptsTable.deletedAt)),
    )
    .orderBy(asc(promptsTable.id))
    .limit(50)

  return query as typeof query & DrizzleQueryWithPromise<Prompt>
}

/**
 * Returns information about the automation that triggered a chat thread in the given
 * workspace, if any (excluding soft-deleted).
 */
export const getTriggerPromptForThread = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
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
    .leftJoin(
      promptsTable,
      and(
        eq(chatThreadsTable.triggeredBy, promptsTable.id),
        eq(promptsTable.workspaceId, workspaceId),
        isNull(promptsTable.deletedAt),
      ),
    )
    .where(
      and(
        eq(chatThreadsTable.workspaceId, workspaceId),
        eq(chatThreadsTable.id, threadId),
        isNull(chatThreadsTable.deletedAt),
      ),
    )
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
 * Update an automation/prompt in the given workspace (preserves defaultHash for
 * modification tracking).
 */
export const updateAutomation = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  updates: Partial<Prompt>,
): Promise<void> => {
  // Strip `defaultHash` (preserved for modification tracking) and `workspaceId`
  // (the row stays in the workspace it was filtered to — callers can't reassign).
  const {
    defaultHash,
    workspaceId: _workspaceId,
    ...updateFields
  } = updates as Partial<Prompt> & { defaultHash?: string }
  await db
    .update(promptsTable)
    .set(updateFields)
    .where(and(eq(promptsTable.id, id), eq(promptsTable.workspaceId, workspaceId)))
}

/**
 * Reset an automation to its default state. Recomputes `defaultHash` so that
 * any legacy/stale value left over from a previous `hashPrompt` formula is
 * replaced with the current one — otherwise `isAutomationModified` would keep
 * flagging the row as modified even right after a reset. `userId` is stripped
 * from the default template so we never overwrite the row's real owner with
 * `null` (which would surface as an empty PATCH and a 400 from the upload
 * handler).
 */
export const resetAutomationToDefault = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  defaultAutomation: Prompt,
): Promise<void> => {
  const {
    defaultHash,
    workspaceId: _seedWs,
    userId,
    ...defaultFields
  } = defaultAutomation as Prompt & {
    workspaceId?: string | null
  }
  await db
    .update(promptsTable)
    .set({ ...defaultFields, defaultHash: hashPrompt(defaultAutomation) })
    .where(and(eq(promptsTable.id, id), eq(promptsTable.workspaceId, workspaceId)))
}

/**
 * Soft deletes an automation and its associated triggers in the given workspace.
 * Scrubs all nullable columns for privacy. Only updates records that haven't been
 * deleted yet to preserve original deletion datetimes.
 */
export const deleteAutomation = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await deleteTriggersForPrompt(tx, workspaceId, id)
    await tx
      .update(promptsTable)
      .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
      .where(and(eq(promptsTable.id, id), eq(promptsTable.workspaceId, workspaceId), isNull(promptsTable.deletedAt)))
  })
}

/**
 * Soft deletes all prompts that reference a model in the given workspace. Also
 * soft-deletes all associated triggers for each prompt. Scrubs all nullable columns
 * for privacy. This replaces the cascade behavior that no longer fires with soft deletes.
 */
export const deletePromptsForModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  modelId: string,
): Promise<void> => {
  const prompts = await db
    .select({ id: promptsTable.id })
    .from(promptsTable)
    .where(
      and(eq(promptsTable.workspaceId, workspaceId), eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)),
    )

  const promptIds = prompts.map((p) => p.id)

  await deleteTriggersForPrompts(db, workspaceId, promptIds)
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
    .where(
      and(eq(promptsTable.workspaceId, workspaceId), eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)),
    )
}

export const getPrompt = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<Prompt | null> => {
  const prompt = await db
    .select()
    .from(promptsTable)
    .where(and(eq(promptsTable.id, id), eq(promptsTable.workspaceId, workspaceId), isNull(promptsTable.deletedAt)))
    .get()

  return (prompt ?? null) as Prompt | null
}

/**
 * Creates a new prompt/automation in the given workspace.
 */
export const createAutomation = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: Partial<Prompt> & Pick<Prompt, 'id' | 'prompt' | 'modelId'>,
): Promise<void> => {
  await db.insert(promptsTable).values({ ...data, workspaceId })
}

/**
 * Runs an automation by creating a new chat thread in the given workspace and seeding
 * it with the prompt. Returns the threadId of the newly created chat thread.
 */
export const runAutomation = async (db: AnyDrizzleDatabase, workspaceId: string, promptId: string): Promise<string> => {
  const prompt = await getPrompt(db, workspaceId, promptId)
  if (!prompt) {
    throw new Error('Prompt not found')
  }

  const model = await getModel(db, workspaceId, prompt.modelId)
  if (!model) {
    throw new Error('Model not found')
  }

  const threadId = uuidv7()

  await db.transaction(async (tx) => {
    await createChatThread(
      tx,
      workspaceId,
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

    await tx.insert(chatMessagesTable).values({
      ...convertUIMessageToDbChatMessage(userMessage, threadId, null),
      workspaceId,
    })
  })

  return threadId
}
