import { applySchema } from '@/db/apply-schema'
import { DatabaseSingleton } from '@/db/singleton'
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
  await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })
  const db = DatabaseSingleton.instance.db
  await applySchema(db)
  await reconcileDefaults(db)
}

/**
 * Tears down the test database and resets the singleton.
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
  DatabaseSingleton.reset()
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
  await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })
  const db = DatabaseSingleton.instance.db
  await applySchema(db)
}
