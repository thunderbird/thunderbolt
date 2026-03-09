import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { tasksDecryptedTable, tasksTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Task } from '../types'

const decryptedItem = sql<string>`COALESCE(${tasksDecryptedTable.item}, ${tasksTable.item})`
const itemNotEmpty = sql`${decryptedItem} IS NOT NULL AND trim(${decryptedItem}) != ''`

/**
 * Gets all tasks (excluding soft-deleted), with decrypted items
 */
export const getAllTasks = async (): Promise<Task[]> => {
  const db = DatabaseSingleton.instance.db
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
    .leftJoin(tasksDecryptedTable, eq(tasksTable.id, tasksDecryptedTable.id))
    .where(isNull(tasksTable.deletedAt))) as Task[]
}

/**
 * Returns a Drizzle query for incomplete tasks, optionally filtered by search query (excluding soft-deleted).
 * Joins with tasks_decrypted for readable item text.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasks = (searchQuery?: string) =>
  DatabaseSingleton.instance.db
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
    .leftJoin(tasksDecryptedTable, eq(tasksTable.id, tasksDecryptedTable.id))
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

/**
 * Returns a Drizzle query for the count of incomplete tasks (excluding soft-deleted).
 * Uses decrypted item for the non-empty check.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasksCount = () =>
  DatabaseSingleton.instance.db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
    .leftJoin(tasksDecryptedTable, eq(tasksTable.id, tasksDecryptedTable.id))
    .where(and(eq(tasksTable.isComplete, 0), isNull(tasksTable.deletedAt), itemNotEmpty))

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
 * Soft deletes a single task by ID (sets deletedAt datetime)
 * Scrubs all data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTask = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
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
export const deleteTasks = async (ids: string[]): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(tasksTable)
    .set({ ...clearNullableColumns(tasksTable), deletedAt: nowIso() })
    .where(and(inArray(tasksTable.id, ids), isNull(tasksTable.deletedAt)))
}

/**
 * Creates a new task
 */
export const createTask = async (data: Pick<Task, 'id' | 'item' | 'order' | 'isComplete'>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(tasksTable).values(data)
}
