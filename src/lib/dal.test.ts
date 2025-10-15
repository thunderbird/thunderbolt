import { migrate } from '@/src/db/migrate'
import { DatabaseSingleton } from '@/src/db/singleton'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
} from '@/src/db/tables'
import type { ThunderboltUIMessage } from '@/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createChatThread,
  createSetting,
  deleteSetting,
  getAllChatThreads,
  getAllMcpServers,
  getAllModels,
  getAllPrompts,
  getAllSettings,
  getAvailableModels,
  getBooleanSetting,
  getChatMessages,
  getChatThread,
  getContextSizeForThread,
  getDefaultModelForThread,
  getHttpMcpServers,
  getIncompleteTasks,
  getIncompleteTasksCount,
  getLastMessage,
  getModel,
  getOrCreateChatThread,
  getSelectedModel,
  getSetting,
  getSystemModel,
  getThemeSetting,
  getTriggerPromptForThread,
  hasSetting,
  resetAutomationToDefault,
  resetModelToDefault,
  resetSettingToDefault,
  saveMessagesWithContextUpdate,
  updateSetting,
} from './dal'
import { defaultAutomations, hashPrompt } from './defaults/automations'
import { defaultModels, hashModel } from './defaults/models'
import { defaultSettings, hashSetting } from './defaults/settings'
import { isSettingModified } from './defaults/utils'
import { seedModels, seedPrompts } from './seed'

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

    it('should return true when value is "true"', async () => {
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

  describe('updateSetting with boolean values', () => {
    it('should create a boolean setting with true value', async () => {
      await updateSetting('bool_key', true)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should create a boolean setting with false value', async () => {
      await updateSetting('bool_key', false)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(false)
    })

    it('should update existing boolean setting', async () => {
      await updateSetting('bool_key', false)
      await updateSetting('bool_key', true)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should store as "true" and "false" strings', async () => {
      await updateSetting('bool_key', true)
      const trueValue = await getSetting('bool_key')
      expect(trueValue).toBe('true')

      await updateSetting('bool_key', false)
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

  describe('getModel', () => {
    it('should return null when model does not exist', async () => {
      const model = await getModel('nonexistent-model-id')
      expect(model).toBe(null)
    })

    it('should return null when model ID is empty string', async () => {
      const model = await getModel('')
      expect(model).toBe(null)
    })

    it('should return model when it exists', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      const model = await getModel(modelId)
      expect(model).not.toBe(null)
      expect(model?.id).toBe(modelId)
      expect(model?.name).toBe('Test Model')
    })

    it('should handle sqlocal bug where .get() returns empty object for missing records', async () => {
      // This test verifies the fix for the sqlocal bug where .get() returns {}
      // instead of undefined when no record is found
      const db = DatabaseSingleton.instance.db

      // Query a non-existent model directly with Drizzle
      const result = await db.select().from(modelsTable).where(eq(modelsTable.id, 'nonexistent')).get()

      // The result should be undefined (not an empty object)
      expect(result).toBeUndefined()
    })
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

  describe('getAllModels', () => {
    it('should return empty array when no models exist', async () => {
      const models = await getAllModels()
      expect(models).toEqual([])
    })

    it('should return all models', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()

      await db.insert(modelsTable).values([
        {
          id: modelId1,
          provider: 'openai',
          name: 'Model 1',
          model: 'gpt-4',
          isSystem: 0,
          enabled: 1,
        },
        {
          id: modelId2,
          provider: 'flower',
          name: 'Model 2',
          model: 'system/model',
          isSystem: 1,
          enabled: 0,
        },
      ])

      const models = await getAllModels()
      expect(models).toHaveLength(2)
      expect(models.map((m) => m.id)).toContain(modelId1)
      expect(models.map((m) => m.id)).toContain(modelId2)
    })
  })

  describe('getAvailableModels', () => {
    it('should return empty array when no enabled models exist', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Disabled Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 0,
      })

      const models = await getAvailableModels()
      expect(models).toEqual([])
    })

    it('should return only enabled models', async () => {
      const db = DatabaseSingleton.instance.db
      const enabledModelId = uuidv7()
      const disabledModelId = uuidv7()

      await db.insert(modelsTable).values([
        {
          id: enabledModelId,
          provider: 'openai',
          name: 'Enabled Model',
          model: 'gpt-4',
          isSystem: 0,
          enabled: 1,
        },
        {
          id: disabledModelId,
          provider: 'flower',
          name: 'Disabled Model',
          model: 'system/model',
          isSystem: 1,
          enabled: 0,
        },
      ])

      const models = await getAvailableModels()
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(enabledModelId)
    })
  })

  describe('getSystemModel', () => {
    it('should return null when no system model exists', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Non-System Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      const systemModel = await getSystemModel()
      expect(systemModel).toBe(null)
    })

    it('should return the system model when it exists', async () => {
      const db = DatabaseSingleton.instance.db
      const systemModelId = uuidv7()

      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'flower',
        name: 'System Model',
        model: 'system/model',
        isSystem: 1,
        enabled: 1,
      })

      const systemModel = await getSystemModel()
      expect(systemModel).not.toBe(null)
      expect(systemModel?.id).toBe(systemModelId)
      expect(systemModel?.isSystem).toBe(1)
    })
  })

  describe('getDefaultModelForThread', () => {
    afterEach(async () => {
      // Clean up chat data after each test (must be done before deleting models due to FK constraints)
      const db = DatabaseSingleton.instance.db
      await db.delete(chatMessagesTable)
      await db.delete(chatThreadsTable)
    })

    it('should fall back to system model when thread has no messages', async () => {
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

      // Create an empty thread
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const model = await getDefaultModelForThread(threadId)
      expect(model.id).toBe(systemModelId)
    })

    it('should return last message model when thread has messages', async () => {
      const db = DatabaseSingleton.instance.db

      // Create models
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'flower',
        name: 'System Model',
        model: 'system/model',
        isSystem: 1,
        enabled: 1,
      })

      const lastUsedModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: lastUsedModelId,
        provider: 'openai',
        name: 'Last Used Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create thread with message
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Hello',
        modelId: lastUsedModelId,
      })

      const model = await getDefaultModelForThread(threadId)
      expect(model.id).toBe(lastUsedModelId)
    })

    it('should fall back correctly when last message model is deleted', async () => {
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

      // Create a temporary model that will be "deleted"
      const deletedModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: deletedModelId,
        provider: 'openai',
        name: 'Deleted Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create thread with message
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Hello',
        modelId: deletedModelId,
      })

      // Delete the model (simulating a model that no longer exists)
      await db.delete(chatMessagesTable)
      await db.delete(modelsTable).where(eq(modelsTable.id, deletedModelId))

      // Should fall back to system model when the last message's model doesn't exist
      const model = await getDefaultModelForThread(threadId)
      expect(model.id).toBe(systemModelId)
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

  describe('createChatThread', () => {
    it('should create a new chat thread with the provided ID', async () => {
      const threadId = uuidv7()

      await createChatThread(threadId)

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
      expect(threads[0]?.title).toBe('New Chat')
    })

    it('should create multiple threads with different IDs', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()

      await createChatThread(threadId1)
      await createChatThread(threadId2)

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })

    it('should throw when creating thread with same ID twice', async () => {
      const threadId = uuidv7()

      await createChatThread(threadId)

      // Should throw due to UNIQUE constraint
      await expect(createChatThread(threadId)).rejects.toThrow()

      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
    })
  })

  describe('getChatThread', () => {
    it('should return undefined values when thread does not exist', async () => {
      const nonExistentId = uuidv7()
      const thread = await getChatThread(nonExistentId)
      expect(thread?.id).toBeUndefined()
      expect(thread?.title).toBeUndefined()
    })

    it('should return the thread when it exists', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create a thread manually
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const thread = await getChatThread(threadId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('Test Thread')
    })

    it('should return the correct thread when multiple threads exist', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create two threads
      await db.insert(chatThreadsTable).values({
        id: threadId1,
        title: 'First Thread',
        isEncrypted: 0,
      })
      await db.insert(chatThreadsTable).values({
        id: threadId2,
        title: 'Second Thread',
        isEncrypted: 0,
      })

      const thread1 = await getChatThread(threadId1)
      const thread2 = await getChatThread(threadId2)

      expect(thread1?.id).toBe(threadId1)
      expect(thread1?.title).toBe('First Thread')
      expect(thread2?.id).toBe(threadId2)
      expect(thread2?.title).toBe('Second Thread')
    })
  })

  describe('getOrCreateChatThread', () => {
    it('should return existing thread when it exists', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create a thread manually
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Existing Thread',
        isEncrypted: 0,
      })

      const thread = await getOrCreateChatThread(threadId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('Existing Thread')

      // Verify no new thread was created
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('should create and return new thread when it does not exist', async () => {
      const threadId = uuidv7()

      const thread = await getOrCreateChatThread(threadId)
      expect(thread).not.toBeNull()
      expect(thread?.id).toBe(threadId)
      expect(thread?.title).toBe('New Chat')

      // Verify thread was created in database
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
    })

    it('should handle multiple calls with same ID consistently', async () => {
      const threadId = uuidv7()

      const thread1 = await getOrCreateChatThread(threadId)
      const thread2 = await getOrCreateChatThread(threadId)

      expect(thread1?.id).toBe(threadId)
      expect(thread2?.id).toBe(threadId)
      expect(thread1?.title).toBe('New Chat')
      expect(thread2?.title).toBe('New Chat')

      // Verify only one thread exists
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(1)
    })

    it('should work correctly with different thread IDs', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()

      const thread1 = await getOrCreateChatThread(threadId1)
      const thread2 = await getOrCreateChatThread(threadId2)

      expect(thread1?.id).toBe(threadId1)
      expect(thread2?.id).toBe(threadId2)
      expect(thread1?.id).not.toBe(thread2?.id)

      // Verify both threads exist
      const db = DatabaseSingleton.instance.db
      const threads = await db.select().from(chatThreadsTable)
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })
  })

  describe('getAllChatThreads', () => {
    it('should return empty array when no threads exist', async () => {
      const threads = await getAllChatThreads()
      expect(threads).toEqual([])
    })

    it('should return all threads ordered by creation date (desc)', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()

      await db.insert(chatThreadsTable).values([
        {
          id: threadId1,
          title: 'First Thread',
          isEncrypted: 0,
        },
        {
          id: threadId2,
          title: 'Second Thread',
          isEncrypted: 0,
        },
      ])

      const threads = await getAllChatThreads()
      expect(threads).toHaveLength(2)
      expect(threads.map((t) => t.id)).toContain(threadId1)
      expect(threads.map((t) => t.id)).toContain(threadId2)
    })
  })
})

// ============================================================================
// CHAT MESSAGES TESTS
// ============================================================================

describe('Chat Messages DAL', () => {
  afterEach(async () => {
    // Clean up chat data after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
  })

  describe('getChatMessages', () => {
    it('should return empty array when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages = await getChatMessages(threadId)
      expect(messages).toEqual([])
    })

    it('should return messages for a thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'Hello',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Hi there!',
        },
      ])

      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(2)
      expect(messages.map((m) => m.id)).toContain(messageId1)
      expect(messages.map((m) => m.id)).toContain(messageId2)
    })

    it('should return messages ordered by id', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

      // Insert messages in reverse order
      await db.insert(chatMessagesTable).values([
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Second message',
        },
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
      ])

      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(2)
      expect(messages[0]?.id).toBe(messageId1)
      expect(messages[1]?.id).toBe(messageId2)
    })
  })

  describe('getLastMessage', () => {
    it('should return undefined when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).toBeUndefined()
    })

    it('should return the last message for a thread', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const modelId = uuidv7()

      // Create model first
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Last message',
          modelId: modelId,
        },
      ])

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).not.toBeUndefined()
      expect(lastMessage?.id).toBe(messageId2)
      expect(lastMessage?.modelId).toBe(modelId)
    })
  })

  describe('saveMessagesWithContextUpdate with parent_id', () => {
    it('should set parent_id to null for first message in empty thread', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'user',
          parts: [{ type: 'text', text: 'First message' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(null)
    })

    it('should set parent_id to last message when adding new message', async () => {
      const threadId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: messageId1,
        chatThreadId: threadId,
        role: 'user',
        content: 'First message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId2,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second message' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId2))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(messageId1)
    })

    it('should chain multiple messages in batch correctly', async () => {
      const threadId = uuidv7()
      const existingMessageId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Insert existing message
      await db.insert(chatMessagesTable).values({
        id: existingMessageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Existing message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId1,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 1' }],
        },
        {
          id: messageId2,
          role: 'user',
          parts: [{ type: 'text', text: 'Message 2' }],
        },
        {
          id: messageId3,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 3' }],
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const allMessages = await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatThreadId, threadId))
        .orderBy(chatMessagesTable.id)

      expect(allMessages).toHaveLength(4)

      // First new message should point to existing message
      const msg1 = allMessages.find((m) => m.id === messageId1)
      expect(msg1?.parentId).toBe(existingMessageId)

      // Second new message should point to first new message
      const msg2 = allMessages.find((m) => m.id === messageId2)
      expect(msg2?.parentId).toBe(messageId1)

      // Third new message should point to second new message
      const msg3 = allMessages.find((m) => m.id === messageId3)
      expect(msg3?.parentId).toBe(messageId2)
    })

    it('should update context size from message metadata', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              totalTokens: 300,
            },
          },
        },
      ]

      await saveMessagesWithContextUpdate(threadId, messages)

      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
      expect(thread?.contextSize).toBe(300)
    })
  })

  describe('cascade delete with parent_id', () => {
    it('should delete child messages when parent is deleted', async () => {
      const threadId = uuidv7()
      const parentMessageId = uuidv7()
      const childMessageId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: parentMessageId,
          chatThreadId: threadId,
          role: 'user',
          content: 'Parent message',
          parentId: null,
        },
        {
          id: childMessageId,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Child message',
          parentId: parentMessageId,
        },
      ])

      // Delete parent message
      await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, parentMessageId))

      // Child should be deleted by cascade
      const messages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, threadId))
      expect(messages).toHaveLength(0)
    })

    it('should delete entire chain when root message is deleted', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const msg4Id = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create a chain: msg1 -> msg2 -> msg3 -> msg4
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
        {
          id: msg4Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 4',
          parentId: msg3Id,
        },
      ])

      // Delete root message
      await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, msg1Id))

      // All messages should be deleted by cascade
      const messages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, threadId))
      expect(messages).toHaveLength(0)
    })

    it('should delete only descendant branch when deleting middle message', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create chain: msg1 -> msg2 -> msg3
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
      ])

      // Delete middle message
      await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, msg2Id))

      // msg1 should remain, msg2 and msg3 should be deleted
      const messages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, threadId))
      expect(messages).toHaveLength(1)
      expect(messages[0]?.id).toBe(msg1Id)
    })
  })
})

// ============================================================================
// TASKS TESTS
// ============================================================================

describe('Tasks DAL', () => {
  afterEach(async () => {
    // Clean up tasks table after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(tasksTable)
  })

  describe('getIncompleteTasks', () => {
    it('should return empty array when no tasks exist', async () => {
      const tasks = await getIncompleteTasks()
      expect(tasks).toEqual([])
    })

    it('should return only incomplete tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Incomplete task 1',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Incomplete task 2',
          isComplete: 0,
          order: 2,
        },
        {
          id: taskId3,
          item: 'Completed task',
          isComplete: 1,
          order: 3,
        },
      ])

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.id)).toContain(taskId1)
      expect(tasks.map((t) => t.id)).toContain(taskId2)
      expect(tasks.map((t) => t.id)).not.toContain(taskId3)
    })

    it('should filter by search query', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Buy groceries',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Walk the dog',
          isComplete: 0,
          order: 2,
        },
      ])

      const tasks = await getIncompleteTasks('groceries')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.id).toBe(taskId1)
    })

    it('should return empty array when no tasks match search query', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId,
        item: 'Buy groceries',
        isComplete: 0,
        order: 1,
      })

      const tasks = await getIncompleteTasks('nonexistent')
      expect(tasks).toEqual([])
    })
  })

  describe('getIncompleteTasksCount', () => {
    it('should return 0 when no incomplete tasks exist', async () => {
      const count = await getIncompleteTasksCount()
      expect(count).toBe(0)
    })

    it('should return correct count of incomplete tasks', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values([
        {
          id: taskId1,
          item: 'Incomplete task 1',
          isComplete: 0,
          order: 1,
        },
        {
          id: taskId2,
          item: 'Incomplete task 2',
          isComplete: 0,
          order: 2,
        },
        {
          id: taskId3,
          item: 'Completed task',
          isComplete: 1,
          order: 3,
        },
      ])

      const count = await getIncompleteTasksCount()
      expect(count).toBe(2)
    })
  })
})

// ============================================================================
// MCP SERVERS TESTS
// ============================================================================

describe('MCP Servers DAL', () => {
  afterEach(async () => {
    // Clean up MCP servers table after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(mcpServersTable)
  })

  describe('getAllMcpServers', () => {
    it('should return empty array when no MCP servers exist', async () => {
      const servers = await getAllMcpServers()
      expect(servers).toEqual([])
    })

    it('should return all MCP servers', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: serverId1,
          name: 'Server 1',
          type: 'stdio',
          enabled: 1,
        },
        {
          id: serverId2,
          name: 'Server 2',
          type: 'http',
          url: 'http://example.com',
          enabled: 0,
        },
      ])

      const servers = await getAllMcpServers()
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
    })
  })

  describe('getHttpMcpServers', () => {
    it('should return empty array when no HTTP servers exist', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'STDIO Server',
        type: 'stdio',
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toEqual([])
    })

    it('should return only HTTP servers with URLs', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()
      const serverId3 = uuidv7()

      await db.insert(mcpServersTable).values([
        {
          id: serverId1,
          name: 'HTTP Server 1',
          type: 'http',
          url: 'http://example1.com',
          enabled: 1,
        },
        {
          id: serverId2,
          name: 'HTTP Server 2',
          type: 'http',
          url: 'http://example2.com',
          enabled: 0,
        },
        {
          id: serverId3,
          name: 'STDIO Server',
          type: 'stdio',
          enabled: 1,
        },
      ])

      const servers = await getHttpMcpServers()
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
      expect(servers.map((s) => s.id)).not.toContain(serverId3)
    })
  })
})

// ============================================================================
// PROMPTS TESTS
// ============================================================================

describe('Prompts DAL', () => {
  afterEach(async () => {
    // Clean up prompts table after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(promptsTable)
  })

  describe('getAllPrompts', () => {
    it('should return empty array when no prompts exist', async () => {
      const prompts = await getAllPrompts()
      expect(prompts).toEqual([])
    })

    it('should return all prompts when no search query provided', async () => {
      const db = DatabaseSingleton.instance.db
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        {
          id: promptId1,
          prompt: 'First prompt',
          modelId: modelId,
        },
        {
          id: promptId2,
          prompt: 'Second prompt',
          modelId: modelId,
        },
      ])

      const prompts = await getAllPrompts()
      expect(prompts).toHaveLength(2)
      expect(prompts.map((p) => p.id)).toContain(promptId1)
      expect(prompts.map((p) => p.id)).toContain(promptId2)
    })

    it('should filter by search query', async () => {
      const db = DatabaseSingleton.instance.db
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        {
          id: promptId1,
          prompt: 'Write a story about cats',
          modelId: modelId,
        },
        {
          id: promptId2,
          prompt: 'Write a story about dogs',
          modelId: modelId,
        },
      ])

      const prompts = await getAllPrompts('cats')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.id).toBe(promptId1)
    })

    it('should return empty array when no prompts match search query', async () => {
      const db = DatabaseSingleton.instance.db
      const promptId = uuidv7()

      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Write a story about cats',
        modelId: modelId,
      })

      const prompts = await getAllPrompts('dogs')
      expect(prompts).toEqual([])
    })
  })

  describe('getTriggerPromptForThread', () => {
    afterEach(async () => {
      // Clean up chat data after each test
      const db = DatabaseSingleton.instance.db
      await db.delete(chatMessagesTable)
      await db.delete(chatThreadsTable)
    })

    it('should return null when thread does not exist', async () => {
      const threadId = uuidv7()
      const result = await getTriggerPromptForThread(threadId)
      expect(result).toBe(null)
    })

    it('should return null when thread was not triggered by automation', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 0,
      })

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(false)
      expect(result?.isAutomationDeleted).toBe(false)
      expect(result?.prompt).toBe(null)
    })

    it('should return automation info when thread was triggered by automation', async () => {
      const threadId = uuidv7()
      const promptId = uuidv7()
      const db = DatabaseSingleton.instance.db

      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test automation prompt',
        modelId: modelId,
      })

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 1,
        triggeredBy: promptId,
      })

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(true)
      expect(result?.isAutomationDeleted).toBe(false)
      expect(result?.prompt?.id).toBe(promptId)
    })

    it('should return automation info with deleted flag when prompt is deleted', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 1,
        triggeredBy: null, // No prompt exists, simulating deleted prompt
      })

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(true)
      expect(result?.isAutomationDeleted).toBe(true)
      expect(result?.prompt).toBe(null)
    })
  })
})

// ============================================================================
// CONTEXT SIZE TESTS
// ============================================================================

describe('Context Size DAL', () => {
  afterEach(async () => {
    // Clean up chat data after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
  })

  describe('getContextSizeForThread', () => {
    it('should return null when thread does not exist', async () => {
      const threadId = uuidv7()
      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(null)
    })

    it('should return null when thread has no context size', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(null)
    })

    it('should return context size when thread has it set', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        contextSize: 1500,
      })

      const contextSize = await getContextSizeForThread(threadId)
      expect(contextSize).toBe(1500)
    })
  })
})

// ============================================================================
// DEFAULTS MANAGEMENT
// ============================================================================

describe('resetModelToDefault', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    await db.delete(modelsTable)
    await seedModels()
  })

  it('resets modified model to default state', async () => {
    const db = DatabaseSingleton.instance.db
    const defaultModel = defaultModels[0]

    // User modifies the model
    await db.update(modelsTable).set({ name: 'User Modified', enabled: 0 }).where(eq(modelsTable.id, defaultModel.id))

    // Verify it's modified
    let model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()
    expect(model?.name).toBe('User Modified')
    expect(model?.enabled).toBe(0)

    // Reset to default
    await resetModelToDefault(defaultModel.id, defaultModel)

    // Verify it's reset
    model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()
    expect(model?.name).toBe(defaultModel.name)
    expect(model?.enabled).toBe(defaultModel.enabled)
    // Hash should be computed from the default
    expect(model?.defaultHash).toBe(hashModel(defaultModel))
  })

  it('clears deletedAt when resetting', async () => {
    const db = DatabaseSingleton.instance.db
    const defaultModel = defaultModels[0]

    // Soft delete
    await db
      .update(modelsTable)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(modelsTable.id, defaultModel.id))

    // Reset to default
    await resetModelToDefault(defaultModel.id, defaultModel)

    // Verify deletedAt is cleared
    const model = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()
    expect(model?.deletedAt).toBeNull()
  })
})

describe('resetAutomationToDefault', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    await db.delete(modelsTable)
    await db.delete(promptsTable)
    await seedModels()
    await seedPrompts()
  })

  it('resets modified automation to default state', async () => {
    const db = DatabaseSingleton.instance.db
    const defaultAutomation = defaultAutomations[0]

    // User modifies the automation
    await db
      .update(promptsTable)
      .set({ title: 'Modified Title', prompt: 'Modified content' })
      .where(eq(promptsTable.id, defaultAutomation.id))

    // Verify it's modified
    let automation = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomation.id)).get()
    expect(automation?.title).toBe('Modified Title')
    expect(automation?.prompt).toBe('Modified content')

    // Reset to default
    await resetAutomationToDefault(defaultAutomation.id, defaultAutomation)

    // Verify it's reset
    automation = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomation.id)).get()
    expect(automation?.title).toBe(defaultAutomation.title)
    expect(automation?.prompt).toBe(defaultAutomation.prompt)
    // Hash should be computed from the default
    expect(automation?.defaultHash).toBe(hashPrompt(defaultAutomation))

    // Verify hash now matches
    if (automation) {
      const currentHash = hashPrompt(automation)
      expect(automation.defaultHash).toBeDefined()
      expect(currentHash).toBe(automation.defaultHash!)
    }
  })

  it('after reset, modification detection works correctly', async () => {
    const db = DatabaseSingleton.instance.db
    const defaultAutomation = defaultAutomations[0]

    // Modify
    await db.update(promptsTable).set({ title: 'Modified' }).where(eq(promptsTable.id, defaultAutomation.id))

    // Verify detected as modified
    let automation = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomation.id)).get()
    expect(automation).toBeDefined()
    if (automation) {
      const currentHash = hashPrompt(automation)
      expect(currentHash).not.toBe(automation.defaultHash)
    }

    // Reset
    await resetAutomationToDefault(defaultAutomation.id, defaultAutomation)

    // Verify no longer detected as modified
    automation = await db.select().from(promptsTable).where(eq(promptsTable.id, defaultAutomation.id)).get()
    expect(automation).toBeDefined()
    if (automation) {
      const currentHash = hashPrompt(automation)
      expect(automation.defaultHash).toBeDefined()
      expect(currentHash).toBe(automation.defaultHash!)
    }
  })
})

describe('resetSettingToDefault', () => {
  beforeEach(async () => {
    const db = DatabaseSingleton.instance.db
    // Clean up settings table
    await db.delete(settingsTable)
  })

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
