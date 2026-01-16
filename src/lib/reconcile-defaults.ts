import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createSetting } from '@/dal'
import { eq } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { modelsTable, promptsTable, settingsTable, tasksTable } from '../db/tables'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
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
        // Protect user-set values from being overwritten by null defaults.
        // This handles localization settings (distance_unit, etc.) where the user explicitly
        // set a value via recomputeHash, but the code default is null.
        // For non-settings tables, 'value' is undefined so this check is safely skipped.
        const wouldOverwriteUserValue = (existing as any).value !== null && (defaultItem as any).value === null

        if (wouldOverwriteUserValue) continue

        // Unmodified - safe to update to new default
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

export const reconcileDefaults = async (db: AnyDrizzleDatabase) => {
  // AI models
  await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

  // Tasks
  await reconcileDefaultsForTable(db, tasksTable, defaultTasks, hashTask)

  // Automations (Prompts)
  await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

  // Settings
  await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

  // Initialize anonymous ID for analytics (unique per user)
  await createSetting('anonymous_id', uuidv7())
}
