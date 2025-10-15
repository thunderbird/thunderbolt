import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { migrate } from '../db/migrate'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable, promptsTable, settingsTable } from '../db/tables'
import { defaultAutomations, hashPrompt } from './defaults/automations'
import { defaultModels, hashModel } from './defaults/models'
import { defaultSettings, hashSetting } from './defaults/settings'
import { seedModels, seedPrompts, seedSettings } from './seed'

beforeAll(async () => {
  await DatabaseSingleton.instance.initialize({ type: 'sqlocal', path: ':memory:' })
  const db = DatabaseSingleton.instance.db
  await migrate(db)
})

describe('seedModels', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    // Clean up models table
    await db.delete(modelsTable)
  })

  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    await seedModels()

    const models = await db.select().from(modelsTable)
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
    await seedModels()

    // Get an unmodified model
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModels[0].id)).get()
    expect(model).toBeDefined()

    // Seed again - should be idempotent
    await seedModels()

    // Model should still match default
    const modelAfterReseed = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModels[0].id)).get()
    expect(modelAfterReseed?.name).toBe(defaultModels[0].name)
    // Hash should still be computed correctly
    expect(modelAfterReseed?.defaultHash).toBe(hashModel(defaultModels[0]))
  })

  test('preserves user modifications', async () => {
    const db = DatabaseSingleton.instance.db
    // First seed
    await seedModels()

    // User modifies a model
    const defaultModel = defaultModels[0]
    await db.update(modelsTable).set({ name: 'User Modified Name' }).where(eq(modelsTable.id, defaultModel.id))

    // Seed again with "updated" default
    await seedModels()

    // Should NOT be overwritten
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()
    expect(model?.name).toBe('User Modified Name')
    // Hash should still be the original default's hash
    expect(model?.defaultHash).toBe(hashModel(defaultModel))
  })

  test('handles mixed scenarios correctly', async () => {
    const db = DatabaseSingleton.instance.db
    await seedModels()

    // Scenario 1: User modifies model 0
    await db.update(modelsTable).set({ name: 'User Modified' }).where(eq(modelsTable.id, defaultModels[0].id))

    // Scenario 2: Model 1 stays unmodified
    // Scenario 3: Model 2 is deleted (soft delete)
    await db
      .update(modelsTable)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(modelsTable.id, defaultModels[2]?.id))

    // Seed again
    await seedModels()

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
    await seedModels()

    // Get all models before deletion
    const { getAllModels } = await import('./dal')
    const modelsBefore = await getAllModels()
    expect(modelsBefore.length).toBe(defaultModels.length)

    // Soft delete a model
    await db.update(modelsTable).set({ deletedAt: Date.now() }).where(eq(modelsTable.id, defaultModels[0].id))

    // Get all models after deletion - should not include soft-deleted model
    const modelsAfter = await getAllModels()
    expect(modelsAfter.length).toBe(defaultModels.length - 1)
    expect(modelsAfter.find((m) => m.id === defaultModels[0].id)).toBeUndefined()

    // Re-seed should not restore the deleted model
    await seedModels()
    const modelsAfterReseed = await getAllModels()
    expect(modelsAfterReseed.length).toBe(defaultModels.length - 1)
    expect(modelsAfterReseed.find((m) => m.id === defaultModels[0].id)).toBeUndefined()
  })
})

describe('seedPrompts', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    // Clean up prompts table
    await db.delete(promptsTable)
  })

  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    // Need models for FK constraint
    await seedModels()
    await seedPrompts()

    const prompts = await db.select().from(promptsTable)
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
    await seedModels()
    await seedPrompts()

    // Get an unmodified prompt
    const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomations[0].id)).get()
    expect(prompt).toBeDefined()

    // Seed again - should be idempotent
    await seedPrompts()

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
    await seedModels()
    await seedPrompts()

    // User modifies a prompt
    const defaultPrompt = defaultAutomations[0]
    await db.update(promptsTable).set({ title: 'User Modified Title' }).where(eq(promptsTable.id, defaultPrompt.id))

    // Seed again
    await seedPrompts()

    // Should NOT be overwritten
    const prompt = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultPrompt.id)).get()
    expect(prompt?.title).toBe('User Modified Title')
    // Hash should still be the original default's hash
    expect(prompt?.defaultHash).toBe(hashPrompt(defaultPrompt))
  })
})

describe('seedSettings', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    // Clean up settings table
    await db.delete(settingsTable)
  })

  test('inserts new defaults on first run', async () => {
    const db = DatabaseSingleton.instance.db
    await seedSettings()

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
    await seedSettings()

    // Get an unmodified setting
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSettings[0].key)).get()
    expect(setting).toBeDefined()

    // Seed again - should be idempotent
    await seedSettings()

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
    await seedSettings()

    // User modifies a setting
    const defaultSetting = defaultSettings[0]
    await db
      .update(settingsTable)
      .set({ value: 'user_modified_value' })
      .where(eq(settingsTable.key, defaultSetting.key))

    // Seed again
    await seedSettings()

    // Should NOT be overwritten
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
    expect(setting?.value).toBe('user_modified_value')
    // Hash should still be the original default's hash
    expect(setting?.defaultHash).toBe(hashSetting(defaultSetting))
  })

  test('handles mixed scenarios correctly', async () => {
    const db = DatabaseSingleton.instance.db
    await seedSettings()

    // Scenario 1: User modifies setting 0
    await db.update(settingsTable).set({ value: 'modified' }).where(eq(settingsTable.key, defaultSettings[0].key))

    // Scenario 2: Setting 1 stays unmodified

    // Seed again
    await seedSettings()

    const settings = await db.select().from(settingsTable)

    // Setting 0 should keep user modification
    const setting0 = settings.find((s) => s.key === defaultSettings[0].key)
    expect(setting0?.value).toBe('modified')

    // Setting 1 should be updated to latest default
    const setting1 = settings.find((s) => s.key === defaultSettings[1].key)
    expect(setting1?.value).toBe(defaultSettings[1].value)
  })
})
