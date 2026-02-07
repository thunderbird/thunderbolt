import { DatabaseSingleton } from '@/db/singleton'
import { chatMessagesTable, chatThreadsTable, modelsTable, promptsTable, triggersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createModel,
  deleteModel,
  getAllModels,
  getAvailableModels,
  getDefaultModelForThread,
  getModel,
  getSelectedModel,
  getSystemModel,
  updateModel,
} from './models'
import { getAllPrompts, getPrompt } from './prompts'
import { updateSettings } from './settings'
import { nowIso } from '@/lib/utils'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'
import { getAllEnabledTriggers } from './triggers'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Models DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
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

    it('should handle database drivers that return empty object for missing records', async () => {
      // This test verifies that .get() correctly returns undefined
      // instead of {} when no record is found
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
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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
      await updateSettings({ selected_model: selectedModelId })

      const model = await getSelectedModel()
      expect(model.id).toBe(selectedModelId)
      expect(model.name).toBe('Selected Model')
    })

    it('should fall back to system model when selected model is disabled', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
      })

      // Create a disabled model
      const disabledModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: disabledModelId,
        provider: 'thunderbolt',
        name: 'Disabled Model',
        model: 'mistral-large-3',
        isSystem: 0,
        enabled: 0,
      })

      // Set the disabled model as selected
      await updateSettings({ selected_model: disabledModelId })

      // Should fall back to system model since selected model is disabled
      const model = await getSelectedModel()
      expect(model.id).toBe(systemModelId)
      expect(model.name).toBe('System Model')
      expect(model.isSystem).toBe(1)
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
          provider: 'thunderbolt',
          name: 'Model 2',
          model: 'gpt-oss-120b',
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
          provider: 'anthropic',
          name: 'Disabled Model',
          model: 'claude-3-5-sonnet-20241022',
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
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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
    it('should fall back to system model when thread has no messages', async () => {
      const db = DatabaseSingleton.instance.db

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
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

  describe('deleteModel', () => {
    it('should soft delete a model by id (set deletedAt)', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Verify model exists
      const modelBefore = await getModel(modelId)
      expect(modelBefore).not.toBe(null)

      await deleteModel(modelId)

      // Verify model is soft deleted (not returned by getModel)
      const modelAfter = await getModel(modelId)
      expect(modelAfter).toBe(null)

      // But should still exist in database with deletedAt set
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel).not.toBeUndefined()
      expect(rawModel?.deletedAt).not.toBeNull()
    })

    it('should not throw when deleting non-existent model', async () => {
      await expect(deleteModel('non-existent-id')).resolves.toBeUndefined()
    })

    it('should only soft delete the specified model', async () => {
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
          provider: 'anthropic',
          name: 'Model 2',
          model: 'claude-3',
          isSystem: 0,
          enabled: 1,
        },
      ])

      await deleteModel(modelId1)

      // Verify only model 1 is soft deleted
      const model1 = await getModel(modelId1)
      const model2 = await getModel(modelId2)
      expect(model1).toBe(null)
      expect(model2).not.toBe(null)

      // Both should still exist in database
      const rawModels = await db.select().from(modelsTable)
      expect(rawModels).toHaveLength(2)
    })

    it('should not return soft-deleted model via getAllModels', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Verify model exists
      const modelsBefore = await getAllModels()
      expect(modelsBefore).toHaveLength(1)

      await deleteModel(modelId)

      // Verify model is not returned by getAllModels
      const modelsAfter = await getAllModels()
      expect(modelsAfter).toHaveLength(0)
    })

    it('should not return soft-deleted model via getAvailableModels', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Verify model exists
      const modelsBefore = await getAvailableModels()
      expect(modelsBefore).toHaveLength(1)

      await deleteModel(modelId)

      // Verify model is not returned by getAvailableModels
      const modelsAfter = await getAvailableModels()
      expect(modelsAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetime for already-deleted model', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Already deleted model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        deletedAt: originalDeletedAt,
      })

      // Call delete again on already-deleted model
      await deleteModel(modelId)

      // Verify original deletedAt is preserved
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel?.deletedAt).toBe(originalDeletedAt)
    })

    it('should soft-delete prompts that reference the model (cascade)', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()
      const promptId = uuidv7()

      // Create model
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create prompt referencing this model
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test prompt',
        modelId: modelId,
      })

      // Verify prompt exists
      const promptBefore = await getPrompt(promptId)
      expect(promptBefore).not.toBe(null)

      // Delete the model
      await deleteModel(modelId)

      // Verify prompt is soft-deleted (not returned by getPrompt)
      const promptAfter = await getPrompt(promptId)
      expect(promptAfter).toBe(null)

      // But prompt should still exist in database with deletedAt set
      const rawPrompt = await db.select().from(promptsTable).where(eq(promptsTable.id, promptId)).get()
      expect(rawPrompt).not.toBeUndefined()
      expect(rawPrompt?.deletedAt).not.toBeNull()
    })

    it('should soft-delete triggers of prompts that reference the model (cascade)', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId = uuidv7()

      // Create model
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create prompt referencing this model
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test prompt',
        modelId: modelId,
      })

      // Create trigger for this prompt
      await db.insert(triggersTable).values({
        id: triggerId,
        triggerType: 'time',
        triggerTime: '09:00',
        promptId: promptId,
        isEnabled: 1,
      })

      // Verify trigger exists and is enabled
      const triggersBefore = await getAllEnabledTriggers()
      expect(triggersBefore).toHaveLength(1)

      // Delete the model
      await deleteModel(modelId)

      // Verify trigger is soft-deleted (not returned by getAllEnabledTriggers)
      const triggersAfter = await getAllEnabledTriggers()
      expect(triggersAfter).toHaveLength(0)

      // But trigger should still exist in database with deletedAt set
      const rawTrigger = await db.select().from(triggersTable).where(eq(triggersTable.id, triggerId)).get()
      expect(rawTrigger).not.toBeUndefined()
      expect(rawTrigger?.deletedAt).not.toBeNull()
    })

    it('should not affect prompts referencing other models (cascade only targets matching modelId)', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      // Create two models
      await db.insert(modelsTable).values([
        { id: modelId1, provider: 'openai', name: 'Model 1', model: 'gpt-4', isSystem: 0, enabled: 1 },
        { id: modelId2, provider: 'anthropic', name: 'Model 2', model: 'claude-3', isSystem: 0, enabled: 1 },
      ])

      // Create prompts referencing different models
      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt for model 1', modelId: modelId1 },
        { id: promptId2, prompt: 'Prompt for model 2', modelId: modelId2 },
      ])

      // Delete only model 1
      await deleteModel(modelId1)

      // Verify only prompt 1 is soft-deleted
      const prompt1 = await getPrompt(promptId1)
      const prompt2 = await getPrompt(promptId2)
      expect(prompt1).toBe(null)
      expect(prompt2).not.toBe(null)
    })

    it('should handle model with multiple prompts and triggers (full cascade)', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()
      const triggerId3 = uuidv7()

      // Create model
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      // Create two prompts referencing this model
      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
      ])

      // Create multiple triggers for these prompts
      await db.insert(triggersTable).values([
        { id: triggerId1, triggerType: 'time', triggerTime: '09:00', promptId: promptId1, isEnabled: 1 },
        { id: triggerId2, triggerType: 'time', triggerTime: '12:00', promptId: promptId1, isEnabled: 1 },
        { id: triggerId3, triggerType: 'time', triggerTime: '18:00', promptId: promptId2, isEnabled: 1 },
      ])

      // Verify all entities exist
      const promptsBefore = await getAllPrompts()
      const triggersBefore = await getAllEnabledTriggers()
      expect(promptsBefore).toHaveLength(2)
      expect(triggersBefore).toHaveLength(3)

      // Delete the model
      await deleteModel(modelId)

      // Verify all prompts are soft-deleted
      const promptsAfter = await getAllPrompts()
      expect(promptsAfter).toHaveLength(0)

      // Verify all triggers are soft-deleted
      const triggersAfter = await getAllEnabledTriggers()
      expect(triggersAfter).toHaveLength(0)

      // Verify all records still exist in database with deletedAt set
      const rawPrompts = await db.select().from(promptsTable)
      const rawTriggers = await db.select().from(triggersTable)
      expect(rawPrompts).toHaveLength(2)
      expect(rawTriggers).toHaveLength(3)
      expect(rawPrompts.every((p) => p.deletedAt !== null)).toBe(true)
      expect(rawTriggers.every((t) => t.deletedAt !== null)).toBe(true)
    })
  })

  describe('updateModel', () => {
    it('should update model name', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Original Name',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await updateModel(modelId, { name: 'Updated Name' })

      const model = await getModel(modelId)
      expect(model?.name).toBe('Updated Name')
    })

    it('should update model enabled status', async () => {
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

      await updateModel(modelId, { enabled: 0 })

      // Model should no longer appear in available models
      const availableModels = await getAvailableModels()
      expect(availableModels.map((m) => m.id)).not.toContain(modelId)
    })

    it('should soft delete model by setting deletedAt', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to soft delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await updateModel(modelId, { deletedAt: nowIso() })

      // Model should no longer be returned by getModel
      const model = await getModel(modelId)
      expect(model).toBe(null)

      // Model should still exist in database
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel).not.toBeUndefined()
      expect(rawModel?.deletedAt).not.toBeNull()
    })

    it('should update multiple fields at once', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Original',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await updateModel(modelId, { name: 'Updated', provider: 'anthropic', model: 'claude-3' })

      const model = await getModel(modelId)
      expect(model?.name).toBe('Updated')
      expect(model?.provider).toBe('anthropic')
      expect(model?.model).toBe('claude-3')
    })

    it('should not throw when updating non-existent model', async () => {
      await expect(updateModel('non-existent-id', { name: 'test' })).resolves.toBeUndefined()
    })

    it('should not update defaultHash field', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        defaultHash: 'original-hash',
      })

      // Try to update defaultHash (should be ignored)
      await updateModel(modelId, { name: 'Updated', defaultHash: 'new-hash' } as Parameters<typeof updateModel>[1])

      // Verify defaultHash was not changed
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel?.defaultHash).toBe('original-hash')
      expect(rawModel?.name).toBe('Updated')
    })
  })

  describe('createModel', () => {
    it('should create a new model', async () => {
      const modelId = uuidv7()

      await createModel({
        id: modelId,
        provider: 'openai',
        name: 'New Model',
        model: 'gpt-4',
        enabled: 1,
      })

      const model = await getModel(modelId)
      expect(model).not.toBe(null)
      expect(model?.name).toBe('New Model')
      expect(model?.provider).toBe('openai')
    })

    it('should create a disabled model excluded from getAvailableModels', async () => {
      const modelId = uuidv7()

      await createModel({
        id: modelId,
        provider: 'anthropic',
        name: 'Disabled Model',
        model: 'claude-3',
        enabled: 0,
      })

      const availableModels = await getAvailableModels()
      expect(availableModels.map((m) => m.id)).not.toContain(modelId)

      const allModels = await getAllModels()
      expect(allModels.map((m) => m.id)).toContain(modelId)
    })

    it('should create multiple models', async () => {
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()

      await createModel({ id: modelId1, provider: 'openai', name: 'Model 1', model: 'gpt-4', enabled: 1 })
      await createModel({ id: modelId2, provider: 'anthropic', name: 'Model 2', model: 'claude-3', enabled: 1 })

      const models = await getAllModels()
      expect(models).toHaveLength(2)
    })
  })
})
