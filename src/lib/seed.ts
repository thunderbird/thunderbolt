import { createSetting, deleteSetting, getSetting } from '@/lib/dal'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable, promptsTable, tasksTable } from '../db/tables'
import { defaultAutomations, defaultModels } from './defaults'

export const seedModels = async () => {
  const db = DatabaseSingleton.instance.db

  for (const defaultModel of defaultModels) {
    await db.insert(modelsTable).values(defaultModel).onConflictDoNothing()
  }
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

  // Only set anonymous_id if it doesn't exist (unique per user)
  // @todo this should really be cryptographically secure
  await createSetting('anonymous_id', uuidv7())
}

export const seedTasks = async () => {
  const db = DatabaseSingleton.instance.db
  const existingTasks = await db.select().from(tasksTable).limit(1)

  if (existingTasks.length > 0) {
    return
  }

  /**
   * Using hardwired IDs to ensure consistency across installs.
   * New items should follow the pattern and have their ID hardwired.
   */
  const seedData = [
    {
      id: '0198ecc5-cc2b-735b-b478-93f8db7202ce',
      item: 'Connect your email account to get started',
      order: 100,
      isComplete: 0,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-96071aa92f62',
      item: 'Set your name and location in preferences for better AI responses',
      order: 200,
      isComplete: 0,
    },
    {
      id: '0198ecc5-cc2b-735b-b478-99e9874d61ba',
      item: 'Explore Thunderbolt Pro tools to extend capabilities',
      order: 300,
      isComplete: 0,
    },
  ]

  for (const task of seedData) {
    await db.insert(tasksTable).values(task)
  }
}

export const seedPrompts = async () => {
  const db = DatabaseSingleton.instance.db

  for (const defaultAutomation of defaultAutomations) {
    await db.insert(promptsTable).values(defaultAutomation).onConflictDoNothing()
  }
}
