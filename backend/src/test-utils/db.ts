import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { resolve } from 'path'
import type { db as DbType } from '../db/client'
import * as schema from '../db/schema'

class TestDbManager {
  private client: PGlite | null = null
  private db: typeof DbType | null = null
  private initialized = false

  /**
   * Initialize PGlite and run migrations once
   * This MUST be called before any tests run
   */
  async initialize() {
    if (this.initialized) return

    this.client = new PGlite()
    this.db = drizzle({ client: this.client, schema })
    const migrationsFolder = resolve(import.meta.dir, '../../drizzle')
    await migrate(this.db, { migrationsFolder })
    this.initialized = true
  }

  /** Close the PGlite instance to release WASM resources and allow clean process exit */
  async close() {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.db = null
      this.initialized = false
    }
  }

  /**
   * Create a test database instance with transaction isolation
   */
  async createTestDb() {
    if (!this.initialized) {
      await this.initialize()
    }

    // Start a transaction using Drizzle's API
    await this.db!.execute(sql`BEGIN`)

    return {
      client: this.client!,
      db: this.db!,
      // Cleanup function to roll back the transaction
      cleanup: async () => {
        await this.db!.execute(sql`ROLLBACK`)
      },
    }
  }
}

// Export a singleton instance
export const testDbManager = new TestDbManager()

/**
 * Create an in-memory test database with schema
 *
 * Reuses a single PGlite instance and runs migrations once (on first call).
 * For test isolation, wrap each test in a Drizzle transaction and roll back.
 */
export const createTestDb = () => testDbManager.createTestDb()
