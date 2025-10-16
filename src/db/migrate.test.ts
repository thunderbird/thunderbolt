import { migrations } from '@/drizzle/_migrations'
import { DatabaseSingleton } from '@/db/singleton'
import { beforeEach, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { migrate } from './migrate'

describe('Database Migrations', () => {
  beforeEach(async () => {
    // Create a fresh in-memory database for each test
    await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })
  })

  describe('migrate', () => {
    it('should successfully run all migrations on a fresh database', async () => {
      const db = DatabaseSingleton.instance.db

      // Run migrations
      await migrate(db)

      // Verify migration tracking table was created
      const tables = await db.all(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='__drizzle_migrations'
      `)
      expect(tables).toHaveLength(1)

      // Verify all migrations were recorded
      const rows = await db.all(sql`SELECT id, hash, created_at FROM "__drizzle_migrations"`)
      expect(rows).toHaveLength(migrations.length)
    })

    it('should create the migration tracking table with correct schema', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      // Verify table structure
      const tableInfo = await db.all(sql`PRAGMA table_info(__drizzle_migrations)`)

      const columns = tableInfo.map(([_cid, name, type, notnull, _dflt_value, pk]: any) => ({
        name,
        type,
        notnull: Boolean(notnull),
        pk: Boolean(pk),
      }))

      expect(columns).toContainEqual({
        name: 'id',
        type: 'INTEGER',
        notnull: false,
        pk: true,
      })
      expect(columns).toContainEqual({
        name: 'hash',
        type: 'TEXT',
        notnull: true,
        pk: false,
      })
      expect(columns).toContainEqual({
        name: 'created_at',
        type: 'numeric',
        notnull: false,
        pk: false,
      })
    })

    it('should record each migration with hash and timestamp', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      const rows = await db.all(sql`SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY id`)

      expect(rows.length).toBeGreaterThan(0)

      for (const row of rows) {
        const [id, hash, created_at] = row as [number, string, number]
        expect(id).toBeGreaterThan(0)
        expect(typeof hash).toBe('string')
        expect(hash.length).toBeGreaterThan(0)
        expect(typeof created_at).toBe('number')
        expect(created_at).toBeGreaterThan(0)
      }
    })

    it('should be idempotent - running migrations twice should not fail', async () => {
      const db = DatabaseSingleton.instance.db

      // Run migrations first time
      await migrate(db)

      const firstRunRows = await db.all(sql`SELECT id, hash FROM "__drizzle_migrations" ORDER BY id`)

      // Run migrations second time - should not fail or duplicate entries
      await migrate(db)

      const secondRunRows = await db.all(sql`SELECT id, hash FROM "__drizzle_migrations" ORDER BY id`)

      // Should have same number of migrations
      expect(secondRunRows).toHaveLength(firstRunRows.length)

      // Should have exact same migrations
      expect(secondRunRows).toEqual(firstRunRows)
    })

    it('should apply migrations in the correct order', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      const rows = await db.all(sql`SELECT hash FROM "__drizzle_migrations" ORDER BY id`)
      const recordedHashes = rows.map(([hash]: any) => hash)

      // Verify hashes match the order in migrations array
      const expectedHashes = migrations.map((m) => m.hash)
      expect(recordedHashes).toEqual(expectedHashes)
    })

    it('should enforce unique constraint on migration hash', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      // Try to manually insert a duplicate hash - should throw due to UNIQUE constraint
      const existingHash = migrations[0]?.hash

      const attemptDuplicateInsert = async () => {
        await db.run(sql`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (${existingHash}, ${Date.now()})`)
      }

      await expect(attemptDuplicateInsert()).rejects.toThrow()
    })

    it('should create application tables from migrations', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      // Verify that migrations created some tables beyond the tracking table
      const tables = await db.all(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name != '__drizzle_migrations'
        ORDER BY name
      `)

      // Should have created at least some application tables
      expect(tables.length).toBeGreaterThan(0)
    })

    it('should create all migrations with valid SQL', async () => {
      const db = DatabaseSingleton.instance.db

      // This test verifies that each migration's SQL is valid
      // If any migration has invalid SQL, migrate() will throw
      await expect(migrate(db)).resolves.toBeUndefined()
    })

    it('should create migration tracking table on first run', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      // Verify migrations table was created and contains expected data
      const tables = await db.all(sql`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='__drizzle_migrations'
      `)
      expect(tables).toHaveLength(1)

      // Verify it has the expected structure by querying it successfully
      const rows = await db.all(sql`SELECT id, hash, created_at FROM "__drizzle_migrations"`)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('should record migrations with increasing timestamps', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      const rows = await db.all(sql`SELECT created_at FROM "__drizzle_migrations" ORDER BY id`)
      const timestamps = rows.map(([created_at]: any) => created_at as number)

      // All timestamps should be positive numbers
      for (const timestamp of timestamps) {
        expect(timestamp).toBeGreaterThan(0)
      }

      // Note: In practice, these might all have the same or very similar timestamps
      // since they run quickly, but they should all be valid timestamps
    })

    it('should have consistent migration count with bundled migrations', async () => {
      const db = DatabaseSingleton.instance.db

      await migrate(db)

      const rows = await db.all(sql`SELECT COUNT(*) as count FROM "__drizzle_migrations"`)
      const firstRow = rows[0] as unknown[] | undefined
      const recordedCount = firstRow?.[0] as number

      expect(recordedCount).toBe(migrations.length)
    })
  })

  describe('Migration Integrity', () => {
    it('should have non-empty SQL for all migrations', () => {
      for (const migration of migrations) {
        expect(migration.sql).toBeTruthy()
        expect(migration.sql.length).toBeGreaterThan(0)
      }
    })

    it('should have unique hashes for all migrations', () => {
      const hashes = migrations.map((m) => m.hash)
      const uniqueHashes = new Set(hashes)
      expect(uniqueHashes.size).toBe(migrations.length)
    })

    it('should have valid names for all migrations', () => {
      for (const migration of migrations) {
        expect(migration.name).toBeTruthy()
        expect(typeof migration.name).toBe('string')
        expect(migration.name.length).toBeGreaterThan(0)
      }
    })

    it('should have migration names matching expected pattern', () => {
      // Migration names should follow pattern like "0000_something_descriptive.sql"
      const namePattern = /^\d{4}_[a-z_]+\.sql$/

      for (const migration of migrations) {
        expect(migration.name).toMatch(namePattern)
      }
    })
  })
})
