/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteModel, getAllModels } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { modelProfilesTable, modelsTable, promptsTable, settingsTable } from '../db/tables'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { defaultModels, defaultModelsVersion, hashModel, type SharedModel } from '@shared/defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import type { ModelsDefaults } from './pick-defaults'
import { cleanupRemovedDefaults, reconcileDefaults, reconcileDefaultsForTable } from './reconcile-defaults'
import type { Model, ModelProfile, Prompt } from '@/types'

/** A model id no current default uses — stands in for any retired default. */
const retiredModelId = '019af08a-9836-783d-ab56-39b9fec48af1'

/** Build a fully-populated model row whose stored defaultHash matches its contents. */
const buildRetiredModel = (overrides: Partial<Model> = {}): Model => {
  const base: Model = {
    id: retiredModelId,
    name: 'Retired Model',
    provider: 'thunderbolt',
    model: 'retired-model',
    isSystem: 1,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    supportsParallelToolCalls: 0,
    deletedAt: null,
    apiKey: null,
    url: null,
    defaultHash: null,
    vendor: 'mistral',
    description: 'Retired',
    userId: null,
    ...overrides,
  }
  return { ...base, defaultHash: hashModel(base) }
}

/** Build a profile whose stored defaultHash matches its contents. */
const buildRetiredProfile = (overrides: Partial<ModelProfile> = {}): ModelProfile => {
  const base: ModelProfile = {
    modelId: retiredModelId,
    temperature: 0.2,
    maxSteps: 20,
    maxAttempts: 2,
    nudgeThreshold: 6,
    useSystemMessageModeDeveloper: 0,
    providerOptions: null,
    toolsOverride: null,
    linkPreviewsOverride: null,
    chatModeAddendum: null,
    searchModeAddendum: null,
    researchModeAddendum: null,
    citationReinforcementEnabled: 0,
    citationReinforcementPrompt: null,
    nudgeFinalStep: null,
    nudgePreventive: null,
    nudgeRetry: null,
    nudgeSearchFinalStep: null,
    nudgeSearchPreventive: null,
    nudgeSearchRetry: null,
    deletedAt: null,
    defaultHash: null,
    userId: null,
    ...overrides,
  }
  return { ...base, defaultHash: hashModelProfile(base) }
}

beforeAll(async () => {
  await setupTestDatabase()
})

// Also reset before each test — `setupTestDatabase` reconciles defaults into
// the DB, so without this guard the first test picked by --randomize inherits
// pre-populated rows (any raw `db.insert(modelsTable).values(defaultModels[N])`
// then hits a PK conflict). Between-test reset alone doesn't cover that gap.
beforeEach(async () => {
  await resetTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('seedModels', () => {
  test('inserts new defaults on first run', async () => {
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Scenario 1: User modifies model 0
    await db.update(modelsTable).set({ name: 'User Modified' }).where(eq(modelsTable.id, defaultModels[0].id))

    // Scenario 2: Model 1 stays unmodified
    // Scenario 3: Model 2 is user-deleted via the DAL — this scrubs the row's
    // nullable columns (including defaultHash) via `clearNullableColumns`,
    // which is what distinguishes a user delete from a cleanup soft-delete
    // and prevents the resurrect branch from undoing it.
    await deleteModel(db, defaultModels[2].id)

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
    const db = getDb()
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    // Get all models before deletion
    const modelsBefore = await getAllModels(getDb())
    expect(modelsBefore.length).toBe(defaultModels.length)

    // User-delete a model via the DAL (scrubs nullable columns including
    // defaultHash so the resurrect branch treats it as a real user deletion).
    await deleteModel(db, defaultModels[0].id)

    // Get all models after deletion - should not include soft-deleted model
    const modelsAfter = await getAllModels(getDb())
    expect(modelsAfter.length).toBe(defaultModels.length - 1)
    expect(modelsAfter.find((m) => m.id === defaultModels[0].id)).toBeUndefined()

    // Re-seed should not restore the deleted model
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
    const modelsAfterReseed = await getAllModels(getDb())
    expect(modelsAfterReseed.length).toBe(defaultModels.length - 1)
    expect(modelsAfterReseed.find((m) => m.id === defaultModels[0].id)).toBeUndefined()
  })
})

describe('cleanupRemovedDefaults', () => {
  test('soft-deletes retired system model + profile whose hashes still match', async () => {
    const db = getDb()
    await db.insert(modelsTable).values(buildRetiredModel())
    await db.insert(modelProfilesTable).values(buildRetiredProfile())

    await cleanupRemovedDefaults(db)

    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    expect(model?.deletedAt).not.toBeNull()
    const profile = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, retiredModelId))
      .get()
    expect(profile?.deletedAt).not.toBeNull()
  })

  test('sweeps retired system rows even when the stored hash no longer matches', async () => {
    const db = getDb()
    // Stored hash deliberately does not match the row contents. Under the old
    // "hash-match required" rule, this row would survive as "user edited" and
    // get stuck permanently once the id was retired from defaults. The updated
    // rule sweeps it anyway — covers the historical `hashModel` field-list
    // changes that produced false-positive "modified" state on unedited rows.
    await db.insert(modelsTable).values({ ...buildRetiredModel(), name: 'User Renamed' })

    await cleanupRemovedDefaults(db)

    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    expect(model?.deletedAt).not.toBeNull()
  })

  test('sweeps profile alongside its parent when the parent is a retired system row', async () => {
    const db = getDb()
    // Parent model has a hash mismatch (previously would survive cleanup).
    // Profile hash matches. Under the new rule the parent is swept, and the
    // profile follows because its parent is no longer alive.
    await db.insert(modelsTable).values({ ...buildRetiredModel(), name: 'User Renamed' })
    await db.insert(modelProfilesTable).values(buildRetiredProfile())

    await cleanupRemovedDefaults(db)

    const profile = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, retiredModelId))
      .get()
    expect(profile?.deletedAt).not.toBeNull()
  })

  test('leaves current defaults alone', async () => {
    const db = getDb()
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

    await cleanupRemovedDefaults(db)

    for (const def of defaultModels) {
      const row = await db.select().from(modelsTable).where(eq(modelsTable.id, def.id)).get()
      expect(row?.deletedAt).toBeNull()
    }
  })

  test('leaves user-created rows alone (no defaultHash)', async () => {
    const db = getDb()
    await db.insert(modelsTable).values({ ...buildRetiredModel(), isSystem: 0, defaultHash: null })

    await cleanupRemovedDefaults(db)

    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    expect(model?.deletedAt).toBeNull()
  })

  test('no-op when retired row is absent', async () => {
    const db = getDb()
    await cleanupRemovedDefaults(db)
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    expect(model).toBeUndefined()
  })

  test('idempotent — second run does not re-touch deletedAt', async () => {
    const db = getDb()
    await db.insert(modelsTable).values(buildRetiredModel())

    await cleanupRemovedDefaults(db)
    const after1 = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    const firstDeletedAt = after1?.deletedAt
    expect(firstDeletedAt).not.toBeNull()

    await cleanupRemovedDefaults(db)
    const after2 = await db.select().from(modelsTable).where(eq(modelsTable.id, retiredModelId)).get()
    expect(after2?.deletedAt).toBe(firstDeletedAt!)
  })
})

describe('seedPrompts', () => {
  test('inserts new defaults on first run', async () => {
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

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
    const db = getDb()
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    // Get an unmodified setting
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSettings[0].key)).get()
    expect(setting).toBeDefined()

    // Seed again - should be idempotent
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

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
    const db = getDb()
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    // User modifies a setting
    const defaultSetting = defaultSettings[0]
    await db
      .update(settingsTable)
      .set({ value: 'user_modified_value' })
      .where(eq(settingsTable.key, defaultSetting.key))

    // Seed again
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    // Should NOT be overwritten
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
    expect(setting?.value).toBe('user_modified_value')
    // Hash should still be the original default's hash
    expect(setting?.defaultHash).toBe(hashSetting(defaultSetting))
  })

  test('handles mixed scenarios correctly', async () => {
    const db = getDb()
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    // Scenario 1: User modifies setting 0
    await db.update(settingsTable).set({ value: 'modified' }).where(eq(settingsTable.key, defaultSettings[0].key))

    // Scenario 2: Setting 1 stays unmodified

    // Seed again
    await reconcileDefaultsForTable(db, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    const settings = await db.select().from(settingsTable)

    // Setting 0 should keep user modification
    const setting0 = settings.find((s) => s.key === defaultSettings[0].key)
    expect(setting0?.value).toBe('modified')

    // Setting 1 should be updated to latest default
    const setting1 = settings.find((s) => s.key === defaultSettings[1].key)
    expect(setting1?.value).toBe(defaultSettings[1].value)
  })

  test('adds defaultHash to settings that lack it', async () => {
    const db = getDb()

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
    await reconcileDefaultsForTable(db, settingsTable, [testDefault], hashSetting, { keyField: 'key' })

    // Should now have a defaultHash
    const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_setting_no_hash')).get()
    expect(setting?.defaultHash).toBeDefined()
    expect(setting?.defaultHash).toBe(hashSetting(testDefault))
    // Value should be preserved
    expect(setting?.value).toBe('some_value')
  })

  test('preserves user values set via recomputeHash when code default is null', async () => {
    const db = getDb()

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
    await reconcileDefaultsForTable(db, settingsTable, [nullDefault], hashSetting, { keyField: 'key' })

    // User's value should be PRESERVED, not overwritten with null
    const afterReconcile = await db.select().from(settingsTable).where(eq(settingsTable.key, testKey)).get()
    expect(afterReconcile?.value).toBe(userSetValue)
    // Hash should remain unchanged
    expect(afterReconcile?.defaultHash).toBe(hashSetting(userSetting))
  })

  test('no-op when defaults array is empty', async () => {
    const db = getDb()
    await reconcileDefaultsForTable(db, settingsTable, [], hashSetting, { keyField: 'key' })

    const settings = await db.select().from(settingsTable)
    expect(settings.length).toBe(0)
  })

  test('canOverwrite=false but canResurrect=true still resurrects a cleanup-shaped soft-delete', async () => {
    const db = getDb()

    // Simulate a pre-THU-637 client's `cleanupRemovedDefaults` having
    // soft-deleted a currently-shipped default: `deletedAt` is set but
    // `defaultHash` still matches the content-minus-deletedAt (cleanup only
    // touches deletedAt). Resurrect must fire on an older-bundle-but-fully
    // -synced device (canOverwrite=false, canResurrect=true), otherwise the
    // row stays deleted for good once `stored.version` catches up.
    const shipped = defaultModels[0]
    await db.insert(modelsTable).values({
      ...shipped,
      deletedAt: '2026-01-01T00:00:00.000Z',
      defaultHash: hashModel(shipped),
    })

    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel, {
      canOverwrite: false,
      canResurrect: true,
    })

    const row = await db.select().from(modelsTable).where(eq(modelsTable.id, shipped.id)).get()
    expect(row?.deletedAt).toBeNull()
  })

  test('canResurrect=false skips resurrect even for a cleanup-shaped soft-delete', async () => {
    const db = getDb()

    // Sync incomplete + populated table → `canResurrect=false`. The row's
    // "soft-deleted" flag may be a partial-sync artefact of an authoritative
    // retirement; un-deleting would race with cloud state. Leave it, retry
    // on a later boot when sync has settled.
    const shipped = defaultModels[0]
    await db.insert(modelsTable).values({
      ...shipped,
      deletedAt: '2026-01-01T00:00:00.000Z',
      defaultHash: hashModel(shipped),
    })

    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel, {
      canOverwrite: false,
      canResurrect: false,
    })

    const row = await db.select().from(modelsTable).where(eq(modelsTable.id, shipped.id)).get()
    expect(row?.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('canOverwrite=false does not resurrect a user-driven soft-delete', async () => {
    const db = getDb()

    // User-driven `deleteModel` scrubs every nullable column via
    // `clearNullableColumns` — most importantly, `defaultHash` becomes null.
    // The resurrect guard's hash check can't satisfy a null defaultHash, so
    // the user's deletion is preserved regardless of canResurrect.
    const shipped = defaultModels[0]
    await db.insert(modelsTable).values({
      ...shipped,
      name: null,
      model: null,
      description: null,
      vendor: null,
      deletedAt: '2026-01-01T00:00:00.000Z',
      defaultHash: null,
    })

    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel, {
      canOverwrite: false,
      canResurrect: true,
    })

    const row = await db.select().from(modelsTable).where(eq(modelsTable.id, shipped.id)).get()
    expect(row?.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('canOverwrite=false skips overwrites of unedited existing rows', async () => {
    const db = getDb()

    // Row authored by a newer bundle (same id as a current default, but
    // different content, with an authoring hash that matches its content —
    // i.e., it looks "unedited from a newer version's perspective").
    const bundleRow = defaultModels[0]
    const newer: SharedModel = { ...bundleRow, name: 'Newer Bundle Name' }
    await db.insert(modelsTable).values({ ...newer, defaultHash: hashModel(newer) })

    // With canOverwrite=false the older bundle must not touch it.
    await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel, { canOverwrite: false })

    const row = await db.select().from(modelsTable).where(eq(modelsTable.id, bundleRow.id)).get()
    expect(row?.name).toBe('Newer Bundle Name')
    expect(row?.defaultHash).toBe(hashModel(newer))
  })

  test('still updates when both existing and default values are null', async () => {
    const db = getDb()

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
    await reconcileDefaultsForTable(db, settingsTable, [nullDefault], hashSetting, { keyField: 'key' })

    // Value should still be null (no change, but update was allowed)
    const afterReconcile = await db.select().from(settingsTable).where(eq(settingsTable.key, 'optional_setting')).get()
    expect(afterReconcile?.value).toBeNull()
  })
})

/**
 * Regression tests for THU-637 ("Models are janky"): older-bundle devices used
 * to overwrite rows authored by newer-bundle devices via sync, causing every
 * launch to flap between old/new models. The version gate stops this.
 */
describe('reconcileDefaults version gate (THU-637)', () => {
  const modelsVersionKey = 'defaults_version.models'

  const readStoredModelsVersion = async () => {
    const db = getDb()
    const row = await db.select().from(settingsTable).where(eq(settingsTable.key, modelsVersionKey)).get()
    return row?.value == null ? null : Number(row.value)
  }

  test('fresh install applies bundle defaults and stamps the applied version', async () => {
    const db = getDb()
    await reconcileDefaults(db)

    const models = await db.select().from(modelsTable)
    for (const bundle of defaultModels) {
      expect(models.find((m) => m.id === bundle.id)).toBeDefined()
    }

    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion)
  })

  test('older bundle does not downgrade rows authored by a newer version', async () => {
    const db = getDb()

    // Prior application by a newer-version device: rows carry the newer
    // content + matching authoring hash, and stored version is bumped past ours.
    const [bundleRow, ...restBundle] = defaultModels
    const newerRow: SharedModel = { ...bundleRow, name: 'Newer Bundle Name', description: 'from newer' }
    await db.insert(modelsTable).values({ ...newerRow, defaultHash: hashModel(newerRow) })
    for (const other of restBundle) {
      await db.insert(modelsTable).values({ ...other, defaultHash: hashModel(other) })
    }
    await db.insert(settingsTable).values({
      key: modelsVersionKey,
      value: String(defaultModelsVersion + 1),
    })

    await reconcileDefaults(db)

    const preserved = await db.select().from(modelsTable).where(eq(modelsTable.id, bundleRow.id)).get()
    expect(preserved?.name).toBe('Newer Bundle Name')
    expect(preserved?.description).toBe('from newer')
    expect(preserved?.defaultHash).toBe(hashModel(newerRow))

    // Older bundle must not regress the applied version.
    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion + 1)
  })

  test('older bundle does not soft-delete future defaults it does not recognize', async () => {
    const db = getDb()

    // Newer version added a system model our bundle does not know about.
    // It synced in with a matching authoring hash. Cleanup would normally
    // remove it (id not in defaultModels, hash matches) — the gate must skip.
    const futureRow = buildRetiredModel()
    await db.insert(modelsTable).values(futureRow)
    await db.insert(settingsTable).values({
      key: modelsVersionKey,
      value: String(defaultModelsVersion + 1),
    })

    await reconcileDefaults(db)

    const alive = await db.select().from(modelsTable).where(eq(modelsTable.id, futureRow.id)).get()
    expect(alive?.deletedAt).toBeNull()
  })

  test('newer bundle upgrades in place and advances the stored version', async () => {
    const db = getDb()

    // Prime with the current bundle, then rewind to look like a prior version.
    await reconcileDefaults(db)
    const targetId = defaultModels[0].id
    const staleRow = { ...defaultModels[0], name: 'stale name' }
    await db
      .update(modelsTable)
      .set({ name: 'stale name', defaultHash: hashModel(staleRow) })
      .where(eq(modelsTable.id, targetId))
    await db
      .update(settingsTable)
      .set({ value: String(defaultModelsVersion - 1) })
      .where(eq(settingsTable.key, modelsVersionKey))

    await reconcileDefaults(db)

    const upgraded = await db.select().from(modelsTable).where(eq(modelsTable.id, targetId)).get()
    expect(upgraded?.name).toBe(defaultModels[0].name)
    expect(upgraded?.defaultHash).toBe(hashModel(defaultModels[0]))
    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion)
  })

  test('user edits survive under both older and newer bundle passes', async () => {
    const db = getDb()
    await reconcileDefaults(db)

    // User renames a row after the first apply.
    const editedId = defaultModels[0].id
    await db.update(modelsTable).set({ name: 'user-picked name' }).where(eq(modelsTable.id, editedId))

    // Older-bundle pass: rewind stored version — user edit must still survive.
    await db
      .update(settingsTable)
      .set({ value: String(defaultModelsVersion + 1) })
      .where(eq(settingsTable.key, modelsVersionKey))
    await reconcileDefaults(db)

    const stillEdited = await db.select().from(modelsTable).where(eq(modelsTable.id, editedId)).get()
    expect(stillEdited?.name).toBe('user-picked name')
  })

  test('non-numeric stored version routes to UPDATE, not INSERT (no PK conflict)', async () => {
    const db = getDb()

    // Simulate a corrupted / previous-schema value in the version row.
    await db.insert(settingsTable).values({ key: modelsVersionKey, value: 'not-a-number' })

    // readAppliedVersion treats non-numeric as null-version-but-exists → gate opens,
    // upsert must UPDATE the row. If it wrongly INSERTs, this throws on PK conflict.
    await reconcileDefaults(db)

    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion)
  })

  test('older bundle does not resurrect defaults its bundle happens to know but the newer version retired', async () => {
    const db = getDb()

    // Newer version has already applied on this account (stored version bumped
    // past our bundle) and has retired one of the defaults our bundle still
    // ships. To exercise the insert branch we seed the *other* defaults but
    // leave the retired one absent — cloud will deliver its soft-delete later.
    const [retired, ...alive] = defaultModels
    for (const other of alive) {
      await db.insert(modelsTable).values({ ...other, defaultHash: hashModel(other) })
    }
    await db.insert(settingsTable).values({
      key: 'defaults_version.models',
      value: String(defaultModelsVersion + 1),
    })

    await reconcileDefaults(db)

    // Our older bundle must not seed the retired id.
    const ghost = await db.select().from(modelsTable).where(eq(modelsTable.id, retired.id)).get()
    expect(ghost).toBeUndefined()
  })

  test('sync-timeout + populated table + no stored version → skip mutations to avoid regressing marker', async () => {
    const db = getDb()

    // Simulate a second device whose initial sync didn't complete: rows for
    // some models are already present (partial sync), but the version marker
    // hasn't been delivered yet. Acting on this partial view would let us
    // downgrade or resurrect rows and regress the stored version once cloud
    // finally delivers it.
    const alive = defaultModels[0]
    const newerContent = { ...alive, name: 'Newer from cloud' }
    await db.insert(modelsTable).values({ ...newerContent, defaultHash: hashModel(newerContent) })

    await reconcileDefaults(db, { initialSyncCompleted: false })

    // The newer-content row must survive intact.
    const preserved = await db.select().from(modelsTable).where(eq(modelsTable.id, alive.id)).get()
    expect(preserved?.name).toBe('Newer from cloud')

    // And the version marker must not be written — that would poison the next
    // boot's gate calculation.
    expect(await readStoredModelsVersion()).toBeNull()
  })

  test('sync-timeout + empty table → still seeds bundle (first-ever install)', async () => {
    // Otherwise a fresh install offline (network flaky, first launch) would
    // boot with zero models.
    const db = getDb()
    await reconcileDefaults(db, { initialSyncCompleted: false })

    const models = await db.select().from(modelsTable)
    expect(models.length).toBe(defaultModels.length)
    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion)
  })

  test('marker does not advance when reconcile is a pure no-op (all rows user-edited)', async () => {
    const db = getDb()

    // Seed at the current bundle so all rows have their bundle's defaultHash.
    await reconcileDefaults(db)

    // User edits every model row so no update can proceed on the next pass.
    // Also rewind the marker to look like we're catching up from an older
    // stored version — this opens the gate (rawCanOverwrite=true) but the
    // pass will still be a total no-op because every row is now user-edited.
    for (const model of defaultModels) {
      await db
        .update(modelsTable)
        .set({ name: `user-edited ${model.id}` })
        .where(eq(modelsTable.id, model.id))
    }
    await db
      .update(settingsTable)
      .set({ value: String(defaultModelsVersion - 1) })
      .where(eq(settingsTable.key, modelsVersionKey))

    await reconcileDefaults(db)

    // Marker must stay at the rewound value — advancing it here would signal
    // to peers that this version was applied when in fact nothing was written.
    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion - 1)
  })

  test('sync-incomplete + populated table + stale stored version → skip mutations', async () => {
    const db = getDb()

    // Populate a row with newer-authored content and a stale marker below the
    // bundle. Before the sync-outcome guard was broadened, this scenario let
    // rawCanOverwrite (bundle > stale-stored) reopen the gate and downgrade
    // rows that cloud may have already advanced past.
    const alive = defaultModels[0]
    const newerContent = { ...alive, name: 'Newer from cloud' }
    await db.insert(modelsTable).values({ ...newerContent, defaultHash: hashModel(newerContent) })
    await db.insert(settingsTable).values({
      key: modelsVersionKey,
      value: String(defaultModelsVersion - 1),
    })

    await reconcileDefaults(db, { initialSyncCompleted: false })

    const preserved = await db.select().from(modelsTable).where(eq(modelsTable.id, alive.id)).get()
    expect(preserved?.name).toBe('Newer from cloud')
    expect(await readStoredModelsVersion()).toBe(defaultModelsVersion - 1)
  })

  test('missing profile is inserted even when canOverwriteModels is false (model↔profile 1:1)', async () => {
    const db = getDb()

    // Model row exists locally (from sync, say). Profile row hasn't arrived
    // yet. Stored marker is newer than our bundle, so canOverwriteModels=false.
    // Under strict gating the profile insert would be skipped and the model
    // would boot without its default profile — a runtime hazard. `insertMissing`
    // on the profiles call restores the 1:1 invariant.
    const model = defaultModels[0]
    await db.insert(modelsTable).values({ ...model, defaultHash: hashModel(model) })
    await db.insert(settingsTable).values({
      key: modelsVersionKey,
      value: String(defaultModelsVersion + 1),
    })

    await reconcileDefaults(db)

    const profile = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, model.id)).get()
    expect(profile).toBeDefined()
    expect(profile?.deletedAt).toBeNull()
  })

  test('older bundle does not overwrite profiles authored by a newer version', async () => {
    const db = getDb()

    // Seed at the current bundle so profiles get their defaultHash.
    await reconcileDefaults(db)

    // Simulate a newer-version device having tweaked a profile field
    // (temperature) — content matches its authoring hash, so it looks
    // "unedited from the newer bundle's perspective".
    const profileModelId = defaultModels[0].id
    const original = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, profileModelId))
      .get()
    expect(original).toBeDefined()
    const newer = { ...original!, temperature: 0.77 }
    await db
      .update(modelProfilesTable)
      .set({ temperature: 0.77, defaultHash: hashModelProfile(newer) })
      .where(eq(modelProfilesTable.modelId, profileModelId))

    // Rewind stored models version so canOverwriteModels goes false on next pass.
    await db
      .update(settingsTable)
      .set({ value: String(defaultModelsVersion + 1) })
      .where(eq(settingsTable.key, modelsVersionKey))

    await reconcileDefaults(db)

    const preserved = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, profileModelId))
      .get()
    expect(preserved?.temperature).toBe(0.77)
  })

  test('older-bundle-but-fully-synced device resurrects a pre-THU-637 cleanup soft-delete', async () => {
    const db = getDb()

    // Set up the cross-branch race scenario: a pre-THU-637 client soft-
    // deleted a shipped model (cleanup shape — only deletedAt set, content +
    // defaultHash preserved). This device has bundle=V2 but stored=V2 already
    // (marker synced from another combined-PR device), so canOverwrite is
    // closed. initialSyncCompleted defaults to true — sync is settled.
    // Resurrect must still fire so the account recovers.
    const shipped = defaultModels[0]
    await db.insert(modelsTable).values({
      ...shipped,
      deletedAt: '2026-01-01T00:00:00.000Z',
      defaultHash: hashModel(shipped),
    })
    await db.insert(settingsTable).values({
      key: modelsVersionKey,
      value: String(defaultModelsVersion),
    })

    await reconcileDefaults(db)

    const revived = await db.select().from(modelsTable).where(eq(modelsTable.id, shipped.id)).get()
    expect(revived?.deletedAt).toBeNull()
  })

  test('sync-incomplete does not resurrect (may race an authoritative deletion)', async () => {
    const db = getDb()

    // Same cleanup-shaped row, but sync didn't complete this boot. The soft-
    // delete could be a partial-sync artefact of a genuine retirement; acting
    // on our incomplete view risks undoing a legitimate cleanup. Skip and
    // retry on a settled boot.
    const shipped = defaultModels[0]
    await db.insert(modelsTable).values({
      ...shipped,
      deletedAt: '2026-01-01T00:00:00.000Z',
      defaultHash: hashModel(shipped),
    })

    await reconcileDefaults(db, { initialSyncCompleted: false })

    const stillGone = await db.select().from(modelsTable).where(eq(modelsTable.id, shipped.id)).get()
    expect(stillGone?.deletedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('sync-incomplete does not soft-delete orphaned profiles (partial-view protection)', async () => {
    const db = getDb()

    // Simulate a partial sync: the parent model looks locally missing (never
    // arrived, or its delete propagated first) while an alive profile row
    // pointing at it sits in local state. Under normal (sync-complete) flow
    // the profile-cleanup loop would soft-delete this orphan; under sync-
    // incomplete the parent may still be alive on cloud and we must stay
    // non-mutating for the profiles table.
    const stubProfile = defaultModelProfiles[0]
    const orphanModelId = 'orphan-parent-id'
    await db.insert(modelProfilesTable).values({
      ...stubProfile,
      modelId: orphanModelId,
      defaultHash: hashModelProfile({ ...stubProfile, modelId: orphanModelId }),
    })

    await reconcileDefaults(db, { initialSyncCompleted: false })

    const profile = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, orphanModelId))
      .get()
    expect(profile?.deletedAt).toBeNull()
  })

  test('OTA that retires a bundle-known model does not strand its profile (fresh device)', async () => {
    const db = getDb()

    // Server retires the first bundle model by omitting it from `data`. On a
    // fresh device the models pass never inserts it; the profiles pass must
    // NOT hit `insertMissing` for its profile — otherwise we'd have a profile
    // row pointing at a model that doesn't exist locally.
    const [retired, ...remaining] = defaultModels
    const otaSource: ModelsDefaults = {
      version: defaultModelsVersion + 1,
      data: [...remaining],
    }

    await reconcileDefaults(db, { models: otaSource })

    const ghostModel = await db.select().from(modelsTable).where(eq(modelsTable.id, retired.id)).get()
    expect(ghostModel).toBeUndefined()
    const ghostProfile = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, retired.id))
      .get()
    expect(ghostProfile).toBeUndefined()
  })

  test('OTA that retires a bundle-known model does not resurrect its cleanup-soft-deleted profile', async () => {
    const db = getDb()

    // Prime with the current bundle so both model and profile carry their
    // authoring hashes.
    await reconcileDefaults(db)

    // Server ships a higher version that drops the first model.
    // `cleanupRemovedDefaults` will soft-delete both the model and its profile
    // (their content still matches authoring hashes). The profiles pass then
    // runs — with the pre-fix logic it would enter the resurrect branch on
    // the profile (hash match, canResurrect open) and un-delete an orphan.
    const [retired, ...remaining] = defaultModels
    const otaSource: ModelsDefaults = {
      version: defaultModelsVersion + 1,
      data: [...remaining],
    }

    await reconcileDefaults(db, { models: otaSource })

    const modelRow = await db.select().from(modelsTable).where(eq(modelsTable.id, retired.id)).get()
    expect(modelRow?.deletedAt).not.toBeNull()
    const profileRow = await db
      .select()
      .from(modelProfilesTable)
      .where(eq(modelProfilesTable.modelId, retired.id))
      .get()
    expect(profileRow?.deletedAt).not.toBeNull()
  })

  test('OTA cannot flip isConfidential or provider on a bundle-known id (frozen fields)', async () => {
    const db = getDb()

    // Seed at the current bundle so all rows have their authoring hash.
    await reconcileDefaults(db)

    // Server ships a higher-version payload that flips `isConfidential` and
    // `provider` on an existing bundle-known id, plus a legitimate change to
    // `name` and `description`. Frozen fields must survive; unfrozen ones must
    // still update.
    const target = defaultModels[0]
    const flipped: SharedModel = {
      ...target,
      name: 'Renamed Via OTA',
      description: 'renamed description',
      isConfidential: target.isConfidential === 1 ? 0 : 1,
      provider: target.provider === 'thunderbolt' ? 'openai' : 'thunderbolt',
    }
    const otaSource: ModelsDefaults = {
      version: defaultModelsVersion + 1,
      data: [flipped, ...defaultModels.slice(1)],
    }

    await reconcileDefaults(db, { models: otaSource })

    const row = await db.select().from(modelsTable).where(eq(modelsTable.id, target.id)).get()
    // Frozen fields keep the original values...
    expect(row?.isConfidential).toBe(target.isConfidential)
    expect(row?.provider).toBe(target.provider)
    // ...while unfrozen fields adopt the OTA payload.
    expect(row?.name).toBe('Renamed Via OTA')
    expect(row?.description).toBe('renamed description')

    // The stored hash must match a hash of the effective (post-freeze) row, or
    // the next reconcile would treat this row as user-edited and never update.
    const effectiveExpected = { ...flipped, isConfidential: target.isConfidential, provider: target.provider }
    expect(row?.defaultHash).toBe(hashModel(effectiveExpected))

    // A follow-up reconcile with the same payload is a no-op on this row.
    await reconcileDefaults(db, { models: otaSource })
    const rowAgain = await db.select().from(modelsTable).where(eq(modelsTable.id, target.id)).get()
    expect(rowAgain?.name).toBe('Renamed Via OTA')
    expect(rowAgain?.defaultHash).toBe(hashModel(effectiveExpected))
  })

  test('OTA models without a bundled profile are dropped and do not advance the marker', async () => {
    const db = getDb()

    // Simulate an OTA payload that includes a model whose id this client's
    // bundle has no profile for (a genuine "new model" scenario the OTA
    // channel can express but this bundle can't fully render because profiles
    // aren't part of `/config`). The dropped id must not be inserted, and
    // the marker must not advance to the OTA version — otherwise a later
    // client with the fuller bundle would see `stored=OTA.version` and its
    // canOverwrite would be closed, permanently blocking the missing insert.
    const unknownId = '019fa11c-0000-7000-b000-abcdefabcdef'
    const otaSource: ModelsDefaults = {
      version: defaultModelsVersion + 1,
      data: [
        ...defaultModels,
        {
          id: unknownId,
          name: 'Server-only Future Model',
          provider: 'thunderbolt',
          model: 'future-model',
          isSystem: 1,
          enabled: 1,
          isConfidential: 0,
          contextWindow: 100_000,
          toolUsage: 1,
          startWithReasoning: 0,
          supportsParallelToolCalls: 0,
          deletedAt: null,
          url: null,
          defaultHash: null,
          vendor: null,
          description: null,
          userId: null,
        },
      ],
    }

    await reconcileDefaults(db, { models: otaSource })

    const ghost = await db.select().from(modelsTable).where(eq(modelsTable.id, unknownId)).get()
    expect(ghost).toBeUndefined()

    // Bundle-known models still applied.
    for (const known of defaultModels) {
      const row = await db.select().from(modelsTable).where(eq(modelsTable.id, known.id)).get()
      expect(row).toBeDefined()
    }

    // Marker did not advance to OTA version — no client is fully at that
    // version yet, so peers with the fuller bundle should still be able to
    // reach open canOverwrite on their next boot.
    expect(await readStoredModelsVersion()).not.toBe(defaultModelsVersion + 1)
  })
})
