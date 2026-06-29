/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import {
  chatMessagesTable,
  chatThreadsTable,
  modelProfilesTable,
  modelsTable,
  promptsTable,
  triggersTable,
} from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { defaultModelOpus48, hashModel } from '@/defaults/models'
import { isModelModified } from '@/defaults/utils'
import type { Model } from '@/types'
import {
  createModel,
  deleteModel,
  getAllModels,
  getAvailableModels,
  getDefaultModelForThread,
  getModel,
  getSelectedModel,
  getSelectedModelQuery,
  getSystemModel,
  resetModelToDefault,
  updateModel,
} from './models'
import { getAllPrompts, getPrompt } from './prompts'
import { updateSettings } from './settings'
import { nowIso } from '@/lib/utils'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from './test-utils'
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
      const model = await getModel(getDb(), wsId, 'nonexistent-model-id')
      expect(model).toBe(null)
    })

    it('should return null when model ID is empty string', async () => {
      const model = await getModel(getDb(), wsId, '')
      expect(model).toBe(null)
    })

    it('should return model when it exists', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      const model = await getModel(getDb(), wsId, modelId)
      expect(model).not.toBe(null)
      expect(model?.id).toBe(modelId)
      expect(model?.name).toBe('Test Model')
    })

    it('should handle database drivers that return empty object for missing records', async () => {
      // This test verifies that .get() correctly returns undefined
      // instead of {} when no record is found
      const db = getDb()

      // Query a non-existent model directly with Drizzle
      const result = await db.select().from(modelsTable).where(eq(modelsTable.id, 'nonexistent')).get()

      // The result should be undefined (not an empty object)
      expect(result).toBeUndefined()
    })
  })

  describe('getSelectedModel', () => {
    it('should return system model when no selected_model setting exists', async () => {
      const db = getDb()

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      const model = await getSelectedModel(getDb(), wsId)
      expect(model.id).toBe(systemModelId)
      expect(model.name).toBe('System Model')
      expect(model.isSystem).toBe(1)
    })

    it('should return selected model when selected_model setting exists', async () => {
      const db = getDb()

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
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
        workspaceId: wsId,
      })

      // Set the selected model
      await updateSettings(getDb(), { selected_model: selectedModelId })

      const model = await getSelectedModel(getDb(), wsId)
      expect(model.id).toBe(selectedModelId)
      expect(model.name).toBe('Selected Model')
    })

    it('should fall back to system model when selected model is disabled', async () => {
      const db = getDb()

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
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
        workspaceId: wsId,
      })

      // Set the disabled model as selected
      await updateSettings(getDb(), { selected_model: disabledModelId })

      // Should fall back to system model since selected model is disabled
      const model = await getSelectedModel(getDb(), wsId)
      expect(model.id).toBe(systemModelId)
      expect(model.name).toBe('System Model')
      expect(model.isSystem).toBe(1)
    })
  })

  describe('getSelectedModelQuery', () => {
    it('should return same result as getSelectedModel', async () => {
      const db = getDb()

      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      const selectedModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: selectedModelId,
        provider: 'openai',
        name: 'Selected Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await updateSettings(getDb(), { selected_model: selectedModelId })

      const asyncResult = await getSelectedModel(getDb(), wsId)
      const queryResult = await getSelectedModelQuery(getDb(), wsId).all()
      const queryModel = queryResult[0] ? (queryResult[0] as Model) : undefined

      expect(queryModel?.id).toBe(asyncResult.id)
      expect(queryModel?.name).toBe(asyncResult.name)
    })

    it('should fall back to system model when selected model is disabled', async () => {
      const db = getDb()

      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      const disabledModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: disabledModelId,
        provider: 'thunderbolt',
        name: 'Disabled Model',
        model: 'mistral-large-3',
        isSystem: 0,
        enabled: 0,
        workspaceId: wsId,
      })

      await updateSettings(getDb(), { selected_model: disabledModelId })

      const queryResult = await getSelectedModelQuery(getDb(), wsId).all()
      const queryModel = queryResult[0] ? (queryResult[0] as Model) : undefined

      expect(queryModel?.id).toBe(systemModelId)
      expect(queryModel?.name).toBe('System Model')
    })
  })

  describe('getAllModels', () => {
    it('should return empty array when no models exist', async () => {
      const models = await getAllModels(getDb(), wsId)
      expect(models).toEqual([])
    })

    it('should return all models', async () => {
      const db = getDb()
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
          workspaceId: wsId,
        },
        {
          id: modelId2,
          provider: 'thunderbolt',
          name: 'Model 2',
          model: 'gpt-oss-120b',
          isSystem: 1,
          enabled: 0,
          workspaceId: wsId,
        },
      ])

      const models = await getAllModels(getDb(), wsId)
      expect(models).toHaveLength(2)
      expect(models.map((m) => m.id)).toContain(modelId1)
      expect(models.map((m) => m.id)).toContain(modelId2)
    })
  })

  describe('getAvailableModels', () => {
    it('should return empty array when no enabled models exist', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Disabled Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 0,
        workspaceId: wsId,
      })

      const models = await getAvailableModels(getDb(), wsId)
      expect(models).toEqual([])
    })

    it('should return only enabled models', async () => {
      const db = getDb()
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
          workspaceId: wsId,
        },
        {
          id: disabledModelId,
          provider: 'anthropic',
          name: 'Disabled Model',
          model: 'claude-3-5-sonnet-20241022',
          isSystem: 1,
          enabled: 0,
          workspaceId: wsId,
        },
      ])

      const models = await getAvailableModels(getDb(), wsId)
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe(enabledModelId)
    })
  })

  describe('getSystemModel', () => {
    it('should return null when no system model exists', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Non-System Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      const systemModel = await getSystemModel(getDb(), wsId)
      expect(systemModel).toBe(null)
    })

    it('should return the system model when it exists', async () => {
      const db = getDb()
      const systemModelId = uuidv7()

      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      const systemModel = await getSystemModel(getDb(), wsId)
      expect(systemModel).not.toBe(null)
      expect(systemModel?.id).toBe(systemModelId)
      expect(systemModel?.isSystem).toBe(1)
    })
  })

  describe('getDefaultModelForThread', () => {
    it('should fall back to system model when thread has no messages', async () => {
      const db = getDb()

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      // Create an empty thread
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        workspaceId: wsId,
      })

      const model = await getDefaultModelForThread(getDb(), wsId, threadId)
      expect(model.id).toBe(systemModelId)
    })

    it('should return last message model when thread has messages', async () => {
      const db = getDb()

      // Create models
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
      })

      const lastUsedModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: lastUsedModelId,
        provider: 'openai',
        name: 'Last Used Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      // Create thread with message
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        workspaceId: wsId,
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Hello',
        modelId: lastUsedModelId,
        workspaceId: wsId,
      })

      const model = await getDefaultModelForThread(getDb(), wsId, threadId)
      expect(model.id).toBe(lastUsedModelId)
    })

    it('should fall back correctly when last message model is deleted', async () => {
      const db = getDb()

      // Create a system model
      const systemModelId = uuidv7()
      await db.insert(modelsTable).values({
        id: systemModelId,
        provider: 'thunderbolt',
        name: 'System Model',
        model: 'gpt-oss-120b',
        isSystem: 1,
        enabled: 1,
        workspaceId: wsId,
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
        workspaceId: wsId,
      })

      // Create thread with message
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
        workspaceId: wsId,
      })

      await db.insert(chatMessagesTable).values({
        id: uuidv7(),
        chatThreadId: threadId,
        role: 'assistant',
        content: 'Hello',
        modelId: deletedModelId,
        workspaceId: wsId,
      })

      // Delete the model (simulating a model that no longer exists)
      await db.delete(chatMessagesTable)
      await db.delete(modelsTable).where(eq(modelsTable.id, deletedModelId))

      // Should fall back to system model when the last message's model doesn't exist
      const model = await getDefaultModelForThread(getDb(), wsId, threadId)
      expect(model.id).toBe(systemModelId)
    })
  })

  describe('deleteModel', () => {
    it('should soft delete a model by id (set deletedAt)', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      // Verify model exists
      const modelBefore = await getModel(getDb(), wsId, modelId)
      expect(modelBefore).not.toBe(null)

      await deleteModel(getDb(), wsId, modelId)

      // Verify model is soft deleted (not returned by getModel)
      const modelAfter = await getModel(getDb(), wsId, modelId)
      expect(modelAfter).toBe(null)

      // But should still exist in database with deletedAt set
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel).not.toBeUndefined()
      expect(rawModel?.deletedAt).not.toBeNull()
    })

    it('should not throw when deleting non-existent model', async () => {
      await expect(deleteModel(getDb(), wsId, 'non-existent-id')).resolves.toBeUndefined()
    })

    it('should only soft delete the specified model', async () => {
      const db = getDb()
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
          workspaceId: wsId,
        },
        {
          id: modelId2,
          provider: 'anthropic',
          name: 'Model 2',
          model: 'claude-3',
          isSystem: 0,
          enabled: 1,
          workspaceId: wsId,
        },
      ])

      await deleteModel(getDb(), wsId, modelId1)

      // Verify only model 1 is soft deleted
      const model1 = await getModel(getDb(), wsId, modelId1)
      const model2 = await getModel(getDb(), wsId, modelId2)
      expect(model1).toBe(null)
      expect(model2).not.toBe(null)

      // Both should still exist in database
      const rawModels = await db.select().from(modelsTable)
      expect(rawModels).toHaveLength(2)
    })

    it('should not return soft-deleted model via getAllModels', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      // Verify model exists
      const modelsBefore = await getAllModels(getDb(), wsId)
      expect(modelsBefore).toHaveLength(1)

      await deleteModel(getDb(), wsId, modelId)

      // Verify model is not returned by getAllModels
      const modelsAfter = await getAllModels(getDb(), wsId)
      expect(modelsAfter).toHaveLength(0)
    })

    it('should not return soft-deleted model via getAvailableModels', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      // Verify model exists
      const modelsBefore = await getAvailableModels(getDb(), wsId)
      expect(modelsBefore).toHaveLength(1)

      await deleteModel(getDb(), wsId, modelId)

      // Verify model is not returned by getAvailableModels
      const modelsAfter = await getAvailableModels(getDb(), wsId)
      expect(modelsAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetime for already-deleted model', async () => {
      const db = getDb()
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
        workspaceId: wsId,
      })

      // Call delete again on already-deleted model
      await deleteModel(getDb(), wsId, modelId)

      // Verify original deletedAt is preserved
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel?.deletedAt).toBe(originalDeletedAt)
    })

    it('should soft-delete prompts that reference the model (cascade)', async () => {
      const db = getDb()
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
        workspaceId: wsId,
      })

      // Create prompt referencing this model
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test prompt',
        modelId: modelId,
        workspaceId: wsId,
      })

      // Verify prompt exists
      const promptBefore = await getPrompt(getDb(), wsId, promptId)
      expect(promptBefore).not.toBe(null)

      // Delete the model
      await deleteModel(getDb(), wsId, modelId)

      // Verify prompt is soft-deleted (not returned by getPrompt)
      const promptAfter = await getPrompt(getDb(), wsId, promptId)
      expect(promptAfter).toBe(null)

      // But prompt should still exist in database with deletedAt set
      const rawPrompt = await db.select().from(promptsTable).where(eq(promptsTable.id, promptId)).get()
      expect(rawPrompt).not.toBeUndefined()
      expect(rawPrompt?.deletedAt).not.toBeNull()
    })

    it('should soft-delete triggers of prompts that reference the model (cascade)', async () => {
      const db = getDb()
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
        workspaceId: wsId,
      })

      // Create prompt referencing this model
      await db.insert(promptsTable).values({
        id: promptId,
        prompt: 'Test prompt',
        modelId: modelId,
        workspaceId: wsId,
      })

      // Create trigger for this prompt
      await db.insert(triggersTable).values({
        id: triggerId,
        triggerType: 'time',
        triggerTime: '09:00',
        promptId: promptId,
        isEnabled: 1,
        workspaceId: wsId,
      })

      // Verify trigger exists and is enabled
      const triggersBefore = await getAllEnabledTriggers(getDb(), wsId)
      expect(triggersBefore).toHaveLength(1)

      // Delete the model
      await deleteModel(getDb(), wsId, modelId)

      // Verify trigger is soft-deleted (not returned by getAllEnabledTriggers)
      const triggersAfter = await getAllEnabledTriggers(getDb(), wsId)
      expect(triggersAfter).toHaveLength(0)

      // But trigger should still exist in database with deletedAt set
      const rawTrigger = await db.select().from(triggersTable).where(eq(triggersTable.id, triggerId)).get()
      expect(rawTrigger).not.toBeUndefined()
      expect(rawTrigger?.deletedAt).not.toBeNull()
    })

    it('should not affect prompts referencing other models (cascade only targets matching modelId)', async () => {
      const db = getDb()
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      // Create two models
      await db.insert(modelsTable).values([
        {
          id: modelId1,
          provider: 'openai',
          name: 'Model 1',
          model: 'gpt-4',
          isSystem: 0,
          enabled: 1,
          workspaceId: wsId,
        },
        {
          id: modelId2,
          provider: 'anthropic',
          name: 'Model 2',
          model: 'claude-3',
          isSystem: 0,
          enabled: 1,
          workspaceId: wsId,
        },
      ])

      // Create prompts referencing different models
      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt for model 1', modelId: modelId1, workspaceId: wsId },
        { id: promptId2, prompt: 'Prompt for model 2', modelId: modelId2, workspaceId: wsId },
      ])

      // Delete only model 1
      await deleteModel(getDb(), wsId, modelId1)

      // Verify only prompt 1 is soft-deleted
      const prompt1 = await getPrompt(getDb(), wsId, promptId1)
      const prompt2 = await getPrompt(getDb(), wsId, promptId2)
      expect(prompt1).toBe(null)
      expect(prompt2).not.toBe(null)
    })

    it('should handle model with multiple prompts and triggers (full cascade)', async () => {
      const db = getDb()
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
        workspaceId: wsId,
      })

      // Create two prompts referencing this model
      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId, workspaceId: wsId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId, workspaceId: wsId },
      ])

      // Create multiple triggers for these prompts
      await db.insert(triggersTable).values([
        {
          id: triggerId1,
          triggerType: 'time',
          triggerTime: '09:00',
          promptId: promptId1,
          isEnabled: 1,
          workspaceId: wsId,
        },
        {
          id: triggerId2,
          triggerType: 'time',
          triggerTime: '12:00',
          promptId: promptId1,
          isEnabled: 1,
          workspaceId: wsId,
        },
        {
          id: triggerId3,
          triggerType: 'time',
          triggerTime: '18:00',
          promptId: promptId2,
          isEnabled: 1,
          workspaceId: wsId,
        },
      ])

      // Verify all entities exist
      const promptsBefore = await getAllPrompts(getDb(), wsId)
      const triggersBefore = await getAllEnabledTriggers(getDb(), wsId)
      expect(promptsBefore).toHaveLength(2)
      expect(triggersBefore).toHaveLength(3)

      // Delete the model
      await deleteModel(getDb(), wsId, modelId)

      // Verify all prompts are soft-deleted
      const promptsAfter = await getAllPrompts(getDb(), wsId)
      expect(promptsAfter).toHaveLength(0)

      // Verify all triggers are soft-deleted
      const triggersAfter = await getAllEnabledTriggers(getDb(), wsId)
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
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Original Name',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await updateModel(getDb(), wsId, modelId, { name: 'Updated Name' })

      const model = await getModel(getDb(), wsId, modelId)
      expect(model?.name).toBe('Updated Name')
    })

    it('should update model enabled status', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await updateModel(getDb(), wsId, modelId, { enabled: 0 })

      // Model should no longer appear in available models
      const availableModels = await getAvailableModels(getDb(), wsId)
      expect(availableModels.map((m) => m.id)).not.toContain(modelId)
    })

    it('should soft delete model by setting deletedAt', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model to soft delete',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await updateModel(getDb(), wsId, modelId, { deletedAt: nowIso() })

      // Model should no longer be returned by getModel
      const model = await getModel(getDb(), wsId, modelId)
      expect(model).toBe(null)

      // Model should still exist in database
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel).not.toBeUndefined()
      expect(rawModel?.deletedAt).not.toBeNull()
    })

    it('should update multiple fields at once', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Original',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await updateModel(getDb(), wsId, modelId, { name: 'Updated', provider: 'anthropic', model: 'claude-3' })

      const model = await getModel(getDb(), wsId, modelId)
      expect(model?.name).toBe('Updated')
      expect(model?.provider).toBe('anthropic')
      expect(model?.model).toBe('claude-3')
    })

    it('should not throw when updating non-existent model', async () => {
      await expect(updateModel(getDb(), wsId, 'non-existent-id', { name: 'test' })).resolves.toBeUndefined()
    })

    it('should not update defaultHash field', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        defaultHash: 'original-hash',
        workspaceId: wsId,
      })

      // Try to update defaultHash (should be ignored)
      await updateModel(getDb(), wsId, modelId, { name: 'Updated', defaultHash: 'new-hash' } as Parameters<
        typeof updateModel
      >[3])

      // Verify defaultHash was not changed
      const rawModel = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(rawModel?.defaultHash).toBe('original-hash')
      expect(rawModel?.name).toBe('Updated')
    })
  })

  describe('resetModelToDefault', () => {
    it('restores default fields and refreshes defaultHash', async () => {
      const db = getDb()
      const defaultModel = defaultModelOpus48

      await db.insert(modelsTable).values({
        ...defaultModel,
        workspaceId: wsId,
        name: 'User Edited Name',
        enabled: 0,
        defaultHash: 'stale-from-an-older-era',
      })

      const before = (await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()) as Model
      expect(isModelModified(before)).toBe(true)

      await resetModelToDefault(getDb(), wsId, defaultModel.id, defaultModel)

      const after = (await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()) as Model
      expect(after.name).toBe(defaultModel.name)
      expect(after.enabled).toBe(defaultModel.enabled)
      expect(after.defaultHash).toBe(hashModel(defaultModel))
      expect(isModelModified(after)).toBe(false)
    })

    it('clears the api key on reset', async () => {
      const db = getDb()
      const defaultModel = defaultModelOpus48

      await db.insert(modelsTable).values({ ...defaultModel, workspaceId: wsId, apiKey: 'sk-user-supplied' })

      await resetModelToDefault(getDb(), wsId, defaultModel.id, defaultModel)

      const after = (await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()) as Model
      expect(after.apiKey).toBeNull()
    })

    it('preserves the row userId (does not overwrite with null from the default template)', async () => {
      const db = getDb()
      const defaultModel = defaultModelOpus48

      // The default template carries `userId: null`. A row that has already
      // been synced has a real user_id — reset must not overwrite it, otherwise
      // PowerSync queues a `{ user_id: null }` PATCH that the upload handler
      // rejects (it strips user_id, leaving an empty payload → 400).
      await db.insert(modelsTable).values({ ...defaultModel, workspaceId: wsId, userId: 'real-user-id' })

      await resetModelToDefault(getDb(), wsId, defaultModel.id, defaultModel)

      const after = (await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModel.id)).get()) as Model
      expect(after.userId).toBe('real-user-id')
    })
  })

  describe('createModel', () => {
    it('should create a new model', async () => {
      const modelId = uuidv7()

      await createModel(getDb(), wsId, {
        id: modelId,
        provider: 'openai',
        name: 'New Model',
        model: 'gpt-4',
        enabled: 1,
      })

      const model = await getModel(getDb(), wsId, modelId)
      expect(model).not.toBe(null)
      expect(model?.name).toBe('New Model')
      expect(model?.provider).toBe('openai')
    })

    it('should create a disabled model excluded from getAvailableModels', async () => {
      const modelId = uuidv7()

      await createModel(getDb(), wsId, {
        id: modelId,
        provider: 'anthropic',
        name: 'Disabled Model',
        model: 'claude-3',
        enabled: 0,
      })

      const availableModels = await getAvailableModels(getDb(), wsId)
      expect(availableModels.map((m) => m.id)).not.toContain(modelId)

      const allModels = await getAllModels(getDb(), wsId)
      expect(allModels.map((m) => m.id)).toContain(modelId)
    })

    it('should create multiple models', async () => {
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()

      await createModel(getDb(), wsId, {
        id: modelId1,
        provider: 'openai',
        name: 'Model 1',
        model: 'gpt-4',
        enabled: 1,
      })
      await createModel(getDb(), wsId, {
        id: modelId2,
        provider: 'anthropic',
        name: 'Model 2',
        model: 'claude-3',
        enabled: 1,
      })

      const models = await getAllModels(getDb(), wsId)
      expect(models).toHaveLength(2)
    })
  })

  describe('createModel auto-profile', () => {
    it('should auto-create a default profile for a known seeded model', async () => {
      const db = getDb()

      // Create a model with the same ID as a seeded default (GPT-OSS)
      await createModel(getDb(), wsId, {
        id: defaultModelOpus48.id,
        provider: 'thunderbolt',
        name: 'Opus 4.8',
        model: 'opus-4.8',
      })

      // Verify a profile was auto-created
      const profile = await db
        .select()
        .from(modelProfilesTable)
        .where(eq(modelProfilesTable.modelId, defaultModelOpus48.id))
        .get()
      expect(profile).not.toBeUndefined()
      expect(profile?.temperature).toBe(0.2)
    })

    it('should not create a profile for an unknown model ID', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(getDb(), wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Unknown Model',
        model: 'gpt-4',
      })

      const profile = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, modelId)).get()
      expect(profile).toBeUndefined()
    })
  })

  describe('apiKey on models', () => {
    it('stores apiKey directly on the models row when creating with one', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Model with key',
        model: 'gpt-4',
        apiKey: 'sk-test-key',
      })

      const stored = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(stored?.apiKey).toBe('sk-test-key')
    })

    it('leaves apiKey null when omitted', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'thunderbolt',
        name: 'No key model',
        model: 'gpt-oss-120b',
      })

      const model = await getModel(db, wsId, modelId)
      expect(model?.apiKey).toBeNull()
    })

    it('returns apiKey via getModel without any join', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Model with key',
        model: 'gpt-4',
        apiKey: 'sk-direct',
      })

      const model = await getModel(db, wsId, modelId)
      expect(model?.apiKey).toBe('sk-direct')
    })

    it('updateModel replaces apiKey in place', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
      })

      await updateModel(db, wsId, modelId, { apiKey: 'sk-first' })
      let model = await getModel(db, wsId, modelId)
      expect(model?.apiKey).toBe('sk-first')

      await updateModel(db, wsId, modelId, { apiKey: 'sk-second' })
      model = await getModel(db, wsId, modelId)
      expect(model?.apiKey).toBe('sk-second')
    })

    it('updateModel can clear apiKey by passing null', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        apiKey: 'sk-initial',
      })

      await updateModel(db, wsId, modelId, { apiKey: null })

      const model = await getModel(db, wsId, modelId)
      expect(model?.apiKey).toBeNull()
    })

    it('soft-deleting a model clears its apiKey alongside the rest of the row', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await createModel(db, wsId, {
        id: modelId,
        provider: 'openai',
        name: 'Model to delete',
        model: 'gpt-4',
        apiKey: 'sk-to-delete',
      })

      await deleteModel(db, wsId, modelId)

      // deleteModel applies clearNullableColumns, which nulls every nullable
      // field on the soft-deleted row. apiKey is nullable → cleared.
      const after = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(after?.apiKey).toBeNull()
      expect(after?.deletedAt).not.toBeNull()
    })
  })

  describe('deleteModel profile cascade', () => {
    it('should soft-delete the model profile when deleting a model', async () => {
      const db = getDb()
      const modelId = uuidv7()

      // Create a model and manually insert a profile
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Model with profile',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })
      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        workspaceId: wsId,
      })

      // Verify profile exists
      const profileBefore = await db
        .select()
        .from(modelProfilesTable)
        .where(eq(modelProfilesTable.modelId, modelId))
        .get()
      expect(profileBefore?.deletedAt).toBeNull()

      // Delete the model
      await deleteModel(getDb(), wsId, modelId)

      // Verify profile is soft-deleted
      const profileAfter = await db
        .select()
        .from(modelProfilesTable)
        .where(eq(modelProfilesTable.modelId, modelId))
        .get()
      expect(profileAfter?.deletedAt).not.toBeNull()
    })
  })
})
