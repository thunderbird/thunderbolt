import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { tasksTable } from '../db/tables'
import type { Task } from '../types'

/**
 * Gets all tasks (excluding soft-deleted)
 */
export const getAllTasks = async (): Promise<Task[]> => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(tasksTable).where(isNull(tasksTable.deletedAt))
}

/**
 * Gets all incomplete tasks, optionally filtered by search query (excluding soft-deleted)
 */
export const getIncompleteTasks = async (searchQuery?: string): Promise<Task[]> => {
  const db = DatabaseSingleton.instance.db
  const query = db
    .select()
    .from(tasksTable)
    .where(
      searchQuery
        ? and(eq(tasksTable.isComplete, 0), like(tasksTable.item, `%${searchQuery}%`), isNull(tasksTable.deletedAt))
        : and(eq(tasksTable.isComplete, 0), isNull(tasksTable.deletedAt)),
    )
    .orderBy(asc(tasksTable.order), desc(tasksTable.id))
    .limit(50)

  const result = await query
  return result.filter((task) => task.item && task.item.trim() !== '')
}

/**
 * Gets the count of incomplete tasks (excluding soft-deleted)
 */
export const getIncompleteTasksCount = async (): Promise<number> => {
  const db = DatabaseSingleton.instance.db
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
    .where(and(eq(tasksTable.isComplete, 0), isNull(tasksTable.deletedAt)))
  return count
}

/**
 * Update a task (preserves defaultHash for modification tracking)
 */
export const updateTask = async (id: string, updates: Partial<Task>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Task> & { defaultHash?: string }
  await db.update(tasksTable).set(updateFields).where(eq(tasksTable.id, id))
}

/**
 * Soft deletes a single task by ID (sets deletedAt timestamp)
 */
export const deleteTask = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(tasksTable).set({ deletedAt: Date.now() }).where(eq(tasksTable.id, id))
}

/**
 * Soft deletes multiple tasks by their IDs (sets deletedAt timestamp)
 */
export const deleteTasks = async (ids: string[]): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.update(tasksTable).set({ deletedAt: Date.now() }).where(inArray(tasksTable.id, ids))
}

/**
 * Creates a new task
 */
export const createTask = async (data: Pick<Task, 'id' | 'item' | 'order' | 'isComplete'>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(tasksTable).values(data)
}
