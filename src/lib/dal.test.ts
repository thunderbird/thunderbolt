import { migrate } from '@/src/db/migrate'
import { DatabaseSingleton } from '@/src/db/singleton'
import {
  accountsTable,
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
} from '@/src/db/tables'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createChatThread,
  createSetting,
  deleteSetting,
  getAllAccounts,
  getAllChatThreads,
  getAllMcpServers,
  getAllModels,
  getAllPrompts,
  getAllSettings,
  getAvailableModels,
  getBooleanSetting,
  getBridgeSettings,
  getChatMessages,
  getChatThread,
  getHttpMcpServers,
  getIncompleteTasks,
  getIncompleteTasksCount,
  getLastMessage,
  getOrCreateChatThread,
  getDefaultModelForThread,
  getModel,
  getPreferencesSettings,
  getSelectedModel,
  getSetting,
  getSystemModel,
  getThemeSetting,
  getTriggerPromptForThread,
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

beforeEach(async () => {
  // Ensure clean state before each test
  const db = DatabaseSingleton.instance.db
  await db.delete(settingsTable)
  await db.delete(modelsTable)
  await db.delete(chatMessagesTable)
  await db.delete(chatThreadsTable)
  await db.delete(tasksTable)
  await db.delete(accountsTable)
  await db.delete(mcpServersTable)
  await db.delete(promptsTable)
})

afterEach(async () => {
  // Clean up all tables after each test to ensure proper isolation
  const db = DatabaseSingleton.instance.db
  await db.delete(settingsTable)
  await db.delete(modelsTable)
  await db.delete(chatMessagesTable)
  await db.delete(chatThreadsTable)
  await db.delete(tasksTable)
  await db.delete(accountsTable)
  await db.delete(mcpServersTable)
  await db.delete(promptsTable)
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

    it('should return custom default when setting does not exist', async () => {
      const value = await getBooleanSetting('nonexistent_key', true)
      expect(value).toBe(true)
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

  describe('updateBooleanSetting', () => {
    it('should create a boolean setting with true value', async () => {
      await updateBooleanSetting('bool_key', true)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(true)
    })

    it('should create a boolean setting with false value', async () => {
      await updateBooleanSetting('bool_key', false)
      const value = await getBooleanSetting('bool_key')
      expect(value).toBe(false)
    })

    it('should update existing boolean setting', async () => {
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

  describe('getPreferencesSettings', () => {
    it('should return default values when no settings exist', async () => {
      const preferences = await getPreferencesSettings()
      expect(preferences).toEqual({
        locationName: '',
        locationLat: '',
        locationLng: '',
        preferredName: '',
        dataCollection: true,
        experimentalFeatureTasks: false,
      })
    })

    it('should return stored values when settings exist', async () => {
      await updateSetting('location_name', 'New York')
      await updateSetting('location_lat', '40.7128')
      await updateSetting('location_lng', '-74.0060')
      await updateSetting('preferred_name', 'John Doe')
      await updateBooleanSetting('data_collection', false)
      await updateBooleanSetting('experimental_feature_tasks', true)

      const preferences = await getPreferencesSettings()
      expect(preferences).toEqual({
        locationName: 'New York',
        locationLat: '40.7128',
        locationLng: '-74.0060',
        preferredName: 'John Doe',
        dataCollection: false,
        experimentalFeatureTasks: true,
      })
    })

    it('should handle mixed default and custom values', async () => {
      await updateSetting('location_name', 'San Francisco')
      await updateBooleanSetting('experimental_feature_tasks', true)

      const preferences = await getPreferencesSettings()
      expect(preferences).toEqual({
        locationName: 'San Francisco',
        locationLat: '',
        locationLng: '',
        preferredName: '',
        dataCollection: true,
        experimentalFeatureTasks: true,
      })
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

    it('should work with different storage keys', async () => {
      await updateSetting('appearance_theme', 'auto')
      const theme = await getThemeSetting('appearance_theme', 'light')
      expect(theme).toBe('auto')
    })

    it('should return empty string when stored as empty', async () => {
      await updateSetting('theme', '')
      const theme = await getThemeSetting('theme', 'light')
      expect(theme).toBe('')
    })
  })

  describe('getBridgeSettings', () => {
    it('should return default values when no settings exist', async () => {
      const bridgeSettings = await getBridgeSettings()
      expect(bridgeSettings).toEqual({
        enabled: false,
      })
    })

    it('should return stored values when settings exist', async () => {
      await updateBooleanSetting('bridge_enabled', true)
      const bridgeSettings = await getBridgeSettings()
      expect(bridgeSettings).toEqual({
        enabled: true,
      })
    })

    it('should return false when bridge is explicitly disabled', async () => {
      await updateBooleanSetting('bridge_enabled', false)
      const bridgeSettings = await getBridgeSettings()
      expect(bridgeSettings).toEqual({
        enabled: false,
      })
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

    it('should return all models including disabled ones', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId1,
        provider: 'openai',
        name: 'Enabled Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(modelsTable).values({
        id: modelId2,
        provider: 'openai',
        name: 'Disabled Model',
        model: 'gpt-3.5',
        isSystem: 0,
        enabled: 0,
      })

      const models = await getAllModels()
      expect(models).toHaveLength(2)
      expect(models.map((m) => m.id)).toContain(modelId1)
      expect(models.map((m) => m.id)).toContain(modelId2)
    })

    it('should map model fields correctly', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 1,
        enabled: 1,
        apiKey: 'test-key',
      })

      const models = await getAllModels()
      const model = models.find((m) => m.id === modelId)
      expect(model).toBeDefined()
      expect(model?.name).toBe('Test Model')
      expect(model?.isSystem).toBe(1)
      expect(model?.apiKey).toBe('test-key')
    })
  })

  describe('getAvailableModels', () => {
    it('should return empty array when no enabled models exist', async () => {
      const db = DatabaseSingleton.instance.db
      await db.insert(modelsTable).values({
        id: uuidv7(),
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

      await db.insert(modelsTable).values({
        id: enabledModelId,
        provider: 'openai',
        name: 'Enabled Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(modelsTable).values({
        id: disabledModelId,
        provider: 'openai',
        name: 'Disabled Model',
        model: 'gpt-3.5',
        isSystem: 0,
        enabled: 0,
      })

      const models = await getAvailableModels()
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(enabledModelId)
      expect(models[0]?.name).toBe('Enabled Model')
    })

    it('should include system models when enabled', async () => {
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

      const models = await getAvailableModels()
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(systemModelId)
      expect(models[0]?.isSystem).toBe(1)
    })
  })

  describe('getSystemModel', () => {
    it('should return null when no system model exists', async () => {
      const db = DatabaseSingleton.instance.db
      await db.insert(modelsTable).values({
        id: uuidv7(),
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
      expect(systemModel?.name).toBe('System Model')
      expect(systemModel?.isSystem).toBe(1)
    })

    it('should return the first system model when multiple exist', async () => {
      const db = DatabaseSingleton.instance.db
      const systemModelId1 = uuidv7()
      const systemModelId2 = uuidv7()

      await db.insert(modelsTable).values({
        id: systemModelId1,
        provider: 'flower',
        name: 'First System Model',
        model: 'system/model1',
        isSystem: 1,
        enabled: 1,
      })

      await db.insert(modelsTable).values({
        id: systemModelId2,
        provider: 'flower',
        name: 'Second System Model',
        model: 'system/model2',
        isSystem: 1,
        enabled: 1,
      })

      const systemModel = await getSystemModel()
      expect(systemModel).not.toBe(null)
      expect(systemModel?.id).toBe(systemModelId1)
      expect(systemModel?.name).toBe('First System Model')
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

    it('should return all threads ordered by creation date (newest first)', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const threadId3 = uuidv7()

      // Create threads with slight delays to ensure different timestamps
      await db.insert(chatThreadsTable).values({
        id: threadId1,
        title: 'First Thread',
        isEncrypted: 0,
      })

      await new Promise((resolve) => setTimeout(resolve, 10)) // Small delay

      await db.insert(chatThreadsTable).values({
        id: threadId2,
        title: 'Second Thread',
        isEncrypted: 0,
      })

      await new Promise((resolve) => setTimeout(resolve, 10)) // Small delay

      await db.insert(chatThreadsTable).values({
        id: threadId3,
        title: 'Third Thread',
        isEncrypted: 0,
      })

      const threads = await getAllChatThreads()
      expect(threads).toHaveLength(3)
      // Should be ordered by ID descending (newest first)
      expect(threads[0]?.id).toBe(threadId3)
      expect(threads[1]?.id).toBe(threadId2)
      expect(threads[2]?.id).toBe(threadId1)
    })

    it('should return threads with all properties', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId = uuidv7()
      const promptId = uuidv7()

      // Create a model first to satisfy foreign key constraint
      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create a prompt first to satisfy foreign key constraint
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test prompt',
        title: 'Test Prompt',
        modelId: modelId,
      })

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 1,
        wasTriggeredByAutomation: 1,
        triggeredBy: promptId,
      })

      const threads = await getAllChatThreads()
      expect(threads).toHaveLength(1)
      expect(threads[0]?.id).toBe(threadId)
      expect(threads[0]?.title).toBe('Test Thread')
      expect(threads[0]?.isEncrypted).toBe(1)
      expect(threads[0]?.wasTriggeredByAutomation).toBe(1)
      expect(threads[0]?.triggeredBy).toBe(promptId)
    })
  })

  describe('getChatMessages', () => {
    afterEach(async () => {
      // Clean up chat data after each test
      const db = DatabaseSingleton.instance.db
      await db.delete(chatMessagesTable)
      await db.delete(chatThreadsTable)
    })

    it('should return empty array when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create thread without messages
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Empty Thread',
        isEncrypted: 0,
      })

      const messages = await getChatMessages(threadId)
      expect(messages).toEqual([])
    })

    it('should return all messages for a thread ordered by ID', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create messages
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()

      await db.insert(chatMessagesTable).values({
        id: messageId1,
        chatThreadId: threadId,
        role: 'user',
        content: 'First message',
      })

      await db.insert(chatMessagesTable).values({
        id: messageId2,
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Second message',
      })

      await db.insert(chatMessagesTable).values({
        id: messageId3,
        chatThreadId: threadId,
        role: 'user',
        content: 'Third message',
      })

      const messages = await getChatMessages(threadId)
      expect(messages).toHaveLength(3)
      expect(messages[0]?.id).toBe(messageId1)
      expect(messages[1]?.id).toBe(messageId2)
      expect(messages[2]?.id).toBe(messageId3)
    })

    it('should only return messages for the specified thread', async () => {
      const threadId1 = uuidv7()
      const threadId2 = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create two threads
      await db.insert(chatThreadsTable).values({
        id: threadId1,
        title: 'Thread 1',
        isEncrypted: 0,
      })

      await db.insert(chatThreadsTable).values({
        id: threadId2,
        title: 'Thread 2',
        isEncrypted: 0,
      })

      // Create messages for both threads
      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId1,
        role: 'user',
        content: 'Thread 1 message',
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId2,
        role: 'user',
        content: 'Thread 2 message',
      })

      const messages1 = await getChatMessages(threadId1)
      const messages2 = await getChatMessages(threadId2)

      expect(messages1).toHaveLength(1)
      expect(messages1[0]?.content).toBe('Thread 1 message')
      expect(messages2).toHaveLength(1)
      expect(messages2[0]?.content).toBe('Thread 2 message')
    })
  })

  describe('getLastMessage', () => {
    afterEach(async () => {
      // Clean up chat data after each test
      const db = DatabaseSingleton.instance.db
      await db.delete(chatMessagesTable)
      await db.delete(chatThreadsTable)
    })

    it('should return undefined when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create thread without messages
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Empty Thread',
        isEncrypted: 0,
      })

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).toBeUndefined()
    })

    it('should return the last message when thread has messages', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create messages
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()

      await db.insert(chatMessagesTable).values({
        id: messageId1,
        chatThreadId: threadId,
        role: 'user',
        content: 'First message',
      })

      await db.insert(chatMessagesTable).values({
        id: messageId2,
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Second message',
      })

      await db.insert(chatMessagesTable).values({
        id: messageId3,
        chatThreadId: threadId,
        role: 'user',
        content: 'Third message',
      })

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).toBeDefined()
      expect(lastMessage?.id).toBe(messageId3)
      expect(lastMessage?.chatThreadId).toBe(threadId)
    })

    it('should return only id, chatThreadId, and modelId fields', async () => {
      const threadId = uuidv7()
      const db = DatabaseSingleton.instance.db

      // Create a model first to satisfy foreign key constraint
      const modelId = uuidv7()
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create thread
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create message with modelId
      const messageId = uuidv7()

      await db.insert(chatMessagesTable).values({
        id: messageId,
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Test message',
        modelId: modelId,
      })

      const lastMessage = await getLastMessage(threadId)
      expect(lastMessage).toBeDefined()
      expect(lastMessage?.id).toBe(messageId)
      expect(lastMessage?.chatThreadId).toBe(threadId)
      expect(lastMessage?.modelId).toBe(modelId)
      // Should not have other fields like content, role, etc.
      expect(lastMessage).not.toHaveProperty('content')
      expect(lastMessage).not.toHaveProperty('role')
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

      await db.insert(tasksTable).values({
        id: taskId1,
        item: 'Incomplete task 1',
        isComplete: 0,
        order: 1,
      })

      await db.insert(tasksTable).values({
        id: taskId2,
        item: 'Complete task',
        isComplete: 1,
        order: 2,
      })

      await db.insert(tasksTable).values({
        id: taskId3,
        item: 'Incomplete task 2',
        isComplete: 0,
        order: 3,
      })

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.id)).toContain(taskId1)
      expect(tasks.map((t) => t.id)).toContain(taskId3)
      expect(tasks.map((t) => t.id)).not.toContain(taskId2)
    })

    it('should filter by search query when provided', async () => {
      const db = DatabaseSingleton.instance.db
      const taskId1 = uuidv7()
      const taskId2 = uuidv7()
      const taskId3 = uuidv7()

      await db.insert(tasksTable).values({
        id: taskId1,
        item: 'Buy groceries',
        isComplete: 0,
        order: 1,
      })

      await db.insert(tasksTable).values({
        id: taskId2,
        item: 'Call doctor',
        isComplete: 0,
        order: 2,
      })

      await db.insert(tasksTable).values({
        id: taskId3,
        item: 'Buy milk',
        isComplete: 0,
        order: 3,
      })

      const tasks = await getIncompleteTasks('buy')
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.item)).toContain('Buy groceries')
      expect(tasks.map((t) => t.item)).toContain('Buy milk')
      expect(tasks.map((t) => t.item)).not.toContain('Call doctor')
    })

    it('should limit results to 50 tasks', async () => {
      const db = DatabaseSingleton.instance.db

      // Create 60 incomplete tasks
      for (let i = 0; i < 60; i++) {
        await db.insert(tasksTable).values({
          id: uuidv7(),
          item: `Task ${i}`,
          isComplete: 0,
          order: i,
        })
      }

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(50)
    })

    it('should filter out empty or whitespace-only tasks', async () => {
      const db = DatabaseSingleton.instance.db

      await db.insert(tasksTable).values({
        id: uuidv7(),
        item: 'Valid task',
        isComplete: 0,
        order: 1,
      })

      await db.insert(tasksTable).values({
        id: uuidv7(),
        item: '',
        isComplete: 0,
        order: 2,
      })

      await db.insert(tasksTable).values({
        id: uuidv7(),
        item: '   ',
        isComplete: 0,
        order: 3,
      })

      const tasks = await getIncompleteTasks()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.item).toBe('Valid task')
    })
  })

  describe('getIncompleteTasksCount', () => {
    it('should return 0 when no incomplete tasks exist', async () => {
      const count = await getIncompleteTasksCount()
      expect(count).toBe(0)
    })

    it('should return correct count of incomplete tasks', async () => {
      const db = DatabaseSingleton.instance.db

      // Create some incomplete tasks
      for (let i = 0; i < 3; i++) {
        await db.insert(tasksTable).values({
          id: uuidv7(),
          item: `Incomplete task ${i}`,
          isComplete: 0,
          order: i,
        })
      }

      // Create some complete tasks
      for (let i = 0; i < 2; i++) {
        await db.insert(tasksTable).values({
          id: uuidv7(),
          item: `Complete task ${i}`,
          isComplete: 1,
          order: i + 3,
        })
      }

      const count = await getIncompleteTasksCount()
      expect(count).toBe(3)
    })

    it('should return 0 when only complete tasks exist', async () => {
      const db = DatabaseSingleton.instance.db

      await db.insert(tasksTable).values({
        id: uuidv7(),
        item: 'Complete task',
        isComplete: 1,
        order: 1,
      })

      const count = await getIncompleteTasksCount()
      expect(count).toBe(0)
    })
  })
})

// ============================================================================
// ACCOUNTS TESTS
// ============================================================================

describe('Accounts DAL', () => {
  afterEach(async () => {
    // Clean up accounts table after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(accountsTable)
  })

  describe('getAllAccounts', () => {
    it('should return empty array when no accounts exist', async () => {
      const accounts = await getAllAccounts()
      expect(accounts).toEqual([])
    })

    it('should return all accounts', async () => {
      const db = DatabaseSingleton.instance.db
      const accountId1 = uuidv7()
      const accountId2 = uuidv7()

      await db.insert(accountsTable).values({
        id: accountId1,
        type: 'imap',
        imapHostname: 'imap.example.com',
        imapPort: 993,
        imapUsername: 'test1@example.com',
        imapPassword: 'password1',
      })

      await db.insert(accountsTable).values({
        id: accountId2,
        type: 'imap',
        imapHostname: 'imap.example.com',
        imapPort: 993,
        imapUsername: 'test2@example.com',
        imapPassword: 'password2',
      })

      const accounts = await getAllAccounts()
      expect(accounts).toHaveLength(2)
      expect(accounts.map((a) => a.id)).toContain(accountId1)
      expect(accounts.map((a) => a.id)).toContain(accountId2)
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
    it('should return empty array when no servers exist', async () => {
      const servers = await getAllMcpServers()
      expect(servers).toEqual([])
    })

    it('should return all MCP servers', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId1,
        name: 'Test Server 1',
        type: 'http',
        url: 'https://example.com',
        enabled: 1,
      })

      await db.insert(mcpServersTable).values({
        id: serverId2,
        name: 'Test Server 2',
        type: 'stdio',
        url: null,
        enabled: 0,
      })

      const servers = await getAllMcpServers()
      expect(servers).toHaveLength(2)
      expect(servers.map((s) => s.id)).toContain(serverId1)
      expect(servers.map((s) => s.id)).toContain(serverId2)
    })
  })

  describe('getHttpMcpServers', () => {
    it('should return empty array when no HTTP servers exist', async () => {
      const db = DatabaseSingleton.instance.db
      await db.insert(mcpServersTable).values({
        id: uuidv7(),
        name: 'STDIO Server',
        type: 'stdio',
        url: null,
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toEqual([])
    })

    it('should return only HTTP servers with non-null URLs', async () => {
      const db = DatabaseSingleton.instance.db
      const httpServerId = uuidv7()
      const stdioServerId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: httpServerId,
        name: 'HTTP Server',
        type: 'http',
        url: 'https://example.com',
        enabled: 1,
      })

      await db.insert(mcpServersTable).values({
        id: stdioServerId,
        name: 'STDIO Server',
        type: 'stdio',
        url: null,
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toHaveLength(1)
      expect(servers[0]?.id).toBe(httpServerId)
      expect(servers[0]?.name).toBe('HTTP Server')
      expect(servers[0]?.url).toBe('https://example.com')
    })

    it('should exclude HTTP servers with null URLs', async () => {
      const db = DatabaseSingleton.instance.db

      await db.insert(mcpServersTable).values({
        id: uuidv7(),
        name: 'HTTP Server with null URL',
        type: 'http',
        url: null,
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toEqual([])
    })

    it('should return servers with correct structure', async () => {
      const db = DatabaseSingleton.instance.db
      const serverId = uuidv7()

      await db.insert(mcpServersTable).values({
        id: serverId,
        name: 'Test HTTP Server',
        type: 'http',
        url: 'https://api.example.com',
        enabled: 1,
      })

      const servers = await getHttpMcpServers()
      expect(servers).toHaveLength(1)
      const server = servers[0]
      expect(server).toHaveProperty('id')
      expect(server).toHaveProperty('name')
      expect(server).toHaveProperty('url')
      expect(server).toHaveProperty('enabled')
      expect(server).toHaveProperty('createdAt')
      expect(server).toHaveProperty('updatedAt')
      expect(server?.id).toBe(serverId)
      expect(server?.name).toBe('Test HTTP Server')
      expect(server?.url).toBe('https://api.example.com')
      expect(server?.enabled).toBe(1)
    })
  })
})

// ============================================================================
// PROMPTS TESTS
// ============================================================================

describe('Prompts DAL', () => {
  beforeEach(async () => {
    // Clean up prompts and chat tables before each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
    await db.delete(promptsTable)
    await db.delete(modelsTable)
  })

  afterEach(async () => {
    // Clean up prompts and chat tables after each test
    const db = DatabaseSingleton.instance.db
    await db.delete(chatMessagesTable)
    await db.delete(chatThreadsTable)
    await db.delete(promptsTable)
    await db.delete(modelsTable)
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

      // Create a model first to satisfy foreign key constraint
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values({
        id: promptId1,
        prompt: 'First prompt',
        title: 'Prompt 1',
        modelId: modelId,
      })

      await db.insert(promptsTable).values({
        id: promptId2,
        prompt: 'Second prompt',
        title: 'Prompt 2',
        modelId: modelId,
      })

      const prompts = await getAllPrompts()
      expect(prompts).toHaveLength(2)
      expect(prompts.map((p) => p.id)).toContain(promptId1)
      expect(prompts.map((p) => p.id)).toContain(promptId2)
    })

    it('should filter by search query when provided', async () => {
      const db = DatabaseSingleton.instance.db
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()
      const modelId = uuidv7()

      // Create a model first to satisfy foreign key constraint
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values({
        id: promptId1,
        prompt: 'Hello world prompt',
        title: 'Greeting',
        modelId: modelId,
      })

      await db.insert(promptsTable).values({
        id: promptId2,
        prompt: 'Goodbye world prompt',
        title: 'Farewell',
        modelId: modelId,
      })

      const prompts = await getAllPrompts('hello')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.id).toBe(promptId1)
      expect(prompts[0]?.prompt).toBe('Hello world prompt')
    })

    it('should limit results to 50 prompts', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      // Create a model first to satisfy foreign key constraint
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create 60 prompts
      for (let i = 0; i < 60; i++) {
        await db.insert(promptsTable).values({
          id: uuidv7(),
          prompt: `Prompt ${i}`,
          title: `Name ${i}`,
          modelId: modelId,
        })
      }

      const prompts = await getAllPrompts()
      expect(prompts).toHaveLength(50)
    })
  })

  describe('getTriggerPromptForThread', () => {
    it('should return null when thread does not exist', async () => {
      const threadId = uuidv7()
      const result = await getTriggerPromptForThread(threadId)
      expect(result).toBe(null)
    })

    it('should return null when thread was not triggered by automation', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId = uuidv7()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Regular Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 0,
        triggeredBy: null,
      })

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(false)
      expect(result?.isAutomationDeleted).toBe(false)
      expect(result?.prompt).toBe(null)
    })

    it('should return automation info when thread was triggered by automation', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId = uuidv7()
      const promptId = uuidv7()
      const modelId = uuidv7()

      // Create a model first to satisfy foreign key constraint
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create a prompt
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test automation prompt',
        title: 'Test Automation',
        modelId: modelId,
      })

      // Create a thread triggered by automation
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Automated Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 1,
        triggeredBy: promptId,
      })

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(true)
      expect(result?.isAutomationDeleted).toBe(false)
      expect(result?.prompt).toBeDefined()
      expect(result?.prompt?.id).toBe(promptId)
      expect(result?.prompt?.title).toBe('Test Automation')
    })

    it('should indicate deleted automation when prompt no longer exists', async () => {
      const db = DatabaseSingleton.instance.db
      const threadId = uuidv7()
      const promptId = uuidv7()
      const modelId = uuidv7()

      // Create a model first to satisfy foreign key constraint
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create a prompt first, then delete it to simulate deleted automation
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test automation prompt',
        title: 'Test Automation',
        modelId: modelId,
      })

      // Create a thread triggered by automation
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Automated Thread',
        isEncrypted: 0,
        wasTriggeredByAutomation: 1,
        triggeredBy: promptId,
      })

      // Delete the prompt to simulate deleted automation
      await db.delete(promptsTable).where(eq(promptsTable.id, promptId))

      const result = await getTriggerPromptForThread(threadId)
      expect(result).not.toBe(null)
      expect(result?.wasTriggeredByAutomation).toBe(true)
      expect(result?.isAutomationDeleted).toBe(true)
      expect(result?.prompt).toBe(null)
    })
  })
})
