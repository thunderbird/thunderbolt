/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { applySchema } from '@/db/apply-schema'
import { Database, resetDatabase, setDatabase } from '@/db/database'
import { reconcileDefaults } from '../lib/reconcile-defaults'

/**
 * Sets up an in-memory SQLite database for testing.
 * Applies schema from Drizzle tables (no migrations; matches PowerSync “schema at init” approach)
 * and reconciles default values.
 *
 * Usage:
 * ```ts
 * beforeAll(async () => {
 *   await setupTestDatabase()
 * })
 * ```
 */
export const setupTestDatabase = async () => {
  const database = new Database()
  await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
  setDatabase(database)
  const db = database.db
  await applySchema(db)
  await reconcileDefaults(db)
}

/**
 * Tears down the test database and resets the instance.
 * Should be called in afterAll() to clean up between test files.
 *
 * Usage:
 * ```ts
 * afterAll(async () => {
 *   await teardownTestDatabase()
 * })
 * ```
 */
export const teardownTestDatabase = async () => {
  await resetDatabase()
}

/**
 * Resets the database to a clean state by tearing down and setting up again.
 * Creates a fresh database with schema applied (no migrations), but WITHOUT
 * reconciling defaults so tests stay isolated.
 *
 * Tests that need default values should manually reconcile them in beforeEach.
 *
 * Usage:
 * ```ts
 * afterEach(async () => {
 *   await resetTestDatabase()
 * })
 * ```
 */
export const resetTestDatabase = async () => {
  await teardownTestDatabase()
  const database = new Database()
  await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
  setDatabase(database)
  const db = database.db
  await applySchema(db)
}
