import { and, asc, desc, eq, like, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { tasksTable } from '../db/tables'
import type { Task } from '../types'

/**
 * Gets all incomplete tasks, optionally filtered by search query
 */
export const getIncompleteTasks = async (searchQuery?: string): Promise<Task[]> => {
  const db = DatabaseSingleton.instance.db
  const query = db
    .select()
    .from(tasksTable)
    .where(
      searchQuery
        ? and(eq(tasksTable.isComplete, 0), like(tasksTable.item, `%${searchQuery}%`))
        : eq(tasksTable.isComplete, 0),
    )
    .orderBy(asc(tasksTable.order), desc(tasksTable.id))
    .limit(50)

  const result = await query
  return result.filter((task) => task.item && task.item.trim() !== '')
}

/**
 * Gets the count of incomplete tasks
 */
export const getIncompleteTasksCount = async (): Promise<number> => {
  const db = DatabaseSingleton.instance.db
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
    .where(eq(tasksTable.isComplete, 0))
  return count
}

/**
 * Update a task (preserves defaultHash for modification tracking)
 */
export const updateTask = async (id: string, updates: Partial<Task>) => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Task> & { defaultHash?: string }
  await db.update(tasksTable).set(updateFields).where(eq(tasksTable.id, id))
}
