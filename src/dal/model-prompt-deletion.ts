/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { promptsTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import { deleteTriggersForPrompts } from './triggers'

/**
 * Soft deletes all prompts that reference a model (sets deletedAt datetime)
 * Also soft-deletes all associated triggers for each prompt
 * Scrubs all nullable columns for privacy
 * This replaces the cascade behavior that no longer fires with soft deletes
 */
export const deletePromptsForModel = async (db: AnyDrizzleDatabase, modelId: string): Promise<void> => {
  const prompts = await db
    .select({ id: promptsTable.id })
    .from(promptsTable)
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))

  const promptIds = prompts.map((p) => p.id)

  await deleteTriggersForPrompts(db, promptIds)
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
    .where(and(eq(promptsTable.modelId, modelId), isNull(promptsTable.deletedAt)))
}
