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
 * Returns a Drizzle query for all triggers in the given workspace for a prompt
 * (excluding soft-deleted). Use with PowerSync's toCompilableQuery, or await
 * the result to execute.
 */
export const getAllTriggersForPrompt = (db: AnyDrizzleDatabase, workspaceId: string, promptId: string) => {
  const query = db
    .select()
    .from(triggersTable)
    .where(
      and(
        eq(triggersTable.workspaceId, workspaceId),
        eq(triggersTable.promptId, promptId),
        isNull(triggersTable.deletedAt),
      ),
    )
  return query as typeof query & DrizzleQueryWithPromise<Trigger>
}

/**
 * Returns all enabled triggers in the given workspace (excluding soft-deleted).
 */
export const getAllEnabledTriggers = (db: AnyDrizzleDatabase, workspaceId: string): Promise<Trigger[]> => {
  const query = db
    .select()
    .from(triggersTable)
    .where(
      and(eq(triggersTable.workspaceId, workspaceId), eq(triggersTable.isEnabled, 1), isNull(triggersTable.deletedAt)),
    )
  return query as Promise<Trigger[]>
}

/**
 * Soft deletes all triggers associated with a prompt in the given workspace.
 * Scrubs all nullable columns for privacy. Only updates records that haven't
 * been deleted yet to preserve original deletion datetimes.
 */
export const deleteTriggersForPrompt = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  promptId: string,
): Promise<void> => {
  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
    .where(
      and(
        eq(triggersTable.workspaceId, workspaceId),
        eq(triggersTable.promptId, promptId),
        isNull(triggersTable.deletedAt),
      ),
    )
}

/**
 * Soft deletes all triggers associated with multiple prompts in the given workspace.
 * Scrubs all nullable columns for privacy. Only updates records that haven't been
 * deleted yet to preserve original deletion datetimes.
 */
export const deleteTriggersForPrompts = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  promptIds: string[],
): Promise<void> => {
  if (promptIds.length === 0) {
    return
  }

  await db
    .update(triggersTable)
    .set({ ...clearNullableColumns(triggersTable), deletedAt: nowIso() })
    .where(
      and(
        eq(triggersTable.workspaceId, workspaceId),
        inArray(triggersTable.promptId, promptIds),
        isNull(triggersTable.deletedAt),
      ),
    )
}

/**
 * Creates a new trigger in the given workspace
 */
export const createTrigger = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: Partial<Trigger> & Pick<Trigger, 'id' | 'promptId' | 'isEnabled' | 'triggerType' | 'triggerTime'>,
): Promise<void> => {
  await db.insert(triggersTable).values({ ...data, workspaceId })
}
