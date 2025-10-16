import { migrate } from '@/db/migrate'
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
  // Use in-memory Bun SQLite for testing (much faster than sqlocal)
  await DatabaseSingleton.instance.initialize({ type: 'bun-sqlite', path: ':memory:' })

  // Run migrations to create tables
  const db = DatabaseSingleton.instance.db
  await migrate(db)
  await reconcileDefaults(db)
}
