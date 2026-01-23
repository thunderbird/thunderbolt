import { and, eq, inArray, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { triggersTable } from '../db/tables'
import { clearNullableColumns } from '../lib/utils'
import type { Trigger } from '../types'

/**
 * Gets all triggers for a prompt (excluding soft-deleted)
 */
export const getAllTriggersForPrompt = async (promptId: string): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return (await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))) as Trigger[]
}

/**
 * Gets all enabled triggers (excluding soft-deleted)
 */
export const getAllEnabledTriggers = async (): Promise<Trigger[]> => {
  const db = DatabaseSingleton.instance.db
  return (await db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.isEnabled, 1), isNull(triggersTable.deletedAt)))) as Trigger[]
}

/**
 * Soft deletes all triggers associated with a prompt (sets deletedAt timestamp)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion timestamps
 */
export const deleteTriggersForPrompt = async (promptId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: Date.now() })
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
}

/**
 * Soft deletes all triggers associated with multiple prompts (sets deletedAt timestamp)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion timestamps
 */
export const deleteTriggersForPrompts = async (promptIds: string[]): Promise<void> => {
  if (promptIds.length === 0) return

  const db = DatabaseSingleton.instance.db
  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: Date.now() })
    .where(and(inArray(triggersTable.promptId, promptIds), isNull(triggersTable.deletedAt)))
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
