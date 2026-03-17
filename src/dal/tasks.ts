import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { tasksTable } from '../db/tables'
import { getShadowTable, decryptedCol, decryptedJoin, decryptedNotEmpty } from '../db/encryption'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Task } from '../types'
import type { DrizzleQueryWithPromise } from '@/types'

const tasksShadow = getShadowTable('tasks')
const decryptedItem = decryptedCol(tasksShadow, tasksTable, 'item')
const itemNotEmpty = decryptedNotEmpty(tasksShadow, tasksTable, 'item')

/**
 * Gets all tasks (excluding soft-deleted), with decrypted items
 */
export const getAllTasks = async (db: AnyDrizzleDatabase): Promise<Task[]> => {
  return (await db
    .select({
      id: tasksTable.id,
      item: decryptedItem,
      order: tasksTable.order,
      isComplete: tasksTable.isComplete,
      defaultHash: tasksTable.defaultHash,
      deletedAt: tasksTable.deletedAt,
      userId: tasksTable.userId,
    })
    .from(tasksTable)
    .leftJoin(tasksShadow, decryptedJoin(tasksTable, tasksShadow))
    .where(isNull(tasksTable.deletedAt))) as Task[]
}

/**
 * Returns a Drizzle query for incomplete tasks, optionally filtered by search query (excluding soft-deleted).
 * Joins with tasks_decrypted for readable item text.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasks = (db: AnyDrizzleDatabase, searchQuery?: string) => {
  const query = db
    .select({
      id: tasksTable.id,
      item: decryptedItem,
      order: tasksTable.order,
      isComplete: tasksTable.isComplete,
      defaultHash: tasksTable.defaultHash,
      deletedAt: tasksTable.deletedAt,
      userId: tasksTable.userId,
    })
    .from(tasksTable)
    .leftJoin(tasksShadow, decryptedJoin(tasksTable, tasksShadow))
    .where(
      searchQuery
        ? and(
            eq(tasksTable.isComplete, 0),
            like(decryptedItem, `%${searchQuery}%`),
            isNull(tasksTable.deletedAt),
            itemNotEmpty,
          )
        : and(eq(tasksTable.isComplete, 0), isNull(tasksTable.deletedAt), itemNotEmpty),
    )
    .orderBy(asc(tasksTable.order), desc(tasksTable.id))
    .limit(50)
  return query as typeof query & DrizzleQueryWithPromise<Task>
}

/**
 * Returns a Drizzle query for the count of incomplete tasks (excluding soft-deleted).
 * Uses decrypted item for the non-empty check.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasksCount = (db: AnyDrizzleDatabase) => {
  const query = db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
    .leftJoin(tasksShadow, decryptedJoin(tasksTable, tasksShadow))
    .where(and(eq(tasksTable.isComplete, 0), isNull(tasksTable.deletedAt), itemNotEmpty))
  return query as typeof query & DrizzleQueryWithPromise<{ count: number }>
}

/**
 * Update a task (preserves defaultHash for modification tracking)
 */
export const updateTask = async (db: AnyDrizzleDatabase, id: string, updates: Partial<Task>): Promise<void> => {
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Task> & { defaultHash?: string }
  await db.update(tasksTable).set(updateFields).where(eq(tasksTable.id, id))
}

/**
 * Soft deletes a single task by ID (sets deletedAt datetime)
 * Scrubs all data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTask = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db
    .update(tasksTable)
    .set({ ...clearNullableColumns(tasksTable), deletedAt: nowIso() })
    .where(and(eq(tasksTable.id, id), isNull(tasksTable.deletedAt)))
}

/**
 * Soft deletes multiple tasks by their IDs (sets deletedAt datetime)
 * Scrubs all data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTasks = async (db: AnyDrizzleDatabase, ids: string[]): Promise<void> => {
  await db
    .update(tasksTable)
    .set({ ...clearNullableColumns(tasksTable), deletedAt: nowIso() })
    .where(and(inArray(tasksTable.id, ids), isNull(tasksTable.deletedAt)))
}

/**
 * Creates a new task
 */
export const createTask = async (
  db: AnyDrizzleDatabase,
  data: Pick<Task, 'id' | 'item' | 'order' | 'isComplete'>,
): Promise<void> => {
  await db.insert(tasksTable).values(data)
}
