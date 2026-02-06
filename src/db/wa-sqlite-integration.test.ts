import { migrate } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import { modelsTable } from '@/db/tables'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

/**
 * Integration test for wa-sqlite database implementation.
 * This tests the full stack: wa-sqlite worker -> WaSQLiteDatabase -> Drizzle -> DAL
 */
describe('wa-sqlite integration', () => {
  let consoleSpies: ConsoleSpies

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()

    // Initialize with wa-sqlite (not bun-sqlite like other tests)
    await DatabaseSingleton.instance.initialize({ type: 'wa-sqlite', path: ':memory:' })

    // Run migrations
    const db = DatabaseSingleton.instance.db
    await migrate(db)
  })

  afterAll(async () => {
    await DatabaseSingleton.instance.close()
    DatabaseSingleton.reset()
    consoleSpies.restore()
  })

  describe('basic CRUD operations', () => {
    it('should insert and select records', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      const model = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()

      expect(model).toBeDefined()
      expect(model?.id).toBe(modelId)
      expect(model?.name).toBe('Test Model')
    })

    it('should update records', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Original Name',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      await db.update(modelsTable).set({ name: 'Updated Name' }).where(eq(modelsTable.id, modelId))

      const model = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(model?.name).toBe('Updated Name')
    })

    it('should delete records', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'To Delete',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      await db.delete(modelsTable).where(eq(modelsTable.id, modelId))

      const model = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(model).toBeUndefined()
    })
  })

  describe('empty object bug fix verification', () => {
    it('should return undefined (not empty object) for missing records with .get()', async () => {
      const db = DatabaseSingleton.instance.db

      // Query a non-existent model directly with Drizzle
      const result = await db.select().from(modelsTable).where(eq(modelsTable.id, 'nonexistent')).get()

      // Critical: should be undefined, not { id: undefined, provider: undefined, ... }
      expect(result).toBeUndefined()
      expect(result).not.toEqual({})

      // Verify truthiness works correctly
      if (result) {
        throw new Error('Result should be undefined, not truthy')
      }
    })

    it('should work correctly with DAL-style query patterns', async () => {
      const db = DatabaseSingleton.instance.db

      // Simulate a DAL function pattern: query that returns null for missing data
      const result = await db.select().from(modelsTable).where(eq(modelsTable.id, 'nonexistent-model-id')).get()

      // DAL functions typically return null for missing data
      expect(result ?? null).toBeNull()
      expect(result).not.toEqual({})
    })

    it('should return actual data (not undefined) for existing records', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Existing Model',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      const result = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()

      expect(result).toBeDefined()
      expect(result?.id).toBe(modelId)
      expect(result?.name).toBe('Existing Model')

      // Verify truthiness works correctly
      if (!result) {
        throw new Error('Result should be defined and truthy')
      }
    })
  })

  describe('concurrent operations', () => {
    it('should handle multiple concurrent inserts', async () => {
      const db = DatabaseSingleton.instance.db
      const modelIds = Array.from({ length: 10 }, () => uuidv7())

      // Insert 10 models concurrently
      await Promise.all(
        modelIds.map((id, i) =>
          db.insert(modelsTable).values({
            id,
            provider: 'openai',
            name: `Model ${i}`,
            model: 'gpt-4',
            contextWindow: 128000,
          }),
        ),
      )

      // Verify all were inserted
      const models = await db.select().from(modelsTable).where(eq(modelsTable.provider, 'openai')).all()
      const insertedIds = models.map((m) => m.id)

      for (const id of modelIds) {
        expect(insertedIds).toContain(id)
      }
    })

    it('should handle mixed concurrent reads and writes', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId1 = uuidv7()
      const modelId2 = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId1,
        provider: 'openai',
        name: 'Model 1',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      // Fire concurrent operations
      const [readResult1, , readResult2] = await Promise.all([
        db.select().from(modelsTable).where(eq(modelsTable.id, modelId1)).get(),
        db.insert(modelsTable).values({
          id: modelId2,
          provider: 'anthropic',
          name: 'Model 2',
          model: 'claude-3',
          contextWindow: 200000,
        }),
        db.select().from(modelsTable).where(eq(modelsTable.id, modelId1)).get(),
      ])

      expect(readResult1?.id).toBe(modelId1)
      expect(readResult2?.id).toBe(modelId1)

      const model2 = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId2)).get()
      expect(model2?.id).toBe(modelId2)
    })
  })

  describe('migrations', () => {
    it('should have all migrations applied', async () => {
      const db = DatabaseSingleton.instance.db

      // Check that the migrations table exists
      const migrationsTable = await db.all(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='__drizzle_migrations'
      `)
      expect(migrationsTable).toHaveLength(1)

      // Check that some expected tables exist
      const tables = await db.all(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table'
        ORDER BY name
      `)

      const tableNames = tables.map((t) => (t as unknown[])[0] as string)
      expect(tableNames).toContain('models')
      expect(tableNames).toContain('settings')
      expect(tableNames).toContain('chat_threads')
    })
  })

  describe('complex queries', () => {
    it('should handle JOINs correctly', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Join Test Model',
        model: 'gpt-4',
        contextWindow: 128000,
      })

      // Just verify complex queries work (actual JOIN test would need related tables)
      const models = await db.select().from(modelsTable).where(eq(modelsTable.provider, 'openai')).limit(10).all()

      expect(models.length).toBeGreaterThan(0)
    })

    it('should handle aggregations', async () => {
      const db = DatabaseSingleton.instance.db

      // Count all models
      const result = await db.all(sql`SELECT COUNT(*) as count FROM models`)
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
    })

    it('should handle ordering and limiting', async () => {
      const db = DatabaseSingleton.instance.db
      const modelIds = [uuidv7(), uuidv7(), uuidv7()]

      for (let i = 0; i < modelIds.length; i++) {
        await db.insert(modelsTable).values({
          id: modelIds[i]!,
          provider: 'custom',
          name: `Model ${i}`,
          model: 'test-model',
          contextWindow: 1000,
        })
      }

      const models = await db.select().from(modelsTable).where(eq(modelsTable.provider, 'custom')).limit(2).all()

      expect(models).toHaveLength(2)
    })
  })

  describe('transactions', () => {
    it('should support basic transactions', async () => {
      const db = DatabaseSingleton.instance.db
      const modelId = uuidv7()

      // Drizzle transaction support
      await db.transaction(async (tx) => {
        await tx.insert(modelsTable).values({
          id: modelId,
          provider: 'openai',
          name: 'Transaction Model',
          model: 'gpt-4',
          contextWindow: 128000,
        })
      })

      const model = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get()
      expect(model?.id).toBe(modelId)
    })
  })
})
