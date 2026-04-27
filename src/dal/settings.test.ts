/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
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
  getSettingsRecords,
  getThemeSetting,
  hasSetting,
  resetSettingToDefault,
  updateSettings,
} from './settings'
import { hashValues } from '../lib/utils'
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
      const exists = await hasSetting(getDb(), 'nonexistent_key')
      expect(exists).toBe(false)
    })

    it('should return true when setting exists', async () => {
      await createSetting(getDb(), 'test_key', 'test_value')
      const exists = await hasSetting(getDb(), 'test_key')
      expect(exists).toBe(true)
    })

    it('should return true even if setting value is null', async () => {
      await createSetting(getDb(), 'null_key', null)
      const exists = await hasSetting(getDb(), 'null_key')
      expect(exists).toBe(true)
    })
  })

  describe('getSettings', () => {
    it('should return null when setting does not exist and no default provided', async () => {
      const settings = await getSettings(getDb(), { nonexistent_key: String })
      expect(settings.nonexistentKey).toBe(null)
    })

    it('should return default value when setting does not exist', async () => {
      const settings = await getSettings(getDb(), { nonexistent_key: 'default_value' })
      expect(settings.nonexistentKey).toBe('default_value')
    })

    it('should return stored value when setting exists', async () => {
      await createSetting(getDb(), 'test_key', 'stored_value')
      const settings = await getSettings(getDb(), { test_key: String })
      expect(settings.testKey).toBe('stored_value')
    })

    it('should return empty string instead of default when empty string is stored', async () => {
      await createSetting(getDb(), 'empty_key', '')
      const settings = await getSettings(getDb(), { empty_key: 'default' })
      expect(settings.emptyKey).toBe('')
    })

    it('should return stored value "0" instead of default', async () => {
      await createSetting(getDb(), 'zero_key', '0')
      const settings = await getSettings(getDb(), { zero_key: 'default' })
      expect(settings.zeroKey).toBe('0')
    })

    it('should return stored value "false" instead of default', async () => {
      await createSetting(getDb(), 'false_key', 'false')
      const settings = await getSettings(getDb(), { false_key: 'default' })
      expect(settings.falseKey).toBe('false')
    })

    it('should return default when value is null', async () => {
      await createSetting(getDb(), 'null_key', null)
      const settings = await getSettings(getDb(), { null_key: 'default' })
      expect(settings.nullKey).toBe('default')
    })
  })

  describe('createSetting', () => {
    it('should create a new setting', async () => {
      await createSetting(getDb(), 'new_key', 'new_value')
      const settings = await getSettings(getDb(), { new_key: String })
      expect(settings.newKey).toBe('new_value')
    })

    it('should not overwrite existing setting (onConflictDoNothing)', async () => {
      await createSetting(getDb(), 'existing_key', 'original_value')
      await createSetting(getDb(), 'existing_key', 'new_value')
      const settings = await getSettings(getDb(), { existing_key: String })
      expect(settings.existingKey).toBe('original_value')
    })

    it('should create setting with null value', async () => {
      await createSetting(getDb(), 'null_key', null)
      const exists = await hasSetting(getDb(), 'null_key')
      expect(exists).toBe(true)
      const settings = await getSettings(getDb(), { null_key: 'default' })
      expect(settings.nullKey).toBe('default')
    })
  })

  describe('updateSettings', () => {
    it('should create multiple new settings at once', async () => {
      await updateSettings(getDb(), {
        batch_key_one: 'value1',
        batch_key_two: 'value2',
        batch_key_three: 'value3',
      })

      const settings = await getSettings(getDb(), {
        batch_key_one: String,
        batch_key_two: String,
        batch_key_three: String,
      })

      expect(settings.batchKeyOne).toBe('value1')
      expect(settings.batchKeyTwo).toBe('value2')
      expect(settings.batchKeyThree).toBe('value3')
    })

    it('should update multiple existing settings at once', async () => {
      await createSetting(getDb(), 'existing_one', 'old1')
      await createSetting(getDb(), 'existing_two', 'old2')

      await updateSettings(getDb(), {
        existing_one: 'new1',
        existing_two: 'new2',
      })

      const settings = await getSettings(getDb(), {
        existing_one: String,
        existing_two: String,
      })

      expect(settings.existingOne).toBe('new1')
      expect(settings.existingTwo).toBe('new2')
    })

    it('should handle mixed types (string, number, boolean)', async () => {
      await updateSettings(getDb(), {
        mixed_string: 'text',
        mixed_number: 42,
        mixed_boolean: true,
      })

      const settings = await getSettings(getDb(), {
        mixed_string: String,
        mixed_number: Number,
        mixed_boolean: Boolean,
      })

      expect(settings.mixedString).toBe('text')
      expect(settings.mixedNumber).toBe(42)
      expect(settings.mixedBoolean).toBe(true)
    })

    it('should handle empty object gracefully', async () => {
      await updateSettings(getDb(), {})
      expect(true).toBe(true)
    })

    it('should support recomputeHash option for all settings', async () => {
      await updateSettings(
        getDb(),
        {
          hash_key_one: 'baseline1',
          hash_key_two: 'baseline2',
        },
        { recomputeHash: true },
      )

      const records = await getSettingsRecords(getDb(), ['hash_key_one', 'hash_key_two'])

      const expectedHash1 = hashValues(['hash_key_one', 'baseline1'])
      const expectedHash2 = hashValues(['hash_key_two', 'baseline2'])

      const record1 = records.find((r) => r.key === 'hash_key_one')
      const record2 = records.find((r) => r.key === 'hash_key_two')

      expect(record1?.defaultHash).toBe(expectedHash1)
      expect(record2?.defaultHash).toBe(expectedHash2)
    })

    it('should fall back to update when key already exists (insert-first pattern for PowerSync)', async () => {
      const db = getDb()

      // Insert row directly to simulate race: another caller already created it
      await db.insert(settingsTable).values({
        key: 'race_key',
        value: 'original',
        updatedAt: null,
        defaultHash: null,
        userId: null,
      })

      // updateSettings tries insert first, gets UNIQUE constraint, falls back to update
      await updateSettings(getDb(), { race_key: 'updated_via_fallback' })

      const settings = await getSettings(getDb(), { race_key: String })
      expect(settings.raceKey).toBe('updated_via_fallback')
    })

    it('should handle deeply nested JSON structures', async () => {
      // Test that the JsonValue type properly accepts complex nested structures
      const complexCredentials = {
        access_token: 'token123',
        refresh_token: 'refresh456',
        expires_at: 1234567890,
        profile: {
          email: 'user@example.com',
          name: 'Test User',
          metadata: {
            created: '2024-01-01',
            tags: ['premium', 'verified'],
            settings: {
              theme: 'dark',
              notifications: true,
            },
          },
        },
      }

      await updateSettings(getDb(), {
        complex_nested_data: complexCredentials,
        simple_array: [1, 2, 3, 4, 5],
        nested_array: [
          { id: 1, value: 'a' },
          { id: 2, value: 'b' },
        ],
      })

      // Verify it was stored correctly by reading back
      const settings = await getSettings(getDb(), {
        complex_nested_data: String, // Gets back as JSON string
        simple_array: String,
        nested_array: String,
      })

      expect(JSON.parse(settings.complexNestedData!)).toEqual(complexCredentials)
      expect(JSON.parse(settings.simpleArray!)).toEqual([1, 2, 3, 4, 5])
      expect(JSON.parse(settings.nestedArray!)).toEqual([
        { id: 1, value: 'a' },
        { id: 2, value: 'b' },
      ])
    })
  })

  describe('updateSettings with recomputeHash option', () => {
    it('should not update defaultHash by default', async () => {
      const db = getDb()

      // Create a setting with a defaultHash
      await db.insert(settingsTable).values({
        key: 'test_key',
        value: 'original',
        updatedAt: null,
        defaultHash: hashSetting({
          key: 'test_key',
          value: 'original',
          updatedAt: null,
          defaultHash: null,
          userId: null,
        }),
      })

      // Update the value without recomputeHash
      await updateSettings(getDb(), { test_key: 'modified' })

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()

      // Value should be updated but hash should remain the same (pointing to original)
      expect(setting?.value).toBe('modified')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'original', updatedAt: null, defaultHash: null, userId: null }),
      )
      expect(isSettingModified(setting!)).toBe(true)
    })

    it('should update defaultHash when recomputeHash is true', async () => {
      const db = getDb()

      // Create a setting with a defaultHash
      await db.insert(settingsTable).values({
        key: 'test_key',
        value: 'original',
        updatedAt: null,
        defaultHash: hashSetting({
          key: 'test_key',
          value: 'original',
          updatedAt: null,
          defaultHash: null,
          userId: null,
        }),
      })

      // Update the value with recomputeHash: true
      await updateSettings(getDb(), { test_key: 'new_baseline' }, { recomputeHash: true })

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()

      // Value should be updated and hash should point to the new value
      expect(setting?.value).toBe('new_baseline')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'new_baseline', updatedAt: null, defaultHash: null, userId: null }),
      )
      expect(isSettingModified(setting!)).toBe(false)
    })

    it('should detect modifications after recomputing hash', async () => {
      const db = getDb()

      // Create a setting
      await updateSettings(getDb(), { test_key: 'baseline' }, { recomputeHash: true })

      // Verify it's not modified
      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(isSettingModified(setting!)).toBe(false)

      // Now modify it again without recomputeHash
      await updateSettings(getDb(), { test_key: 'different_value' })

      // Should be detected as modified relative to the new baseline
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('different_value')
      expect(isSettingModified(setting!)).toBe(true)
    })

    it('should work with location-based localization scenario', async () => {
      const db = getDb()

      // Simulate initial auto-population from country data with recomputeHash
      await updateSettings(getDb(), { distance_unit: 'metric', temperature_unit: 'c' }, { recomputeHash: true })

      // Verify they're not marked as modified
      const distanceSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceSetting!)).toBe(false)
      expect(isSettingModified(tempSetting!)).toBe(false)

      // User manually changes one setting
      await updateSettings(getDb(), { temperature_unit: 'f' })

      // Only the manually changed setting should be modified
      const distanceAfter = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempAfter = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceAfter!)).toBe(false)
      expect(isSettingModified(tempAfter!)).toBe(true)

      // User changes location, triggering new localization values with recomputeHash
      await updateSettings(getDb(), { distance_unit: 'imperial', temperature_unit: 'f' }, { recomputeHash: true })

      // Both should now be unmodified relative to the new baseline
      const distanceFinal = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      const tempFinal = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()

      expect(isSettingModified(distanceFinal!)).toBe(false)
      expect(isSettingModified(tempFinal!)).toBe(false)
    })
  })

  describe('updateSettings with updateHashOnly option', () => {
    it('should only update hash without changing value', async () => {
      const db = getDb()

      // Create a setting with an initial value
      await updateSettings(getDb(), { test_key: 'user_custom_value' }, { recomputeHash: true })

      // Verify initial state
      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('user_custom_value')
      expect(isSettingModified(setting!)).toBe(false)

      // Update only the hash to a new baseline value without changing the actual value
      await updateSettings(getDb(), { test_key: 'new_baseline' }, { updateHashOnly: true })

      // Value should remain unchanged, but hash should be updated
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_key')).get()
      expect(setting?.value).toBe('user_custom_value')
      expect(setting?.defaultHash).toBe(
        hashSetting({ key: 'test_key', value: 'new_baseline', updatedAt: null, defaultHash: null, userId: null }),
      )
      expect(isSettingModified(setting!)).toBe(true) // Still modified since value differs from new baseline
    })

    it('should preserve user customization when updating baseline', async () => {
      const db = getDb()

      // Scenario: User has location set to UK, gets 'metric' units
      await updateSettings(getDb(), { distance_unit: 'metric' }, { recomputeHash: true })

      // User manually changes to imperial
      await updateSettings(getDb(), { distance_unit: 'imperial' })

      let setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      expect(setting?.value).toBe('imperial')
      expect(isSettingModified(setting!)).toBe(true)

      // User changes location to US, which defaults to 'imperial'
      // We update the hash to 'imperial' without changing the value
      await updateSettings(getDb(), { distance_unit: 'imperial' }, { updateHashOnly: true })

      // Value stays 'imperial' (user's choice), but now it's the baseline
      setting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      expect(setting?.value).toBe('imperial')
      expect(isSettingModified(setting!)).toBe(false) // No longer modified since value matches new baseline
    })

    it('should work in location change scenario with mixed modified/unmodified settings', async () => {
      const db = getDb()

      // Initial location (UK): metric and c
      await updateSettings(getDb(), { distance_unit: 'metric', temperature_unit: 'c' }, { recomputeHash: true })

      // User manually changes temperature to f
      await updateSettings(getDb(), { temperature_unit: 'f' })

      // Verify state before location change
      let distanceSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'distance_unit')).get()
      let tempSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'temperature_unit')).get()
      expect(isSettingModified(distanceSetting!)).toBe(false)
      expect(isSettingModified(tempSetting!)).toBe(true)

      // User changes location to US: imperial and f
      // For unmodified settings, update value and hash
      await updateSettings(getDb(), { distance_unit: 'imperial' }, { recomputeHash: true })
      // For modified settings, only update hash (preserve user's value)
      await updateSettings(getDb(), { temperature_unit: 'f' }, { updateHashOnly: true })

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
      await createSetting(getDb(), 'delete_key', 'value')
      expect(await hasSetting(getDb(), 'delete_key')).toBe(true)

      await deleteSetting(getDb(), 'delete_key')
      expect(await hasSetting(getDb(), 'delete_key')).toBe(false)
    })

    it('should not throw when deleting non-existent setting', async () => {
      await expect(deleteSetting(getDb(), 'nonexistent_key')).resolves.toBeUndefined()
    })

    it('should make setting fall back to default after deletion', async () => {
      await createSetting(getDb(), 'fallback_key', 'custom_value')
      const beforeDelete = await getSettings(getDb(), { fallback_key: 'default' })
      expect(beforeDelete.fallbackKey).toBe('custom_value')

      await deleteSetting(getDb(), 'fallback_key')
      const afterDelete = await getSettings(getDb(), { fallback_key: 'default' })
      expect(afterDelete.fallbackKey).toBe('default')
    })
  })

  describe('getAllSettings', () => {
    it('should return empty array when no settings exist', async () => {
      const settings = await getAllSettings(getDb())
      expect(settings).toEqual([])
    })

    it('should return all settings', async () => {
      await createSetting(getDb(), 'key1', 'value1')
      await createSetting(getDb(), 'key2', 'value2')
      await createSetting(getDb(), 'key3', 'value3')

      const settings = await getAllSettings(getDb())
      expect(settings).toHaveLength(3)
      expect(settings.map((s) => s.key)).toContain('key1')
      expect(settings.map((s) => s.key)).toContain('key2')
      expect(settings.map((s) => s.key)).toContain('key3')
    })
  })

  describe('getThemeSetting', () => {
    it('should return default theme when setting does not exist', async () => {
      const theme = await getThemeSetting(getDb(), 'theme', 'light')
      expect(theme).toBe('light')
    })

    it('should return stored theme when setting exists', async () => {
      await updateSettings(getDb(), { theme: 'dark' })
      const theme = await getThemeSetting(getDb(), 'theme', 'light')
      expect(theme).toBe('dark')
    })
  })

  describe('resetSettingToDefault', () => {
    it('resets modified setting to default state', async () => {
      const db = getDb()
      const defaultSetting = defaultSettings[0]

      // Insert a setting with the default value
      await db.insert(settingsTable).values({
        key: defaultSetting.key,
        value: defaultSetting.value,
        updatedAt: null,
        defaultHash: hashSetting(defaultSetting),
      })

      // User modifies it
      await updateSettings(getDb(), { [defaultSetting.key]: 'user_modified_value' })

      // Verify it's modified
      const modified = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
      expect(modified?.value).toBe('user_modified_value')
      expect(isSettingModified(modified!)).toBe(true)

      // Reset to default
      await resetSettingToDefault(getDb(), defaultSetting.key, defaultSetting)

      // Verify it's back to default
      const reset = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()
      expect(reset?.value).toBe(defaultSetting.value)
      expect(isSettingModified(reset!)).toBe(false)
    })

    it('after reset, modification detection works correctly', async () => {
      const db = getDb()
      const defaultSetting = defaultSettings[0]

      // Insert and modify
      await db.insert(settingsTable).values({
        key: defaultSetting.key,
        value: defaultSetting.value,
        updatedAt: null,
        defaultHash: hashSetting(defaultSetting),
      })
      await updateSettings(getDb(), { [defaultSetting.key]: 'modified' })

      // Reset
      await resetSettingToDefault(getDb(), defaultSetting.key, defaultSetting)

      const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()

      // Should be detected as unmodified
      expect(isSettingModified(setting!)).toBe(false)

      // Modify again
      await updateSettings(getDb(), { [defaultSetting.key]: 'modified_again' })
      const modifiedAgain = await db.select().from(settingsTable).where(eq(settingsTable.key, defaultSetting.key)).get()

      // Should be detected as modified
      expect(isSettingModified(modifiedAgain!)).toBe(true)
    })
  })
})
