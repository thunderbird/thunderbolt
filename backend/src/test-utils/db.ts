/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PGlite, type Transaction } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { resolve } from 'path'
import type { db as DbType } from '../db/client'
import * as schema from '../db/schema'

/**
 * Run the shared client's `transaction()` calls as savepoints of the test's open transaction, one at a time. A real
 * `BEGIN` there would be ignored and its `COMMIT` would end the test's transaction, so rows written by code under
 * test that opens its own transaction would outlive the test's rollback.
 *
 * A `db.transaction()` opened through the outer `db` inside another one waits on itself forever. Nest through
 * `tx.transaction()` instead. If code under test ever needs to nest through the outer `db`, give this a depth counter.
 */
const nestTransactions = (client: PGlite) => {
  let queue: Promise<unknown> = Promise.resolve()
  const savepoint: Transaction = {
    query: (query, params, options) => client.query(query, params, options),
    sql: (strings, ...params) => client.sql(strings, ...params),
    exec: (query, options) => client.exec(query, options),
    rollback: async () => {
      await client.exec('ROLLBACK TO SAVEPOINT nested_transaction')
    },
    listen: (channel, callback) => client.listen(channel, callback),
    get closed() {
      return client.closed
    },
  }
  client.transaction = <T>(callback: (tx: Transaction) => Promise<T>) => {
    const run = queue.then(async () => {
      await client.exec('SAVEPOINT nested_transaction')
      try {
        const result = await callback(savepoint)
        await client.exec('RELEASE SAVEPOINT nested_transaction')
        return result
      } catch (error) {
        await client.exec('ROLLBACK TO SAVEPOINT nested_transaction')
        throw error
      }
    })
    queue = run.catch(() => undefined)
    return run
  }
}

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
    nestTransactions(this.client)
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

/** An isolated, migrated PGlite instance plus a `close()` that releases its
 *  WASM worker. */
export type IsolatedTestDb = {
  client: PGlite
  db: typeof DbType
  close: () => Promise<void>
}

/**
 * Create a fully ISOLATED PGlite-backed test DB: its own WASM runtime and its
 * own connection, NOT the shared BEGIN/ROLLBACK singleton (`createTestDb`).
 *
 * Prefer `getSharedIsolatedTestDb()` for test suites. Constructing one PGlite
 * per `--rerun-each` pass accumulates WASM runtimes until initialization stalls.
 *
 * Caller MUST `await close()` in `afterAll` — PGlite 0.4.x leaves WASM worker
 * threads open without an explicit close, crashing Bun with exit code 99 under
 * `--rerun-each` (see test-setup.ts).
 */
export const createIsolatedTestDb = async (): Promise<IsolatedTestDb> => {
  const client = new PGlite()
  const db = drizzle({ client, schema })
  const migrationsFolder = resolve(import.meta.dir, '../../drizzle')
  await migrate(db, { migrationsFolder })
  return {
    client,
    db,
    close: async () => {
      if (!client.closed) {
        await client.close()
      }
    },
  }
}

let sharedIsolatedTestDb: IsolatedTestDb | null = null

/**
 * A SINGLE shared isolated PGlite instance for suites that cannot use the
 * BEGIN/ROLLBACK singleton, including real `.listen()` servers and middleware
 * that opens nested transactions. Creating a fresh `new PGlite()` per describe
 * (× the `--rerun-each` passes) accumulated WASM workers on CI until
 * `new PGlite()` hung. One instance, created on first use and closed once in the
 * global `afterAll` (test-setup.ts), removes the accumulation. Callers must use
 * unique rows or clear their owned tables between tests.
 */
export const getSharedIsolatedTestDb = async (): Promise<IsolatedTestDb> => {
  if (!sharedIsolatedTestDb) {
    sharedIsolatedTestDb = await createIsolatedTestDb()
  }
  return sharedIsolatedTestDb
}

/** Close + reset the shared isolated instance. Called once in the global
 *  `afterAll` so its WASM worker is released before Bun tears down the process. */
export const closeSharedIsolatedTestDb = async (): Promise<void> => {
  if (sharedIsolatedTestDb) {
    await sharedIsolatedTestDb.close()
    sharedIsolatedTestDb = null
  }
}
