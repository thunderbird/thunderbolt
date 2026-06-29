/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
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

    this.client = new PGlite({ extensions: { uuid_ossp } })
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
   * Create a test database instance with transaction isolation.
   *
   * Opens a Drizzle transaction and exposes the Transaction object as `db`.
   * Why a Drizzle transaction (not raw `BEGIN`/`ROLLBACK` SQL): production
   * upload handlers wrap operations in `db.transaction(...)`. When that runs
   * against a Drizzle Database/Session, PGlite issues raw `BEGIN`/`COMMIT`
   * SQL — a nested `BEGIN` is a no-op (Postgres warning), but the matching
   * `COMMIT` ends the outer test transaction, breaking isolation.
   *
   * Against a Drizzle Transaction, `db.transaction(...)` uses `SAVEPOINT`
   * instead, which nests cleanly and rolls back with the outer test
   * transaction on cleanup.
   *
   * The outer transaction is opened via a deferred promise so we can hand
   * the Transaction object to the caller and hold it open until cleanup.
   * Throwing a sentinel from inside the transaction callback triggers
   * Drizzle's `ROLLBACK`; the catch outside swallows the sentinel.
   */
  async createTestDb() {
    if (!this.initialized) {
      await this.initialize()
    }

    const rollbackSentinel = new Error('__test_cleanup_rollback__')

    let resolveTx!: (tx: typeof DbType) => void
    let signalRollback!: () => void

    const txReady = new Promise<typeof DbType>((resolve) => {
      resolveTx = resolve
    })

    const txDone = this.db!.transaction(async (tx) => {
      resolveTx(tx as unknown as typeof DbType)
      await new Promise<void>((_, reject) => {
        signalRollback = () => reject(rollbackSentinel)
      })
    }).catch((err) => {
      if (err !== rollbackSentinel) {
        throw err
      }
    })

    const tx = await txReady

    return {
      client: this.client!,
      db: tx,
      cleanup: async () => {
        signalRollback()
        await txDone
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
 * Use this for tests that bind a real `.listen()` server whose server-side
 * `getSession` reads run on a separate task: those reads must see committed
 * rows without racing the singleton's open transaction (head-of-line blocking
 * under CI CPU starvation). Rows inserted here are committed on a real
 * connection, so a concurrent reader on the same instance sees them.
 *
 * Caller MUST `await close()` in `afterAll` — PGlite 0.4.x leaves WASM worker
 * threads open without an explicit close, crashing Bun with exit code 99 under
 * `--rerun-each` (see test-setup.ts).
 */
export const createIsolatedTestDb = async (): Promise<IsolatedTestDb> => {
  const client = new PGlite({ extensions: { uuid_ossp } })
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
 * A SINGLE shared isolated PGlite instance, reused by every test that binds a
 * real `.listen()` server. Creating a fresh `new PGlite()` per describe (× the
 * `--rerun-each` passes) accumulated WASM workers on CI until `new PGlite()`
 * hung — an 8-minute stall at the first ws-e2e `beforeAll`. One instance,
 * created on first use and closed once in the global `afterAll` (test-setup.ts),
 * removes the accumulation. Rows committed here are UUID-keyed and unique, so
 * they can't collide across tests or reruns sharing the instance.
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
