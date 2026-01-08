import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable, promptsTable, triggersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createTrigger, deleteTriggersForPrompt, getAllEnabledTriggers, getAllTriggersForPrompt } from './triggers'
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
      const triggers = await getAllTriggersForPrompt('non-existent-prompt-id')
      expect(triggers).toHaveLength(0)
    })

    it('should return all triggers for a prompt', async () => {
      const db = DatabaseSingleton.instance.db
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

      const triggers = await getAllTriggersForPrompt(promptId)
      expect(triggers).toHaveLength(2)
      expect(triggers.map((t) => t.id).sort()).toEqual([triggerId1, triggerId2].sort())
    })

    it('should only return triggers for the specified prompt', async () => {
      const db = DatabaseSingleton.instance.db
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

      const triggersForPrompt1 = await getAllTriggersForPrompt(promptId1)
      const triggersForPrompt2 = await getAllTriggersForPrompt(promptId2)

      expect(triggersForPrompt1).toHaveLength(2)
      expect(triggersForPrompt2).toHaveLength(1)
    })
  })

  describe('getAllEnabledTriggers', () => {
    it('should return empty array when no triggers exist', async () => {
      const triggers = await getAllEnabledTriggers()
      expect(triggers).toHaveLength(0)
    })

    it('should return only enabled triggers', async () => {
      const db = DatabaseSingleton.instance.db
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

      const triggers = await getAllEnabledTriggers()
      expect(triggers).toHaveLength(1)
      expect(triggers[0]?.id).toBe(enabledTriggerId)
    })

    it('should return enabled triggers from multiple prompts', async () => {
      const db = DatabaseSingleton.instance.db
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

      const triggers = await getAllEnabledTriggers()
      expect(triggers).toHaveLength(3)
      expect(triggers.every((t) => t.isEnabled === 1)).toBe(true)
    })

    it('should return empty array when all triggers are disabled', async () => {
      const db = DatabaseSingleton.instance.db
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

      const triggers = await getAllEnabledTriggers()
      expect(triggers).toHaveLength(0)
    })
  })

  describe('deleteTriggersForPrompt', () => {
    it('should delete all triggers for a prompt', async () => {
      const db = DatabaseSingleton.instance.db
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

      // Verify triggers exist
      const triggersBefore = await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId))
      expect(triggersBefore).toHaveLength(2)

      await deleteTriggersForPrompt(promptId)

      // Verify triggers are deleted
      const triggersAfter = await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId))
      expect(triggersAfter).toHaveLength(0)
    })

    it('should not delete triggers for other prompts', async () => {
      const db = DatabaseSingleton.instance.db
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

      await deleteTriggersForPrompt(promptId1)

      // Verify only triggers for promptId1 are deleted
      const triggersForPrompt1 = await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId1))
      const triggersForPrompt2 = await db.select().from(triggersTable).where(eq(triggersTable.promptId, promptId2))

      expect(triggersForPrompt1).toHaveLength(0)
      expect(triggersForPrompt2).toHaveLength(1)
      expect(triggersForPrompt2[0]?.id).toBe(triggerId2)
    })

    it('should not throw when no triggers exist for prompt', async () => {
      await expect(deleteTriggersForPrompt('non-existent-prompt-id')).resolves.toBeUndefined()
    })

    it('should handle prompt with no triggers', async () => {
      const db = DatabaseSingleton.instance.db
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
      await expect(deleteTriggersForPrompt(promptId)).resolves.toBeUndefined()
    })
  })

  describe('createTrigger', () => {
    it('should create a new trigger', async () => {
      const db = DatabaseSingleton.instance.db
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

      await createTrigger({
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
      const db = DatabaseSingleton.instance.db
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

      await createTrigger({ id: uuidv7(), triggerType: 'time', triggerTime: '08:00', promptId: promptId, isEnabled: 1 })
      await createTrigger({ id: uuidv7(), triggerType: 'time', triggerTime: '18:00', promptId: promptId, isEnabled: 1 })

      const triggers = await db.select().from(triggersTable)
      expect(triggers).toHaveLength(2)
    })

    it('should create a disabled trigger', async () => {
      const db = DatabaseSingleton.instance.db
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

      await createTrigger({
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
