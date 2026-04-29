/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modelsTable, promptsTable, triggersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createTrigger,
  deleteTriggersForPrompt,
  deleteTriggersForPrompts,
  getAllEnabledTriggers,
  getAllTriggersForPrompt,
} from './triggers'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Triggers DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getAllTriggersForPrompt', () => {
    it('should return empty array when no triggers exist for prompt', async () => {
      const triggers = await getAllTriggersForPrompt(getDb(), 'non-existent-prompt-id')
      expect(triggers).toHaveLength(0)
    })

    it('should return all triggers for a prompt', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await db.insert(triggersTable).values([
        { id: triggerId1, promptId, triggerType: 'time', triggerTime: '09:00', isEnabled: 1 },
        { id: triggerId2, promptId, triggerType: 'time', triggerTime: '18:00', isEnabled: 0 },
      ])

      const triggers = await getAllTriggersForPrompt(getDb(), promptId)
      expect(triggers).toHaveLength(2)
      expect(triggers.map((t) => t.id).sort()).toEqual([triggerId1, triggerId2].sort())
    })

    it('should only return triggers for the specified prompt', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
      ])

      await db.insert(triggersTable).values([
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '09:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '10:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId2, triggerType: 'time', triggerTime: '11:00', isEnabled: 1 },
      ])

      const triggersForPrompt1 = await getAllTriggersForPrompt(getDb(), promptId1)
      const triggersForPrompt2 = await getAllTriggersForPrompt(getDb(), promptId2)

      expect(triggersForPrompt1).toHaveLength(2)
      expect(triggersForPrompt2).toHaveLength(1)
    })
  })

  describe('getAllEnabledTriggers', () => {
    it('should return empty array when no triggers exist', async () => {
      const triggers = await getAllEnabledTriggers(getDb())
      expect(triggers).toHaveLength(0)
    })

    it('should return only enabled triggers', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const enabledTriggerId = uuidv7()
      const disabledTriggerId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await db.insert(triggersTable).values([
        { id: enabledTriggerId, promptId, triggerType: 'time', triggerTime: '09:00', isEnabled: 1 },
        { id: disabledTriggerId, promptId, triggerType: 'time', triggerTime: '18:00', isEnabled: 0 },
      ])

      const triggers = await getAllEnabledTriggers(getDb())
      expect(triggers).toHaveLength(1)
      expect(triggers[0]?.id).toBe(enabledTriggerId)
    })

    it('should return enabled triggers from multiple prompts', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
      ])

      await db.insert(triggersTable).values([
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '09:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '10:00', isEnabled: 0 },
        { id: uuidv7(), promptId: promptId2, triggerType: 'time', triggerTime: '11:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId2, triggerType: 'time', triggerTime: '12:00', isEnabled: 1 },
      ])

      const triggers = await getAllEnabledTriggers(getDb())
      expect(triggers).toHaveLength(3)
      expect(triggers.every((t) => t.isEnabled === 1)).toBe(true)
    })

    it('should return empty array when all triggers are disabled', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await db.insert(triggersTable).values([
        { id: uuidv7(), promptId, triggerType: 'time', triggerTime: '09:00', isEnabled: 0 },
        { id: uuidv7(), promptId, triggerType: 'time', triggerTime: '18:00', isEnabled: 0 },
      ])

      const triggers = await getAllEnabledTriggers(getDb())
      expect(triggers).toHaveLength(0)
    })
  })

  describe('deleteTriggersForPrompt', () => {
    it('should soft delete all triggers for a prompt (set deletedAt)', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()

      // Create model and prompt first
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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      // Create triggers for the prompt
      await db.insert(triggersTable).values([
        {
          id: triggerId1,
          promptId: promptId,
          triggerType: 'time',
          triggerTime: '09:00',
          isEnabled: 1,
        },
        {
          id: triggerId2,
          promptId: promptId,
          triggerType: 'time',
          triggerTime: '18:00',
          isEnabled: 1,
        },
      ])

      // Verify triggers exist via DAL method
      const triggersBefore = await getAllTriggersForPrompt(getDb(), promptId)
      expect(triggersBefore).toHaveLength(2)

      await deleteTriggersForPrompt(getDb(), promptId)

      // Verify triggers are soft deleted (not returned by DAL)
      const triggersAfter = await getAllTriggersForPrompt(getDb(), promptId)
      expect(triggersAfter).toHaveLength(0)

      // Should still exist in database with deletedAt set (select by id; promptId is cleared by soft delete)
      const rawTriggers = await db
        .select()
        .from(triggersTable)
        .where(inArray(triggersTable.id, [triggerId1, triggerId2]))
      expect(rawTriggers).toHaveLength(2)
      expect(rawTriggers.every((t) => t.deletedAt !== null)).toBe(true)
    })

    it('should only soft delete triggers for the specified prompt', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()

      // Create model and prompts
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
      ])

      // Create triggers for different prompts
      await db.insert(triggersTable).values([
        {
          id: triggerId1,
          promptId: promptId1,
          triggerType: 'time',
          triggerTime: '09:00',
          isEnabled: 1,
        },
        {
          id: triggerId2,
          promptId: promptId2,
          triggerType: 'time',
          triggerTime: '18:00',
          isEnabled: 1,
        },
      ])

      await deleteTriggersForPrompt(getDb(), promptId1)

      // Verify only triggers for promptId1 are soft deleted
      const triggersForPrompt1 = await getAllTriggersForPrompt(getDb(), promptId1)
      const triggersForPrompt2 = await getAllTriggersForPrompt(getDb(), promptId2)

      expect(triggersForPrompt1).toHaveLength(0)
      expect(triggersForPrompt2).toHaveLength(1)
      expect(triggersForPrompt2[0]?.id).toBe(triggerId2)

      // Both should still exist in database
      const rawTriggers = await db.select().from(triggersTable)
      expect(rawTriggers).toHaveLength(2)
    })

    it('should not throw when no triggers exist for prompt', async () => {
      await expect(deleteTriggersForPrompt(getDb(), 'non-existent-prompt-id')).resolves.toBeUndefined()
    })

    it('should handle prompt with no triggers', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()

      // Create model and prompt without triggers
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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      // Should not throw
      await expect(deleteTriggersForPrompt(getDb(), promptId)).resolves.toBeUndefined()
    })

    it('should not return soft-deleted triggers via getAllEnabledTriggers', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await db.insert(triggersTable).values({
        id: triggerId,
        promptId: promptId,
        triggerType: 'time',
        triggerTime: '09:00',
        isEnabled: 1,
      })

      // Verify trigger exists in enabled triggers
      const enabledBefore = await getAllEnabledTriggers(getDb())
      expect(enabledBefore).toHaveLength(1)

      await deleteTriggersForPrompt(getDb(), promptId)

      // Verify trigger is not returned after soft deletion
      const enabledAfter = await getAllEnabledTriggers(getDb())
      expect(enabledAfter).toHaveLength(0)
    })

    it('should preserve original deletedAt datetimes for already-deleted triggers', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      // Create one already-deleted trigger and one active trigger
      await db.insert(triggersTable).values([
        {
          id: triggerId1,
          promptId: promptId,
          triggerType: 'time',
          triggerTime: '09:00',
          isEnabled: 1,
          deletedAt: originalDeletedAt, // Already deleted
        },
        {
          id: triggerId2,
          promptId: promptId,
          triggerType: 'time',
          triggerTime: '18:00',
          isEnabled: 1,
          deletedAt: null, // Active
        },
      ])

      await deleteTriggersForPrompt(getDb(), promptId)

      // Verify original deletedAt is preserved for already-deleted trigger
      const rawTriggers = await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId))
      const alreadyDeletedTrigger = rawTriggers.find((t) => t.id === triggerId1)
      const newlyDeletedTrigger = rawTriggers.find((t) => t.id === triggerId2)

      expect(alreadyDeletedTrigger?.deletedAt).toBe(originalDeletedAt)
      expect(newlyDeletedTrigger?.deletedAt).not.toBe(originalDeletedAt)
      expect(newlyDeletedTrigger?.deletedAt).not.toBeNull()
    })
  })

  describe('deleteTriggersForPrompts', () => {
    it('should soft delete triggers for multiple prompts in a single query', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()
      const promptId3 = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
        { id: promptId3, prompt: 'Prompt 3', modelId: modelId },
      ])

      await db.insert(triggersTable).values([
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '09:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId1, triggerType: 'time', triggerTime: '10:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId2, triggerType: 'time', triggerTime: '11:00', isEnabled: 1 },
        { id: uuidv7(), promptId: promptId3, triggerType: 'time', triggerTime: '12:00', isEnabled: 1 },
      ])

      // Delete triggers for prompts 1 and 2 only
      await deleteTriggersForPrompts(getDb(), [promptId1, promptId2])

      // Verify triggers for prompts 1 and 2 are soft-deleted
      const triggersForPrompt1 = await getAllTriggersForPrompt(getDb(), promptId1)
      const triggersForPrompt2 = await getAllTriggersForPrompt(getDb(), promptId2)
      const triggersForPrompt3 = await getAllTriggersForPrompt(getDb(), promptId3)

      expect(triggersForPrompt1).toHaveLength(0)
      expect(triggersForPrompt2).toHaveLength(0)
      expect(triggersForPrompt3).toHaveLength(1) // Prompt 3 triggers should remain

      // All triggers should still exist in database
      const rawTriggers = await db.select().from(triggersTable)
      expect(rawTriggers).toHaveLength(4)

      // Three should have deletedAt set
      const deletedTriggers = rawTriggers.filter((t) => t.deletedAt !== null)
      expect(deletedTriggers).toHaveLength(3)
    })

    it('should handle empty array without errors', async () => {
      await expect(deleteTriggersForPrompts(getDb(), [])).resolves.toBeUndefined()
    })

    it('should handle non-existent prompt IDs without errors', async () => {
      await expect(deleteTriggersForPrompts(getDb(), ['non-existent-1', 'non-existent-2'])).resolves.toBeUndefined()
    })

    it('should preserve original deletedAt datetimes for already-deleted triggers', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId1 = uuidv7()
      const promptId2 = uuidv7()
      const triggerId1 = uuidv7()
      const triggerId2 = uuidv7()
      const originalDeletedAt = '2024-01-15T12:00:00.000Z'

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(promptsTable).values([
        { id: promptId1, prompt: 'Prompt 1', modelId: modelId },
        { id: promptId2, prompt: 'Prompt 2', modelId: modelId },
      ])

      await db.insert(triggersTable).values([
        {
          id: triggerId1,
          promptId: promptId1,
          triggerType: 'time',
          triggerTime: '09:00',
          isEnabled: 1,
          deletedAt: originalDeletedAt, // Already deleted
        },
        {
          id: triggerId2,
          promptId: promptId2,
          triggerType: 'time',
          triggerTime: '10:00',
          isEnabled: 1,
          deletedAt: null, // Active
        },
      ])

      await deleteTriggersForPrompts(getDb(), [promptId1, promptId2])

      // Verify original deletedAt is preserved for already-deleted trigger
      const rawTriggers = await db.select().from(triggersTable)
      const alreadyDeletedTrigger = rawTriggers.find((t) => t.id === triggerId1)
      const newlyDeletedTrigger = rawTriggers.find((t) => t.id === triggerId2)

      expect(alreadyDeletedTrigger?.deletedAt).toBe(originalDeletedAt)
      expect(newlyDeletedTrigger?.deletedAt).not.toBe(originalDeletedAt)
      expect(newlyDeletedTrigger?.deletedAt).not.toBeNull()
    })
  })

  describe('createTrigger', () => {
    it('should create a new trigger', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await createTrigger(getDb(), {
        id: triggerId,
        triggerType: 'time',
        triggerTime: '09:00',
        promptId: promptId,
        isEnabled: 1,
      })

      const triggers = await db.select().from(triggersTable)
      expect(triggers).toHaveLength(1)
      expect(triggers[0]?.id).toBe(triggerId)
      expect(triggers[0]?.triggerTime).toBe('09:00')
    })

    it('should create multiple triggers for a prompt', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await createTrigger(getDb(), {
        id: uuidv7(),
        triggerType: 'time',
        triggerTime: '08:00',
        promptId: promptId,
        isEnabled: 1,
      })
      await createTrigger(getDb(), {
        id: uuidv7(),
        triggerType: 'time',
        triggerTime: '18:00',
        promptId: promptId,
        isEnabled: 1,
      })

      const triggers = await db.select().from(triggersTable)
      expect(triggers).toHaveLength(2)
    })

    it('should create a disabled trigger', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const promptId = uuidv7()
      const triggerId = uuidv7()

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
        prompt: 'Test prompt',
        modelId: modelId,
      })

      await createTrigger(getDb(), {
        id: triggerId,
        triggerType: 'time',
        triggerTime: '10:00',
        promptId: promptId,
        isEnabled: 0,
      })

      const trigger = await db.select().from(triggersTable).get()
      expect(trigger?.isEnabled).toBe(0)
    })
  })
})
