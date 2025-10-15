import { createSetting, deleteSetting, getSetting } from '@/lib/dal'
import { eq } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable, promptsTable, settingsTable, tasksTable } from '../db/tables'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { defaultTasks, hashTask } from '../defaults/tasks'

/**
 * Generic function to seed defaults into a table
 * Inserts new defaults and updates unmodified existing ones
 * @param table - The database table to seed
 * @param defaults - Array of default items to seed
 * @param hashFn - Function to compute hash of an item
 * @param keyField - Name of the primary key field (defaults to 'id')
 */
export const seedDefaults = async <T extends { defaultHash: string | null }>(
  table: SQLiteTableWithColumns<any>,
  defaults: readonly T[],
  hashFn: (item: any) => string,
  keyField: string = 'id',
) => {
  const db = DatabaseSingleton.instance.db

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

export const seedModels = async () => {
  await seedDefaults(modelsTable, defaultModels, hashModel)
}

/**
 * Clean up old default settings that should now use code defaults
 * Deletes cloud_url if it matches old default patterns so users get the new /v1 endpoint
 * Also removes other settings that were previously seeded with defaults
 */
export const cleanupOldDefaultSettings = async () => {
  const cloudUrl = await getSetting<string>('cloud_url', null)

  if (cloudUrl) {
    const shouldDelete =
      cloudUrl.startsWith('https://thunderbolt-hooc.onrender.com') || cloudUrl.startsWith('http://localhost:8000')

    if (shouldDelete) {
      await deleteSetting('cloud_url')
    }
  }
}

export const seedSettings = async () => {
  await cleanupOldDefaultSettings()

  // Seed default settings using the same pattern as models and automations
  await seedDefaults(settingsTable, defaultSettings, hashSetting, 'key')

  // Only set anonymous_id if it doesn't exist (unique per user)
  // @todo this should really be cryptographically secure
  await createSetting('anonymous_id', uuidv7())
}

export const seedTasks = async () => {
  await seedDefaults(tasksTable, defaultTasks, hashTask)
}

export const seedPrompts = async () => {
  await seedDefaults(promptsTable, defaultAutomations, hashPrompt)
}
