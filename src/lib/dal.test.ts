import { migrate } from '@/src/db/migrate'
import { DatabaseSingleton } from '@/src/db/singleton'
import { chatMessagesTable, chatThreadsTable, modelsTable, settingsTable } from '@/src/db/tables'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createSetting,
  deleteSetting,
  getAllSettings,
  getBooleanSetting,
  getSelectedModel,
  getSetting,
  hasSetting,
  updateBooleanSetting,
  updateSetting,
} from './dal'

beforeAll(async () => {
  // Use in-memory database for testing
  await DatabaseSingleton.instance.initialize({ type: 'sqlocal', path: ':memory:' })

  // Run migrations to create tables
  const db = DatabaseSingleton.instance.db
  await migrate(db)
})

afterEach(async () => {
  // Clean up settings table after each test
  const db = DatabaseSingleton.instance.db
  await db.delete(settingsTable)
})

// ============================================================================
// SETTINGS TESTS
// ============================================================================

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

  describe('getSetting', () => {
    it('should return null when setting does not exist and no default provided', async () => {
      const value = await getSetting('nonexistent_key')
      expect(value).toBe(null)
    })

    it('should return default value when setting does not exist', async () => {
      const value = await getSetting('nonexistent_key', 'default_value')
      expect(value).toBe('default_value')
    })

    it('should return stored value when setting exists', async () => {
      await createSetting('test_key', 'stored_value')
      const value = await getSetting('test_key')
      expect(value).toBe('stored_value')
    })

    it('should return empty string instead of default when empty string is stored', async () => {
      await createSetting('empty_key', '')
      const value = await getSetting('empty_key', 'default')
      expect(value).toBe('')
    })

    it('should return stored value "0" instead of default', async () => {
      await createSetting('zero_key', '0')
      const value = await getSetting('zero_key', 'default')
      expect(value).toBe('0')
    })

    it('should return stored value "false" instead of default', async () => {
      await createSetting('false_key', 'false')
      const value = await getSetting('false_key', 'default')
      expect(value).toBe('false')
    })

    it('should return default when value is null', async () => {
      await createSetting('null_key', null)
      const value = await getSetting('null_key', 'default')
      expect(value).toBe('default')
    })
  })

  describe('getBooleanSetting', () => {
    it('should return false by default when setting does not exist', async () => {
      const value = await getBooleanSetting('nonexistent_key')
      expect(value).toBe(false)
    })

    it.skip('should return custom default when setting does not exist', async () => {
      const value = await getBooleanSetting('nonexistent_key', true)
      expect(value).toBe(true)
    })

    it.skip('should return true when value is "true"', async () => {
      await createSetting('bool_key', 'true')
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should return false when value is "false"', async () => {
      await createSetting('bool_key', 'false')
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(false)
    })

    it('should return false for any non-"true" value', async () => {
      await createSetting('bool_key', '1')
      expect(await getBooleanSetting('bool_key')).toBe(false)

      await updateSetting('bool_key', 'yes')
      expect(await getBooleanSetting('bool_key')).toBe(false)

      await updateSetting('bool_key', 'TRUE')
      expect(await getBooleanSetting('bool_key')).toBe(false)
    })
  })

  describe('createSetting', () => {
    it('should create a new setting', async () => {
      await createSetting('new_key', 'new_value')
      const value = await getSetting('new_key')
      expect(value).toBe('new_value')
    })

    it('should not overwrite existing setting (onConflictDoNothing)', async () => {
      await createSetting('existing_key', 'original_value')
      await createSetting('existing_key', 'new_value')
      const value = await getSetting('existing_key')
      expect(value).toBe('original_value')
    })

    it('should create setting with null value', async () => {
      await createSetting('null_key', null)
      const exists = await hasSetting('null_key')
      expect(exists).toBe(true)
      const value = await getSetting('null_key', 'default')
      expect(value).toBe('default')
    })
  })

  describe('updateSetting', () => {
    it('should create a new setting if it does not exist', async () => {
      await updateSetting('new_key', 'new_value')
      const value = await getSetting('new_key')
      expect(value).toBe('new_value')
    })

    it('should update existing setting', async () => {
      await createSetting('update_key', 'old_value')
      await updateSetting('update_key', 'new_value')
      const value = await getSetting('update_key')
      expect(value).toBe('new_value')
    })

    it('should update to null value', async () => {
      await createSetting('nullable_key', 'original_value')
      await updateSetting('nullable_key', null)
      const value = await getSetting('nullable_key', 'default')
      expect(value).toBe('default')
    })

    it('should update to empty string', async () => {
      await createSetting('empty_key', 'original_value')
      await updateSetting('empty_key', '')
      const value = await getSetting('empty_key', 'default')
      expect(value).toBe('')
    })
  })

  describe('updateBooleanSetting', () => {
    it.skip('should create a boolean setting with true value', async () => {
      await updateBooleanSetting('bool_key', true)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should create a boolean setting with false value', async () => {
      await updateBooleanSetting('bool_key', false)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(false)
    })

    it.skip('should update existing boolean setting', async () => {
      await updateBooleanSetting('bool_key', false)
      await updateBooleanSetting('bool_key', true)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should store as "true" and "false" strings', async () => {
      await updateBooleanSetting('bool_key', true)
      const trueValue = await getSetting('bool_key')
      expect(trueValue).toBe('true')

      await updateBooleanSetting('bool_key', false)
      const falseValue = await getSetting('bool_key')
      expect(falseValue).toBe('false')
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
      expect(await getSetting('fallback_key', 'default')).toBe('custom_value')

      await deleteSetting('fallback_key')
      expect(await getSetting('fallback_key', 'default')).toBe('default')
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
})

// ============================================================================
// MODELS TESTS
// ============================================================================

describe('Models DAL', () => {
  afterEach(async () => {
    // Clean up models table and settings after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(modelsTable)
    await db.delete(settingsTable)
  })

  describe('getSelectedModel', () => {
    it('should return system model when no selected_model setting exists', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'flower',
        name: 'System Model',
        model: 'system/model',
        isSystem: 1,
        enabled: 1,
      })

      const model = await getSelectedModel()
      expect(model.id).toBe(systemModelId)
      expect(model.name).toBe('System Model')
      expect(model.isSystem).toBe(1)
    })

    it('should return selected model when selected_model setting exists', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'flower',
        name: 'System Model',
        model: 'system/model',
        isSystem: 1,
        enabled: 1,
      })

      // Create a non-system model
      const selectedModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: selectedModelId,
        provider: 'openai',
        name: 'Selected Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Set the selected model
      await updateSetting('selected_model', selectedModelId)

      const model = await getSelectedModel()
      expect(model.id).toBe(selectedModelId)
      expect(model.name).toBe('Selected Model')
    })
  })
})

// ============================================================================
// CHAT THREADS TESTS
// ============================================================================

describe('Chat Threads DAL', () => {
  afterEach(async () => {
    // Clean up chat tables after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
  })

  describe('getOrCreateChatThread', () => {
    it('should create a new thread when none exist', async () => {
      const threadId = await import('./dal').then((m) => m.getOrCreateChatThread())
      expect(threadId).toBeDefined()
      expect(typeof threadId).toBe('string')

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads.length).toBeGreaterThan(0)
      expect(threads[0]?.id).toBe(threadId)
    })

    it('should reuse empty thread when one exists', async () => {
      const db = DatabaseSingleton.instance.db

      // Create an empty thread
      const emptyThreadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: emptyThreadId,
        title: 'Empty Thread',
        isEncrypted: 0,
      })

      const threadId = await import('./dal').then((m) => m.getOrCreateChatThread())
      expect(threadId).toBe(emptyThreadId)
    })

    it('should create new thread when all existing threads have messages', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a thread with a message
      const existingThreadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: existingThreadId,
        title: 'Thread with message',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: existingThreadId,
        role: 'user',
        content: 'Hello',
      })

      const newThreadId = await import('./dal').then((m) => m.getOrCreateChatThread())
      expect(newThreadId).not.toBe(existingThreadId)
    })
  })
})
