import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { DatabaseSingleton } from './singleton'
import { migrate } from './migrate'
import { modelsTable, settingsTable, tasksTable, promptsTable } from './tables'
import { eq } from 'drizzle-orm'
import { checkSystemModelProtection } from '../lib/system-model-protection'
import type { AnyDrizzleDatabase } from './database-interface'

describe('Seed Migration System', () => {
  let db: AnyDrizzleDatabase

  beforeEach(async () => {
    // Reset the singleton and create a fresh in-memory database for each test
    DatabaseSingleton.reset()
    db = await DatabaseSingleton.instance.initialize({
      type: 'sqlocal',
      path: ':memory:',
    })
  })

  afterEach(async () => {
    // Clean up the database instance
    // Note: Memory databases don't need explicit cleanup
  })

  describe('Migration-based seeding', () => {
    it('should create seed data only through migrations', async () => {
      // Run migrations which should include seed data
      await migrate(db)

      // Verify that system models were created
      const systemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(systemModels).toHaveLength(1)
      expect(systemModels[0].id).toBe('0198ecc5-cc2b-735b-b478-785b85d3c731')
      expect(systemModels[0].name).toBe('Qwen 3')
      expect(systemModels[0].provider).toBe('flower')

      // Verify that user models were created
      const userModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 0))
      expect(userModels).toHaveLength(2)

      // Verify that default settings were created
      const settings = await db.select().from(settingsTable)
      expect(settings.length).toBeGreaterThan(0)
      expect(settings.some((s: any) => s.key === 'cloud_url')).toBe(true)
      expect(settings.some((s: any) => s.key === 'anonymous_id')).toBe(true)

      // Verify that initial tasks were created
      const tasks = await db.select().from(tasksTable)
      expect(tasks).toHaveLength(3)
      expect(tasks[0].item).toBe('Connect your email account to get started')

      // Verify that default prompts were created
      const prompts = await db.select().from(promptsTable)
      expect(prompts).toHaveLength(3)
      expect(prompts.some((p: any) => p.title === 'Daily Brief')).toBe(true)
    })

    it('should not recreate seed data when tables become empty after initial setup', async () => {
      // Run migrations to create initial seed data
      await migrate(db)

      // Verify initial data exists
      let tasks = await db.select().from(tasksTable)
      expect(tasks).toHaveLength(3)

      // Delete all tasks (simulating user deletion)
      await db.delete(tasksTable)

      // Verify tasks are gone
      tasks = await db.select().from(tasksTable)
      expect(tasks).toHaveLength(0)

      // Run migrations again - should NOT recreate the tasks
      await migrate(db)

      // Verify tasks are still empty (not recreated)
      tasks = await db.select().from(tasksTable)
      expect(tasks).toHaveLength(0)
    })

    it('should allow system models to be updated through new migrations', async () => {
      // Run initial migrations
      await migrate(db)

      // Verify system model exists
      const systemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(systemModels).toHaveLength(1)
      const originalModel = systemModels[0]

      // Simulate a new migration that updates the system model
      // This would be done by creating a new migration file with UPDATE statements
      await db
        .update(modelsTable)
        .set({ name: 'Updated Qwen 3' })
        .where(eq(modelsTable.id, '0198ecc5-cc2b-735b-b478-785b85d3c731'))

      // Verify the model was updated
      const updatedModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(updatedModels[0].name).toBe('Updated Qwen 3')
      expect(updatedModels[0].id).toBe(originalModel.id) // ID should remain the same
    })
  })

  describe('System model protection', () => {
    beforeEach(async () => {
      // Reset the singleton and create a fresh database for each test
      DatabaseSingleton.reset()
      db = await DatabaseSingleton.instance.initialize({
        type: 'sqlocal',
        path: ':memory:',
      })
      await migrate(db)
    })

    it('should prevent deletion of system models', async () => {
      const systemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(systemModels).toHaveLength(1)

      // Attempt to delete system model should fail
      try {
        await checkSystemModelProtection(systemModels[0].id, 'delete')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('Cannot delete system models')
      }

      // Verify system model still exists
      const remainingSystemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(remainingSystemModels).toHaveLength(1)
    })

    it('should prevent editing of system models', async () => {
      const systemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(systemModels).toHaveLength(1)

      // Attempt to update system model should fail
      try {
        await checkSystemModelProtection(systemModels[0].id, 'edit')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('Cannot edit system models')
      }

      // Verify system model was not modified
      const unchangedSystemModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1))
      expect(unchangedSystemModels[0].name).toBe('Qwen 3')
    })

    it('should allow modification of user models', async () => {
      const userModels = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 0))
      expect(userModels).toHaveLength(2)

      const userModel = userModels[0]

      // Should be able to update user model
      await db.update(modelsTable).set({ name: 'Modified User Model' }).where(eq(modelsTable.id, userModel.id))

      // Verify the model was updated
      const updatedModels = await db.select().from(modelsTable).where(eq(modelsTable.id, userModel.id))
      expect(updatedModels[0].name).toBe('Modified User Model')

      // Should be able to disable user model
      await db.update(modelsTable).set({ enabled: 0 }).where(eq(modelsTable.id, userModel.id))

      // Verify the model was disabled
      const disabledModels = await db.select().from(modelsTable).where(eq(modelsTable.id, userModel.id))
      expect(disabledModels[0].enabled).toBe(0)

      // Should be able to delete user model
      await db.delete(modelsTable).where(eq(modelsTable.id, userModel.id))

      // Verify the model was deleted
      const remainingModels = await db.select().from(modelsTable).where(eq(modelsTable.id, userModel.id))
      expect(remainingModels).toHaveLength(0)
    })
  })

  describe('Migration consistency', () => {
    it('should use consistent hardwired IDs across installs', async () => {
      // Reset the singleton and create a fresh database for this test
      DatabaseSingleton.reset()
      db = await DatabaseSingleton.instance.initialize({
        type: 'sqlocal',
        path: ':memory:',
      })
      await migrate(db)

      // Verify that all seed data uses the expected hardwired IDs
      const systemModel = await db
        .select()
        .from(modelsTable)
        .where(eq(modelsTable.id, '0198ecc5-cc2b-735b-b478-785b85d3c731'))
        .get()
      expect(systemModel).toBeDefined()
      expect(systemModel?.isSystem).toBe(1)

      const userModel1 = await db
        .select()
        .from(modelsTable)
        .where(eq(modelsTable.id, '0198ecc5-cc2b-735b-b478-7c6770371b84'))
        .get()
      expect(userModel1).toBeDefined()
      expect(userModel1?.isSystem).toBe(0)

      const userModel2 = await db
        .select()
        .from(modelsTable)
        .where(eq(modelsTable.id, '0198ecc5-cc2b-735b-b478-80dcfed4ea97'))
        .get()
      expect(userModel2).toBeDefined()
      expect(userModel2?.isSystem).toBe(0)

      const task1 = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, '0198ecc5-cc2b-735b-b478-93f8db7202ce'))
        .get()
      expect(task1).toBeDefined()

      const prompt1 = await db
        .select()
        .from(promptsTable)
        .where(eq(promptsTable.id, '0198ecc5-cc2b-735b-b478-9ff7f5b047d3'))
        .get()
      expect(prompt1).toBeDefined()
      expect(prompt1?.title).toBe('Daily Brief')
    })

    it('should maintain referential integrity between prompts and models', async () => {
      await migrate(db)

      // Verify that all prompts reference valid models
      const prompts = await db.select().from(promptsTable)
      const models = await db.select().from(modelsTable)

      for (const prompt of prompts) {
        const referencedModel = models.find((m: any) => m.id === prompt.modelId)
        expect(referencedModel).toBeDefined()
        expect(referencedModel?.id).toBe(prompt.modelId)
      }

      // Verify that the system model is referenced by all prompts
      const systemModelId = '0198ecc5-cc2b-735b-b478-785b85d3c731'
      for (const prompt of prompts) {
        expect(prompt.modelId).toBe(systemModelId)
      }
    })
  })
})
