/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { triggersTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Trigger } from '../types'
import type { DrizzleQueryWithPromise } from '@/types'

/**
 * Returns a Drizzle query for all triggers for a prompt (excluding soft-deleted).
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 */
export const getAllTriggersForPrompt = (db: AnyDrizzleDatabase, promptId: string) => {
  const query = db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
  return query as typeof query & DrizzleQueryWithPromise<Trigger>
}

/**
 * Returns all enabled triggers (excluding soft-deleted).
 */
export const getAllEnabledTriggers = (db: AnyDrizzleDatabase): Promise<Trigger[]> => {
  const query = db
    .select()
    .from(triggersTable)
    .where(and(eq(triggersTable.isEnabled, 1), isNull(triggersTable.deletedAt)))
  return query as Promise<Trigger[]>
}

/**
 * Soft deletes all triggers associated with a prompt (sets deletedAt datetime)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTriggersForPrompt = async (db: AnyDrizzleDatabase, promptId: string): Promise<void> => {
  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
    .where(and(eq(triggersTable.promptId, promptId), isNull(triggersTable.deletedAt)))
}

/**
 * Soft deletes all triggers associated with multiple prompts (sets deletedAt datetime)
 * Scrubs all nullable columns for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteTriggersForPrompts = async (db: AnyDrizzleDatabase, promptIds: string[]): Promise<void> => {
  if (promptIds.length === 0) {
    return
  }

  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
    .where(and(inArray(triggersTable.promptId, promptIds), isNull(triggersTable.deletedAt)))
}

/**
 * Creates a new trigger
 */
export const createTrigger = async (
  db: AnyDrizzleDatabase,
  data: Partial<Trigger> & Pick<Trigger, 'id' | 'promptId' | 'isEnabled' | 'triggerType' | 'triggerTime'>,
): Promise<void> => {
  await db.insert(triggersTable).values(data)
}
