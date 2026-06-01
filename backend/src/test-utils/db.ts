/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
    if (this.initialized) {
      return
    }

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

    // Defensively roll back before opening this test's transaction. All tests
    // share one PGlite connection (PGlite is single-connection WASM Postgres),
    // so if a prior test leaked an open transaction — it threw before cleanup,
    // or a background query opened one — this BEGIN would nest as a no-op and
    // the two tests would share a single transaction. The leading ROLLBACK is a
    // harmless notice when the connection is already clean and resets it when
    // it isn't, guaranteeing each test starts at a true top-level transaction.
    await this.db!.execute(sql`ROLLBACK`).catch(() => {})
    await this.db!.execute(sql`BEGIN`)

    return {
      client: this.client!,
      db: this.db!,
      // Cleanup rolls back this test's transaction. Swallow errors so a
      // connection already reset by the defensive ROLLBACK above (or by a
      // teardown race) never fails the test in afterEach.
      cleanup: async () => {
        await this.db!.execute(sql`ROLLBACK`).catch(() => {})
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
