import { DatabaseSingleton } from '@/db/singleton'
import { reconcileDefaults } from '../lib/reconcile-defaults'

/**
 * Sets up an in-memory SQLite database for testing.
 * Creates all tables and reconciles default values.
 *
 * Usage:
 * ```ts
 * beforeAll(async () => {
 *   await setupTestDatabase()
 * })
 * ```
 */
export const setupTestDatabase = async () => {
  // Use in-memory Bun SQLite for testing (fast and synchronous)
  await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })

  // Run migrations to create tables
  const db = DatabaseSingleton.instance.db
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
 * This ensures complete isolation between tests by creating a fresh database
 * with all migrations applied, but WITHOUT reconciling defaults (to avoid
 * polluting tests with default data).
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

  // Re-initialize with fresh database
  await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })
}
