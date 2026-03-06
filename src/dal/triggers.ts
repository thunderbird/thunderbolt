import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { DatabaseSingleton } from '../db/singleton'
import { triggersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Trigger } from '../types'

/**
 * Returns a Drizzle query for all triggers for a prompt (excluding soft-deleted).
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getAllTriggersForPrompt = (promptId: string) => {
  const query = DatabaseSingleton.instance.db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
  return query as typeof query & { execute: () => Promise<Trigger[]> }
}

/**
 * Returns a Drizzle query for all enabled triggers (excluding soft-deleted).
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getAllEnabledTriggers = () => {
  const query = DatabaseSingleton.instance.db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.isEnabled, 1), isNull(triggersTable.deletedAt)))
  return query as typeof query & { execute: () => Promise<Trigger[]> }
}

/**
 * Soft deletes all triggers associated with a prompt (sets deletedAt datetime)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTriggersForPrompt = async (promptId: string, db?: AnyDrizzleDatabase): Promise<void> => {
  const database = db ?? DatabaseSingleton.instance.db
  await database
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
}

/**
 * Soft deletes all triggers associated with multiple prompts (sets deletedAt datetime)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTriggersForPrompts = async (promptIds: string[], db?: AnyDrizzleDatabase): Promise<void> => {
  if (promptIds.length === 0) {
    return
  }

  const database = db ?? DatabaseSingleton.instance.db
  await database
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
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
