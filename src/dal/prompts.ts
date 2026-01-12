import { and, asc, eq, isNull, like } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import { chatMessagesTable, chatThreadsTable, promptsTable } from '../db/tables'
import type { AutomationRun, Prompt } from '../types'
import { clearNullableColumns, convertUIMessageToDbChatMessage } from '../lib/utils'
import { getModel } from './models'
import { createChatThread } from './chat-threads'
import { deleteTriggersForPrompt, deleteTriggersForPrompts } from './triggers'

/**
 * Gets all prompts, optionally filtered by search query
 */
export const getAllPrompts = async (searchQuery?: string): Promise<Prompt[]> => {
  const db = DatabaseSingleton.instance.db
  if (searchQuery) {
    return (await db
      .select()
      .from(promptsTable)
      .where(and(like(promptsTable.prompt, `%${searchQuery}%`), isNull(promptsTable.deletedAt)))
      .orderBy(asc(promptsTable.id))
      .limit(50)) as Prompt[]
  }

  return (await db
    .select()
    .from(promptsTable)
    .where(isNull(promptsTable.deletedAt))
    .orderBy(asc(promptsTable.id))
    .limit(50)) as Prompt[]
}

/**
 * Returns information about the automation that triggered a chat thread, if any (excluding soft-deleted)
 */
export const getTriggerPromptForThread = async (threadId: string): Promise<AutomationRun | null> => {
  const db = DatabaseSingleton.instance.db

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

  if (!result) return null

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
export const updateAutomation = async (id: string, updates: Partial<Prompt>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Prompt> & { defaultHash?: string }
  await db.update(promptsTable).set(updateFields).where(eq(promptsTable.id, id))
}

/**
 * Reset an automation to its default state
 */
export const resetAutomationToDefault = async (id: string, defaultAutomation: Prompt): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultAutomation
  await db.update(promptsTable).set(defaultFields).where(eq(promptsTable.id, id))
}

/**
 * Soft deletes an automation and its associated triggers (sets deletedAt timestamp)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion timestamps
 */
export const deleteAutomation = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Delete triggers first (due to foreign key)
  await deleteTriggersForPrompt(id)
  // Soft delete with data scrubbing
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: Date.now() })
    .where(and(eq(promptsTable.id, id), isNull(promptsTable.deletedAt)))
}

/**
 * Soft deletes all prompts that reference a model (sets deletedAt timestamp)
 * Also soft-deletes all associated triggers for each prompt
 * Scrubs all nullable columns for privacy
 * This replaces the cascade behavior that no longer fires with soft deletes
 */
export const deletePromptsForModel = async (modelId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db

  // Find all prompts for this model that aren't already deleted
  const prompts = await db
    .select({ id: promptsTable.id })
    .from(promptsTable)
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))

  const promptIds = prompts.map((p) => p.id)

  // Soft-delete all triggers for these prompts in a single query
  await deleteTriggersForPrompts(promptIds)

  // Soft-delete all prompts for this model with data scrubbing
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: Date.now() })
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))
}

export const getPrompt = async (id: string): Promise<Prompt | null> => {
  const db = DatabaseSingleton.instance.db
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
  data: Partial<Prompt> & Pick<Prompt, 'id' | 'prompt' | 'modelId'>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(promptsTable).values(data)
}

/**
 * Runs an automation by creating a new chat thread and seeding it with the prompt
 * @returns The threadId of the newly created chat thread
 */
export const runAutomation = async (promptId: string): Promise<string> => {
  const db = DatabaseSingleton.instance.db

  const prompt = await getPrompt(promptId)

  if (!prompt) throw new Error('Prompt not found')

  const model = await getModel(prompt.modelId)

  if (!model) throw new Error('Model not found')

  const threadId = uuidv7()

  await createChatThread(
    {
      id: threadId,
      title: prompt.title ?? 'Automation',
      triggeredBy: prompt.id,
      wasTriggeredByAutomation: 1,
      contextSize: null,
    },
    model.id,
  )

  const userMessage = {
    id: uuidv7(),
    role: 'user' as const,
    metadata: { modelId: model.id },
    parts: [{ type: 'text' as const, text: prompt.prompt }],
  }

  await db.insert(chatMessagesTable).values(convertUIMessageToDbChatMessage(userMessage, threadId, null))

  return threadId
}
