import { eq } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { triggersTable } from '../db/tables'

/**
 * Deletes all triggers associated with a prompt
 */
export const deleteTriggersForPrompt = async (promptId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(triggersTable).where(eq(triggersTable.promptId, promptId))
}
