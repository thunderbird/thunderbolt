import { DatabaseSingleton } from '@/db/singleton'
import { settingsTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { isSettingModified } from '../defaults/utils'
import {
  createSetting,
  deleteSetting,
  getAllSettings,
  getSettings,
  getThemeSetting,
  hasSetting,
  resetSettingToDefault,
  updateSetting,
} from './settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  // Reset database before each test to prevent pollution from randomized test order
  await resetTestDatabase()
})

describe('Settings DAL', () => {
  describe('hasSetting', () => {
    it('should return false when setting does not exist', async () => {
      const exists = await hasSetting('nonexistent_key')
      expect(exists).toBe(false)
    })

    it('should return true when setting exists', async () => {
      await createSetting('test_key', 'test_value')
      const exists = await hasSetting('test_key')
      expect(exists).toBe(true)
    })

    it('should return true even if setting value is null', async () => {
      await createSetting('null_key', null)
      const exists = await hasSetting('null_key')
      expect(exists).toBe(true)
    })
  })

  describe('getSettings', () => {
    it('should return null when setting does not exist and no default provided', async () => {
      const settings = await getSettings({ nonexistent_key: String })
      expect(settings.nonexistentKey).toBe(null)
    })

    it('should return default value when setting does not exist', async () => {
      const settings = await getSettings({ nonexistent_key: 'default_value' })
      expect(settings.nonexistentKey).toBe('default_value')
    })

    it('should return stored value when setting exists', async () => {
      await createSetting('test_key', 'stored_value')
      const settings = await getSettings({ test_key: String })
      expect(settings.testKey).toBe('stored_value')
    })

    it('should return empty string instead of default when empty string is stored', async () => {
      await createSetting('empty_key', '')
      const settings = await getSettings({ empty_key: 'default' })
      expect(settings.emptyKey).toBe('')
    })

    it('should return stored value "0" instead of default', async () => {
      await createSetting('zero_key', '0')
      const settings = await getSettings({ zero_key: 'default' })
      expect(settings.zeroKey).toBe('0')
    })

    it('should return stored value "false" instead of default', async () => {
      await createSetting('false_key', 'false')
      const settings = await getSettings({ false_key: 'default' })
      expect(settings.falseKey).toBe('false')
    })

    it('should return default when value is null', async () => {
      await createSetting('null_key', null)
      const settings = await getSettings({ null_key: 'default' })
      expect(settings.nullKey).toBe('default')
    })
  })

  describe('createSetting', () => {
    it('should create a new setting', async () => {
      await createSetting('new_key', 'new_value')
      const settings = await getSettings({ new_key: String })
      expect(settings.newKey).toBe('new_value')
    })

    it('should not overwrite existing setting (onConflictDoNothing)', async () => {
      await createSetting('existing_key', 'original_value')
      await createSetting('existing_key', 'new_value')
      const settings = await getSettings({ existing_key: String })
      expect(settings.existingKey).toBe('original_value')
    })

    it('should create setting with null value', async () => {
      await createSetting('null_key', null)
      const exists = await hasSetting('null_key')
      expect(exists).toBe(true)
      const settings = await getSettings({ null_key: 'default' })
      expect(settings.nullKey).toBe('default')
    })
  })

  describe('updateSetting', () => {
    it('should create a new setting if it does not exist', async () => {
      await updateSetting('new_key', 'new_value')
      const settings = await getSettings({ new_key: String })
      expect(settings.newKey).toBe('new_value')
    })

    it('should update existing setting', async () => {
      await createSetting('update_key', 'old_value')
      await updateSetting('update_key', 'new_value')
      const settings = await getSettings({ update_key: String })
      expect(settings.updateKey).toBe('new_value')
    })

    it('should update to null value', async () => {
      await createSetting('nullable_key', 'original_value')
      await updateSetting('nullable_key', null)
      const settings = await getSettings({ nullable_key: 'default' })
      expect(settings.nullableKey).toBe('default')
    })

    it('should update to empty string', async () => {
      await createSetting('empty_key', 'original_value')
      await updateSetting('empty_key', '')
      const settings = await getSettings({ empty_key: 'default' })
      expect(settings.emptyKey).toBe('')
    })
  })

  describe('updateSetting with boolean values', () => {
    it('should create a boolean setting with true value', async () => {
      await updateSetting('bool_key', true)
      const settings = await getSettings({ bool_key: false })
      expect(settings.boolKey).toBe(true)
    })

    it('should create a boolean setting with false value', async () => {
      await updateSetting('bool_key', false)
      const settings = await getSettings({ bool_key: true })
      expect(settings.boolKey).toBe(false)
    })

    it('should update existing boolean setting', async () => {
      await updateSetting('bool_key', false)
      await updateSetting('bool_key', true)
      const settings = await getSettings({ bool_key: false })
      expect(settings.boolKey).toBe(true)
    })

    it('should store as "true" and "false" strings', async () => {
      await updateSetting('bool_key', true)
      const trueSettings = await getSettings({ bool_key: String })
      expect(trueSettings.boolKey).toBe('true')

      await updateSetting('bool_key', false)
      const falseSettings = await getSettings({ bool_key: String })
      expect(falseSettings.boolKey).toBe('false')
    })
  })

  describe('updateSetting with recomputeHash option', () => {
    it('should not update defaultHash by default', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a setting with a defaultHash
      await db.insert(settingsTable).values({
        key: 'test_key',
        value: 'original',
        updatedAt: null,
        defaultHash: hashSetting({ key: 'test_key', value: 'original', updatedAt: null, defaultHash: null }),
      })

      // Update the value without recomputeHash
      await updateSetting('test_key', 'modified')

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()

      // Value should be updated but hash should remain the same (pointing to original)
      expect(setting?.value).toBe('modified')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'original', updatedAt: null, defaultHash: null }),
      )
      expect(isSettingModified(setting!)).toBe(true)
    })

    it('should update defaultHash when recomputeHash is true', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a setting with a defaultHash
      await db.insert(settingsTable).values({
        key: 'test_key',
        value: 'original',
        updatedAt: null,
        defaultHash: hashSetting({ key: 'test_key', value: 'original', updatedAt: null, defaultHash: null }),
      })

      // Update the value with recomputeHash: true
      await updateSetting('test_key', 'new_baseline', { recomputeHash: true })

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()

      // Value should be updated and hash should point to the new value
      expect(setting?.value).toBe('new_baseline')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'new_baseline', updatedAt: null, defaultHash: null }),
      )
      expect(isSettingModified(setting!)).toBe(false)
    })

    it('should detect modifications after recomputing hash', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a setting
      await updateSetting('test_key', 'baseline', { recomputeHash: true })

      // Verify it's not modified
      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(isSettingModified(setting!)).toBe(false)

      // Now modify it again without recomputeHash
      await updateSetting('test_key', 'different_value')

      // Should be detected as modified relative to the new baseline
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('different_value')
      expect(isSettingModified(setting!)).toBe(true)
    })

    it('should work with location-based localization scenario', async () => {
      const db = DatabaseSingleton.instance.db

      // Simulate initial auto-population from country data with recomputeHash
      await updateSetting('distance_unit', 'metric', { recomputeHash: true })
      await updateSetting('temperature_unit', 'c', { recomputeHash: true })

      // Verify they're not marked as modified
      const distanceSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceSetting!)).toBe(false)
      expect(isSettingModified(tempSetting!)).toBe(false)

      // User manually changes one setting
      await updateSetting('temperature_unit', 'f')

      // Only the manually changed setting should be modified
      const distanceAfter = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempAfter = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceAfter!)).toBe(false)
      expect(isSettingModified(tempAfter!)).toBe(true)

      // User changes location, triggering new localization values with recomputeHash
      await updateSetting('distance_unit', 'imperial', { recomputeHash: true })
      await updateSetting('temperature_unit', 'f', { recomputeHash: true })

      // Both should now be unmodified relative to the new baseline
      const distanceFinal = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempFinal = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceFinal!)).toBe(false)
      expect(isSettingModified(tempFinal!)).toBe(false)
    })
  })

  describe('updateSetting with updateHashOnly option', () => {
    it('should only update hash without changing value', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a setting with an initial value
      await updateSetting('test_key', 'user_custom_value', { recomputeHash: true })

      // Verify initial state
      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('user_custom_value')
      expect(isSettingModified(setting!)).toBe(false)

      // Update only the hash to a new baseline value without changing the actual value
      await updateSetting('test_key', 'new_baseline', { updateHashOnly: true })

      // Value should remain unchanged, but hash should be updated
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('user_custom_value')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'new_baseline', updatedAt: null, defaultHash: null }),
      )
      expect(isSettingModified(setting!)).toBe(true) // Still modified since value differs from new baseline
    })

    it('should preserve user customization when updating baseline', async () => {
      const db = DatabaseSingleton.instance.db

      // Scenario: User has location set to UK, gets 'metric' units
      await updateSetting('distance_unit', 'metric', { recomputeHash: true })

      // User manually changes to imperial
      await updateSetting('distance_unit', 'imperial')

      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      expect(setting?.value).toBe('imperial')
      expect(isSettingModified(setting!)).toBe(true)

      // User changes location to US, which defaults to 'imperial'
      // We update the hash to 'imperial' without changing the value
      await updateSetting('distance_unit', 'imperial', { updateHashOnly: true })

      // Value stays 'imperial' (user's choice), but now it's the baseline
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      expect(setting?.value).toBe('imperial')
      expect(isSettingModified(setting!)).toBe(false) // No longer modified since value matches new baseline
    })

    it('should work in location change scenario with mixed modified/unmodified settings', async () => {
      const db = DatabaseSingleton.instance.db

      // Initial location (UK): metric and c
      await updateSetting('distance_unit', 'metric', { recomputeHash: true })
      await updateSetting('temperature_unit', 'c', { recomputeHash: true })

      // User manually changes temperature to f
      await updateSetting('temperature_unit', 'f')

      // Verify state before location change
      let distanceSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      let tempSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()
      expect(isSettingModified(distanceSetting!)).toBe(false)
      expect(isSettingModified(tempSetting!)).toBe(true)

      // User changes location to US: imperial and f
      // For unmodified settings, update value and hash
      await updateSetting('distance_unit', 'imperial', { recomputeHash: true })
      // For modified settings, only update hash (preserve user's value)
      await updateSetting('temperature_unit', 'f', { updateHashOnly: true })

      // Check final state
      distanceSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      tempSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(distanceSetting?.value).toBe('imperial') // Changed from metric to imperial
      expect(tempSetting?.value).toBe('f') // Stayed f (was already f)
      expect(isSettingModified(distanceSetting!)).toBe(false) // New baseline
      expect(isSettingModified(tempSetting!)).toBe(false) // Now matches baseline
    })
  })

  describe('deleteSetting', () => {
    it('should delete an existing setting', async () => {
      await createSetting('delete_key', 'value')
      expect(await hasSetting('delete_key')).toBe(true)

      await deleteSetting('delete_key')
      expect(await hasSetting('delete_key')).toBe(false)
    })

    it('should not throw when deleting non-existent setting', async () => {
      await expect(deleteSetting('nonexistent_key')).resolves.toBeUndefined()
    })

    it('should make setting fall back to default after deletion', async () => {
      await createSetting('fallback_key', 'custom_value')
      const beforeDelete = await getSettings({ fallback_key: 'default' })
      expect(beforeDelete.fallbackKey).toBe('custom_value')

      await deleteSetting('fallback_key')
      const afterDelete = await getSettings({ fallback_key: 'default' })
      expect(afterDelete.fallbackKey).toBe('default')
    })
  })

  describe('getAllSettings', () => {
    it('should return empty array when no settings exist', async () => {
      const settings = await getAllSettings()
      expect(settings).toEqual([])
    })

    it('should return all settings', async () => {
      await createSetting('key1', 'value1')
      await createSetting('key2', 'value2')
      await createSetting('key3', 'value3')

      const settings = await getAllSettings()
      expect(settings).toHaveLength(3)
      expect(settings.map((s) => s.key)).toContain('key1')
      expect(settings.map((s) => s.key)).toContain('key2')
      expect(settings.map((s) => s.key)).toContain('key3')
    })
  })

  describe('getThemeSetting', () => {
    it('should return default theme when setting does not exist', async () => {
      const theme = await getThemeSetting('theme', 'light')
      expect(theme).toBe('light')
    })

    it('should return stored theme when setting exists', async () => {
      await updateSetting('theme', 'dark')
      const theme = await getThemeSetting('theme', 'light')
      expect(theme).toBe('dark')
    })
  })

  describe('resetSettingToDefault', () => {
    it('resets modified setting to default state', async () => {
      const db = DatabaseSingleton.instance.db
      const defaultSetting = defaultSettings[0]

      // Insert a setting with the default value
      await db.insert(settingsTable).values({
        key: defaultSetting.key,
        value: defaultSetting.value,
        updatedAt: null,
        defaultHash: hashSetting(defaultSetting),
      })

      // User modifies it
      await updateSetting(defaultSetting.key, 'user_modified_value')

      // Verify it's modified
      const modified = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
      expect(modified?.value).toBe('user_modified_value')
      expect(isSettingModified(modified!)).toBe(true)

      // Reset to default
      await resetSettingToDefault(defaultSetting.key, defaultSetting)

      // Verify it's back to default
      const reset = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
      expect(reset?.value).toBe(defaultSetting.value)
      expect(isSettingModified(reset!)).toBe(false)
    })

    it('after reset, modification detection works correctly', async () => {
      const db = DatabaseSingleton.instance.db
      const defaultSetting = defaultSettings[0]

      // Insert and modify
      await db.insert(settingsTable).values({
        key: defaultSetting.key,
        value: defaultSetting.value,
        updatedAt: null,
        defaultHash: hashSetting(defaultSetting),
      })
      await updateSetting(defaultSetting.key, 'modified')

      // Reset
      await resetSettingToDefault(defaultSetting.key, defaultSetting)

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()

      // Should be detected as unmodified
      expect(isSettingModified(setting!)).toBe(false)

      // Modify again
      await updateSetting(defaultSetting.key, 'modified_again')
      const modifiedAgain = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()

      // Should be detected as modified
      expect(isSettingModified(modifiedAgain!)).toBe(true)
    })
  })
})
