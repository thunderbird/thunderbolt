/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, desc, eq, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { tasksTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Task } from '../types'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Gets all tasks (excluding soft-deleted)
 */
export const getAllTasks = async (db: AnyDrizzleDatabase): Promise<Task[]> => {
  return (await db.select().from(tasksTable).where(isNull(tasksTable.deletedAt))) as Task[]
}

const itemNotEmpty = and(isNotNull(tasksTable.item), sql`trim(${tasksTable.item}) != ''`)

/**
 * Returns a Drizzle query for incomplete tasks, optionally filtered by search query (excluding soft-deleted).
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasks = (db: AnyDrizzleDatabase, searchQuery?: string) => {
  const query = db
    .select()
    .from(tasksTable)
    .where(
      searchQuery
        ? and(
            eq(tasksTable.isComplete, 0),
            like(tasksTable.item, `%${searchQuery}%`),
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
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getIncompleteTasksCount = (db: AnyDrizzleDatabase) => {
  const query = db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
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
