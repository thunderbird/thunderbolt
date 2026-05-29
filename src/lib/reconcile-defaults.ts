/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createSetting } from '@/dal'
import { eq } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import {
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  settingsTable,
  skillsTable,
  tasksTable,
} from '../db/tables'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { defaultModes, hashMode } from '../defaults/modes'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { defaultSkills, hashSkill } from '../defaults/skills'
import { defaultTasks, hashTask } from '../defaults/tasks'

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
 * Soft-delete legacy system defaults whose hash still matches the original.
 * Edited rows survive. Compute hashes with `hashValues([...])` against the
 * legacy field order when adding entries.
 */
const removedDefaults: ReadonlyArray<{ modelId: string; modelHash: string; profileHash: string }> = [
  {
    // Mistral Medium 3.1 (removed in THU-545)
    modelId: '019af08a-9836-783d-ab56-39b9fec48af1',
    modelHash: '-3zuuqs',
    profileHash: 'ytmc3a',
  },
]

export const cleanupRemovedDefaults = async (db: AnyDrizzleDatabase) => {
  const nowIso = new Date().toISOString()
  for (const removed of removedDefaults) {
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, removed.modelId)).get()
    if (model && !model.deletedAt && model.defaultHash === removed.modelHash) {
      await db.update(modelsTable).set({ deletedAt: nowIso }).where(eq(modelsTable.id, removed.modelId))
    }

    const profile = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, removed.modelId))
      .get()
    if (profile && !profile.deletedAt && profile.defaultHash === removed.profileHash) {
      await db
        .update(modelProfilesTable)
        .set({ deletedAt: nowIso })
        .where(eq(modelProfilesTable.modelId, removed.modelId))
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

    // Automations (Prompts)
    await reconcileDefaultsForTable(tx, promptsTable, defaultAutomations, hashPrompt)

    // Skills
    await reconcileDefaultsForTable(tx, skillsTable, defaultSkills, hashSkill)

    // Settings
    await reconcileDefaultsForTable(tx, settingsTable, defaultSettings, hashSetting, 'key')

    // Initialize anonymous ID for analytics (unique per user)
    await createSetting(tx, 'anonymous_id', uuidv7())
  })
}
