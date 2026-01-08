import { and, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { triggersTable } from '../db/tables'
import type { Trigger } from '../types'

/**
 * Gets all triggers for a prompt (excluding soft-deleted)
 */
export const getAllTriggersForPrompt = async (promptId: string): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
}

/**
 * Gets all enabled triggers (excluding soft-deleted)
 */
export const getAllEnabledTriggers = async (): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.isEnabled, 1), isNull(triggersTable.deletedAt)))
}

/**
 * Scrubbed data for soft-deleted triggers.
 * Clears nullable columns to null, required integers to default.
 * Keeps triggerType (enum) and promptId (FK) unchanged.
 */
const scrubbedTriggerData = {
  triggerTime: null,
  isEnabled: 0,
}

/**
 * Soft deletes all triggers associated with a prompt (sets deletedAt timestamp)
 * Scrubs all non-FK/non-enum data for privacy
 */
export const deleteTriggersForPrompt = async (promptId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(triggersTable)
    .set({ ...scrubbedTriggerData, deletedAt: Date.now() })
    .where(eq(triggersTable.promptId, promptId))
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
