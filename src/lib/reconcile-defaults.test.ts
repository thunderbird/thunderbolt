import { getAllModels } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable, promptsTable, settingsTable } from '../db/tables'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { reconcileDefaultsForTable } from './reconcile-defaults'
import type { Model, Prompt } from '@/types'

beforeAll(async () => {
  await setupTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('seedModels', () => {
  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    const models = (await db.select().from(modelsTable)) as Model[]
    expect(models.length).toBe(defaultModels.length)

    for (const defaultModel of defaultModels) {
      const inserted = models.find((m) => m.id === defaultModel.id)
      expect(inserted).toBeDefined()
      // Verify hash was computed during seed
      expect(inserted?.defaultHash).toBeDefined()
      expect(inserted?.defaultHash).toBe(hashModel(inserted!))
    }
  })

  test('updates unmodified rows on re-seed', async () => {
    const db = DatabaseSingleton.instance.db
    // First seed
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Get an unmodified model
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModels[0].id)).get()
    expect(model).toBeDefined()

    // Seed again - should be idempotent
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Model should still match default
    const modelAfterReseed = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModels[0].id)).get()
    expect(modelAfterReseed?.name).toBe(defaultModels[0].name)
    // Hash should still be computed correctly
    expect(modelAfterReseed?.defaultHash).toBe(hashModel(defaultModels[0]))
  })

  test('preserves user modifications', async () => {
    const db = DatabaseSingleton.instance.db
    // First seed
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // User modifies a model
    const defaultModel = defaultModels[0]
    await db.update(modelsTable).set({ name: 'User Modified Name' }).where(eq(modelsTable.id, defaultModel.id))

    // Seed again with "updated" default
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Should NOT be overwritten
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()
    expect(model?.name).toBe('User Modified Name')
    // Hash should still be the original default's hash
    expect(model?.defaultHash).toBe(hashModel(defaultModel))
  })

  test('handles mixed scenarios correctly', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Scenario 1: User modifies model 0
    await db.update(modelsTable).set({ name: 'User Modified' }).where(eq(modelsTable.id, defaultModels[0].id))

    // Scenario 2: Model 1 stays unmodified
    // Scenario 3: Model 2 is deleted (soft delete)
    await db
      .update(modelsTable)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(modelsTable.id, defaultModels[2]?.id))

    // Seed again
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    const models = await db.select().from(modelsTable)

    // Model 0 should keep user modification
    const model0 = models.find((m) => m.id === defaultModels[0].id)
    expect(model0?.name).toBe('User Modified')

    // Model 1 should be updated to latest default
    const model1 = models.find((m) => m.id === defaultModels[1].id)
    expect(model1?.name).toBe(defaultModels[1].name)

    // Model 2 should stay deleted - user deletions are respected
    const model2 = models.find((m) => m.id === defaultModels[2]?.id)
    expect(model2?.deletedAt).not.toBeNull()
  })

  test('soft-deleted models do not appear in getAllModels', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Get all models before deletion
    const modelsBefore = await getAllModels()
    expect(modelsBefore.length).toBe(defaultModels.length)

    // Soft delete a model
    await db.update(modelsTable).set({ deletedAt: Date.now() }).where(eq(modelsTable.id, defaultModels[0].id))

    // Get all models after deletion - should not include soft-deleted model
    const modelsAfter = await getAllModels()
    expect(modelsAfter.length).toBe(defaultModels.length - 1)
    expect(modelsAfter.find((m) => m.id === defaultModels[0].id)).toBeUndefined()

    // Re-seed should not restore the deleted model
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
    const modelsAfterReseed = await getAllModels()
    expect(modelsAfterReseed.length).toBe(defaultModels.length - 1)
    expect(modelsAfterReseed.find((m) => m.id === defaultModels[0].id)).toBeUndefined()
  })
})

describe('seedPrompts', () => {
  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    // Need models for FK constraint
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
    await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

    const prompts = (await db.select().from(promptsTable)) as Prompt[]
    expect(prompts.length).toBe(defaultAutomations.length)

    for (const defaultAutomation of defaultAutomations) {
      const inserted = prompts.find((p) => p.id === defaultAutomation.id)
      expect(inserted).toBeDefined()
      // Verify hash was computed during seed
      expect(inserted?.defaultHash).toBeDefined()
      expect(inserted?.defaultHash).toBe(hashPrompt(inserted!))
    }
  })

  test('updates unmodified prompts on re-seed', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
    await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

    // Get an unmodified prompt
    const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomations[0].id)).get()
    expect(prompt).toBeDefined()

    // Seed again - should be idempotent
    await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

    // Prompt should still match default
    const promptAfterReseed = await db
      .select()
      .from(promptsTable)
      .where(eq(promptsTable.id, defaultAutomations[0].id))
      .get()
    expect(promptAfterReseed?.title).toBe(defaultAutomations[0].title)
    // Hash should still be computed correctly
    expect(promptAfterReseed?.defaultHash).toBe(hashPrompt(defaultAutomations[0]))
  })

  test('preserves user modifications', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
    await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

    // User modifies a prompt
    const defaultPrompt = defaultAutomations[0]
    await db.update(promptsTable).set({ title: 'User Modified Title' }).where(eq(promptsTable.id, defaultPrompt.id))

    // Seed again
    await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)

    // Should NOT be overwritten
    const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultPrompt.id)).get()
    expect(prompt?.title).toBe('User Modified Title')
    // Hash should still be the original default's hash
    expect(prompt?.defaultHash).toBe(hashPrompt(defaultPrompt))
  })
})

describe('reconcileDefaultsForTable', () => {
  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    const settings = await db.select().from(settingsTable)
    // Should have all default settings plus anonymous_id
    expect(settings.length).toBeGreaterThanOrEqual(defaultSettings.length)

    for (const defaultSetting of defaultSettings) {
      const inserted = settings.find((s) => s.key === defaultSetting.key)
      expect(inserted).toBeDefined()
      // Verify hash was computed during seed
      expect(inserted?.defaultHash).toBeDefined()
      expect(inserted?.defaultHash).toBe(hashSetting(inserted!))
    }
  })

  test('updates unmodified settings on re-seed', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    // Get an unmodified setting
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSettings[0].key)).get()
    expect(setting).toBeDefined()

    // Seed again - should be idempotent
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    // Setting should still match default
    const settingAfterReseed = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, defaultSettings[0].key))
      .get()
    expect(settingAfterReseed?.value).toBe(defaultSettings[0].value)
    // Hash should still be computed correctly
    expect(settingAfterReseed?.defaultHash).toBe(hashSetting(defaultSettings[0]))
  })

  test('preserves user modifications', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    // User modifies a setting
    const defaultSetting = defaultSettings[0]
    await db
      .update(settingsTable)
      .set({ value: 'user_modified_value' })
      .where(eq(settingsTable.key, defaultSetting.key))

    // Seed again
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    // Should NOT be overwritten
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
    expect(setting?.value).toBe('user_modified_value')
    // Hash should still be the original default's hash
    expect(setting?.defaultHash).toBe(hashSetting(defaultSetting))
  })

  test('handles mixed scenarios correctly', async () => {
    const db = DatabaseSingleton.instance.db
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    // Scenario 1: User modifies setting 0
    await db.update(settingsTable).set({ value: 'modified' }).where(eq(settingsTable.key, defaultSettings[0].key))

    // Scenario 2: Setting 1 stays unmodified

    // Seed again
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, 'key')

    const settings = await db.select().from(settingsTable)

    // Setting 0 should keep user modification
    const setting0 = settings.find((s) => s.key === defaultSettings[0].key)
    expect(setting0?.value).toBe('modified')

    // Setting 1 should be updated to latest default
    const setting1 = settings.find((s) => s.key === defaultSettings[1].key)
    expect(setting1?.value).toBe(defaultSettings[1].value)
  })

  test('adds defaultHash to settings that lack it', async () => {
    const db = DatabaseSingleton.instance.db

    // Create a setting without defaultHash (simulates old data or manual creation)
    await db.insert(settingsTable).values({
      key: 'test_setting_no_hash',
      value: 'some_value',
      updatedAt: null,
      defaultHash: null,
    })

    // Create a default for this setting
    const testDefault = {
      key: 'test_setting_no_hash',
      value: 'default_value',
      updatedAt: null,
      defaultHash: null,
      userId: null,
    }

    // Seed with this default
    await reconcileDefaultsForTable(db, settingsTable, [testDefault], hashSetting, 'key')

    // Should now have a defaultHash
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_setting_no_hash')).get()
    expect(setting?.defaultHash).toBeDefined()
    expect(setting?.defaultHash).toBe(hashSetting(testDefault))
    // Value should be preserved
    expect(setting?.value).toBe('some_value')
  })

  test('preserves user values set via recomputeHash when code default is null', async () => {
    const db = DatabaseSingleton.instance.db

    // Use a unique test key to avoid conflicts with defaultSettings
    const testKey = 'test_localization_setting'

    // Simulate the recomputeHash scenario:
    // User accepts localization settings (e.g., distance_unit = "metric")
    // Both value AND defaultHash are set to match (this is what recomputeHash does)
    const userSetValue = 'metric'
    const userSetting = {
      key: testKey,
      value: userSetValue,
      updatedAt: null,
      defaultHash: null,
      userId: null,
    }

    await db.insert(settingsTable).values({
      ...userSetting,
      // This simulates recomputeHash: true - hash matches the user's value
      defaultHash: hashSetting(userSetting),
    })

    // Verify the hash matches (as recomputeHash would set it)
    const beforeReconcile = await db.select().from(settingsTable).where(eq(settingsTable.key, testKey)).get()
    expect(beforeReconcile?.value).toBe(userSetValue)
    expect(beforeReconcile?.defaultHash).toBe(hashSetting(userSetting))

    // Code default has null value (like localization settings)
    const nullDefault = {
      key: testKey,
      value: null,
      updatedAt: null,
      defaultHash: null,
      userId: null,
    }

    // Run reconcile - this previously would overwrite user's "metric" with null
    await reconcileDefaultsForTable(db, settingsTable, [nullDefault], hashSetting, 'key')

    // User's value should be PRESERVED, not overwritten with null
    const afterReconcile = await db.select().from(settingsTable).where(eq(settingsTable.key, testKey)).get()
    expect(afterReconcile?.value).toBe(userSetValue)
    // Hash should remain unchanged
    expect(afterReconcile?.defaultHash).toBe(hashSetting(userSetting))
  })

  test('still updates when both existing and default values are null', async () => {
    const db = DatabaseSingleton.instance.db

    // Setting with null value and matching hash
    const nullSetting = {
      key: 'optional_setting',
      value: null,
      updatedAt: null,
      defaultHash: null,
      userId: null,
    }

    await db.insert(settingsTable).values({
      ...nullSetting,
      defaultHash: hashSetting(nullSetting),
    })

    // Code default also has null value
    const nullDefault = {
      key: 'optional_setting',
      value: null,
      updatedAt: null,
      defaultHash: null,
      userId: null,
    }

    // Run reconcile - should proceed (this is a no-op anyway)
    await reconcileDefaultsForTable(db, settingsTable, [nullDefault], hashSetting, 'key')

    // Value should still be null (no change, but update was allowed)
    const afterReconcile = await db.select().from(settingsTable).where(eq(settingsTable.key, 'optional_setting')).get()
    expect(afterReconcile?.value).toBeNull()
  })
})
