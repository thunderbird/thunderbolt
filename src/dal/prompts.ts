import { and, asc, eq, isNull, like } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import { chatMessagesTable, chatThreadsTable, promptsTable } from '../db/tables'
import type { AutomationRun, Prompt } from '../types'
import { convertUIMessageToDbChatMessage } from '../lib/utils'
import { getModel } from './models'
import { createChatThread } from './chat-threads'
import { deleteTriggersForPrompt } from './triggers'

/**
 * Gets all prompts, optionally filtered by search query
 */
export const getAllPrompts = async (searchQuery?: string): Promise<Prompt[]> => {
  const db = DatabaseSingleton.instance.db
  if (searchQuery) {
    return db
      .select()
      .from(promptsTable)
      .where(and(like(promptsTable.prompt, `%${searchQuery}%`), isNull(promptsTable.deletedAt)))
      .orderBy(asc(promptsTable.id))
      .limit(50)
  }

  return db.select().from(promptsTable).where(isNull(promptsTable.deletedAt)).orderBy(asc(promptsTable.id)).limit(50)
}

/**
 * Returns information about the automation that triggered a chat thread, if any.
 */
export const getTriggerPromptForThread = async (threadId: string): Promise<AutomationRun | null> => {
  const db = DatabaseSingleton.instance.db

  // Fetch the associated prompt and thread info in a single query via join
  const result = await db
    .select({
      prompt: promptsTable,
      wasTriggeredByAutomation: chatThreadsTable.wasTriggeredByAutomation,
      triggeredBy: chatThreadsTable.triggeredBy,
    })
    .from(chatThreadsTable)
    .leftJoin(promptsTable, eq(chatThreadsTable.triggeredBy, promptsTable.id))
    .where(eq(chatThreadsTable.id, threadId))
    .get()

  if (!result) return null

  const wasTriggeredByAutomation = result.wasTriggeredByAutomation === 1
  const isAutomationDeleted = wasTriggeredByAutomation && !result.prompt

  return {
    prompt: result.prompt,
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
 * Delete an automation (soft delete) and its associated triggers
 */
export const deleteAutomation = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Delete triggers first (due to foreign key)
  await deleteTriggersForPrompt(id)
  // Use soft delete - set deletedAt timestamp instead of hard delete
  await db.update(promptsTable).set({ deletedAt: Date.now() }).where(eq(promptsTable.id, id))
}

export const getPrompt = async (id: string): Promise<Prompt | null> => {
  const db = DatabaseSingleton.instance.db
  const prompt = await db
    .select()
    .from(promptsTable)
    .where(and(eq(promptsTable.id, id), isNull(promptsTable.deletedAt)))
    .get()

  return prompt ?? null
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
