/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Model, ModelProfile } from '@/types'
import { createSetting } from '@/dal'
import { and, eq, isNull } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { modelProfilesTable, modelsTable, modesTable, settingsTable, skillsTable, tasksTable } from '../db/tables'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { defaultModes, hashMode } from '../defaults/modes'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { defaultSkills, hashSkill } from '../defaults/skills'
import { defaultTasks, hashTask } from '../defaults/tasks'
import { nowIso } from './utils'

/**
 * Generic function to reconcile defaults into a table
 * Inserts new defaults and updates unmodified existing ones
 * @param table - The database table to reconcile
 * @param defaults - Array of default items to reconcile
 * @param hashFn - Function to compute hash of an item
 * @param keyField - Name of the primary key field (defaults to 'id')
 */
export const reconcileDefaultsForTable = async <T extends { defaultHash: string | null }>(
  db: AnyDrizzleDatabase,
  table: SQLiteTableWithColumns<any>,
  defaults: readonly T[],
  hashFn: (item: any) => string,
  keyField: string = 'id',
) => {
  for (const defaultItem of defaults) {
    const keyValue = (defaultItem as any)[keyField]
    const existing = await db.select().from(table).where(eq(table[keyField], keyValue)).get()

    if (!existing) {
      // New default - insert with computed hash
      await db.insert(table).values({
        ...defaultItem,
        defaultHash: hashFn(defaultItem),
      })
    } else {
      // Exists - check if user modified by comparing hashes
      const currentHash = hashFn(existing)
      const defaultHashValue = hashFn(defaultItem)

      if (!existing.defaultHash) {
        // No defaultHash - set it to the default hash to enable modification tracking
        await db.update(table).set({ defaultHash: defaultHashValue }).where(eq(table[keyField], keyValue))
      } else if (currentHash === existing.defaultHash) {
        // Skip update if default hasn't changed (prevents empty PATCH operations)
        // TODO: needs more testing
        if (existing.defaultHash === defaultHashValue) {
          continue
        }

        // Protect user-set values from being overwritten by null defaults.
        // This handles localization settings (distance_unit, etc.) where the user explicitly
        // set a value via recomputeHash, but the code default is null.
        // For non-settings tables, 'value' is undefined so this check is safely skipped.
        const wouldOverwriteUserValue = (existing as any).value !== null && (defaultItem as any).value === null

        if (wouldOverwriteUserValue) {
          continue
        }

        // Unmodified and default has changed - safe to update to new default
        await db
          .update(table)
          .set({
            ...defaultItem,
            defaultHash: defaultHashValue,
          })
          .where(eq(table[keyField], keyValue))
      }
      // If hashes don't match, user has modified (including soft-delete) - skip update
    }
  }
}

/**
 * Soft-delete any unedited system default row whose id is no longer in the
 * current defaults arrays. The hash-match guard ensures edited rows survive.
 * Skips rows without a `defaultHash` (user-created).
 */
export const cleanupRemovedDefaults = async (db: AnyDrizzleDatabase) => {
  const now = nowIso()
  const currentModelIds = new Set(defaultModels.map((m) => m.id))

  const systemModels = (await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.isSystem, 1), isNull(modelsTable.deletedAt)))) as Model[]
  for (const row of systemModels) {
    if (currentModelIds.has(row.id) || !row.defaultHash) {
      continue
    }
    if (hashModel(row) === row.defaultHash) {
      await db.update(modelsTable).set({ deletedAt: now }).where(eq(modelsTable.id, row.id))
    }
  }

  // Profiles are 1:1 with models. Mirror the model loop's "edited rows survive"
  // rule by following the parent model's fate — only delete the profile when
  // its parent is no longer alive. Otherwise a user who renamed a retired
  // default model but left the profile at shipped defaults would be left with
  // an orphaned model.
  const aliveModelIds = new Set(
    (
      (await db.select({ id: modelsTable.id }).from(modelsTable).where(isNull(modelsTable.deletedAt))) as {
        id: string
      }[]
    ).map((r) => r.id),
  )

  const profiles = (await db
    .select()
    .from(modelProfilesTable)
    .where(isNull(modelProfilesTable.deletedAt))) as ModelProfile[]
  for (const row of profiles) {
    if (aliveModelIds.has(row.modelId) || !row.defaultHash) {
      continue
    }
    if (hashModelProfile(row) === row.defaultHash) {
      await db.update(modelProfilesTable).set({ deletedAt: now }).where(eq(modelProfilesTable.modelId, row.modelId))
    }
  }
}

export const reconcileDefaults = async (db: AnyDrizzleDatabase) => {
  await db.transaction(async (tx) => {
    // Soft-delete removed system defaults before reconciling current ones.
    await cleanupRemovedDefaults(tx)

    // AI models
    await reconcileDefaultsForTable(tx, modelsTable, defaultModels, hashModel)

    // Model profiles (after models, because they reference model IDs)
    await reconcileDefaultsForTable(tx, modelProfilesTable, defaultModelProfiles, hashModelProfile, 'modelId')

    // Modes
    await reconcileDefaultsForTable(tx, modesTable, defaultModes, hashMode)

    // Tasks
    await reconcileDefaultsForTable(tx, tasksTable, defaultTasks, hashTask)

    // Skills (the default skills supersede the legacy default automations,
    // which used to seed promptsTable here. See THU-547.)
    await reconcileDefaultsForTable(tx, skillsTable, defaultSkills, hashSkill)

    // Settings
    await reconcileDefaultsForTable(tx, settingsTable, defaultSettings, hashSetting, 'key')

    // Initialize anonymous ID for analytics (unique per user)
    await createSetting(tx, 'anonymous_id', uuidv7())
  })
}
