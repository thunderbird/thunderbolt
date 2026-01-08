import { eq } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { triggersTable } from '../db/tables'
import type { Trigger } from '../types'

/**
 * Gets all triggers for a prompt
 */
export const getAllTriggersForPrompt = async (promptId: string): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId))
}

/**
 * Gets all enabled triggers
 */
export const getAllEnabledTriggers = async (): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(triggersTable).where(eq(triggersTable.isEnabled, 1))
}

/**
 * Deletes all triggers associated with a prompt
 */
export const deleteTriggersForPrompt = async (promptId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(triggersTable).where(eq(triggersTable.promptId, promptId))
}

/**
 * Creates a new trigger
 */
export const createTrigger = async (
  data: Partial<Trigger> & Pick<Trigger, 'id' | 'promptId' | 'isEnabled' | 'triggerType' | 'triggerTime'>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(triggersTable).values(data)
}
