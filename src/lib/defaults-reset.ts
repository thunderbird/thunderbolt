import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable, promptsTable } from '@/db/tables'
import type { Model, Prompt } from '@/types'
import { eq } from 'drizzle-orm'

/**
 * Reset a model to its default state
 */
export const resetModelToDefault = async (id: string, defaultModel: Model) => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(modelsTable)
    .set({ ...defaultModel, deletedAt: null })
    .where(eq(modelsTable.id, id))
}

/**
 * Reset an automation to its default state
 */
export const resetAutomationToDefault = async (id: string, defaultAutomation: Prompt) => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(promptsTable)
    .set({ ...defaultAutomation, deletedAt: null })
    .where(eq(promptsTable.id, id))
}
