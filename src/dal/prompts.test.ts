import { DatabaseSingleton } from '@/db/singleton'
import { chatThreadsTable, modelsTable, promptsTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModels, hashModel } from '../defaults/models'
import { reconcileDefaultsForTable } from '../lib/reconcile-defaults'
import { createAutomation, getAllPrompts, getTriggerPromptForThread, resetAutomationToDefault } from './prompts'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Prompts DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
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

  describe('resetAutomationToDefault', () => {
    beforeEach(async () => {
      const db = DatabaseSingleton.instance.db
      await db.delete(modelsTable)
      await db.delete(promptsTable)
      await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)
      await reconcileDefaultsForTable(db, promptsTable, defaultAutomations, hashPrompt)
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

  describe('createAutomation', () => {
    it('should create a new automation', async () => {
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

      await createAutomation({
        id: promptId,
        title: 'Test Automation',
        prompt: 'Test prompt content',
        modelId: modelId,
      })

      const prompts = await getAllPrompts()
      expect(prompts.map((p) => p.id)).toContain(promptId)
    })

    it('should create multiple automations', async () => {
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

      await createAutomation({ id: promptId1, prompt: 'Prompt 1', modelId: modelId })
      await createAutomation({ id: promptId2, prompt: 'Prompt 2', modelId: modelId })

      const prompts = await getAllPrompts()
      expect(prompts).toHaveLength(2)
    })
  })
})
