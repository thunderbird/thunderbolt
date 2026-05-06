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

type SharedTestDb = {
  client: PGlite
  db: typeof DbType
}

/** Shared on globalThis so the PGlite instance survives `--rerun-each` module
 *  reloads. Each module-load reset would otherwise spawn a new PGlite (and
 *  run all migrations again), and PGlite 0.4.x doesn't release WASM RSS on
 *  close — so the process steadily slows down across reruns until tests
 *  exceed their timeout. One shared instance avoids that entirely. */
const globalKey = Symbol.for('thunderbolt.test-db')
type GlobalWithTestDb = typeof globalThis & { [k: symbol]: SharedTestDb | undefined }

class TestDbManager {
  /**
   * Initialize PGlite and run migrations once per process
   * (shared across `--rerun-each` reruns via globalThis).
   * This MUST be called before any tests run.
   */
  async initialize() {
    const g = globalThis as GlobalWithTestDb
    if (g[globalKey]) return

    const client = new PGlite()
    const db = drizzle({ client, schema })
    const migrationsFolder = resolve(import.meta.dir, '../../drizzle')
    await migrate(db, { migrationsFolder })
    g[globalKey] = { client, db }
  }

  /** Close the PGlite instance to release WASM resources and allow clean process exit */
  async close() {
    const g = globalThis as GlobalWithTestDb
    const shared = g[globalKey]
    if (shared) {
      await shared.client.close()
      g[globalKey] = undefined
    }
  }

  private get shared(): SharedTestDb {
    const shared = (globalThis as GlobalWithTestDb)[globalKey]
    if (!shared) throw new Error('testDbManager not initialized — call initialize() first')
    return shared
  }

  /**
   * Create a test database instance with transaction isolation
   */
  async createTestDb() {
    await this.initialize()
    const { client, db } = this.shared

    // Start a transaction using Drizzle's API
    await db.execute(sql`BEGIN`)

    return {
      client,
      db,
      // Cleanup function to roll back the transaction
      cleanup: async () => {
        await db.execute(sql`ROLLBACK`)
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
