import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable, promptsTable, triggersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { deleteTriggersForPrompt } from './triggers'
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
})
