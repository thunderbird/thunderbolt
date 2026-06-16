/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { applySchema } from '@/db/apply-schema'
import { Database, getDb, resetDatabase, setDatabase } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import { reconcileDefaults } from '../lib/reconcile-defaults'

/**
 * Stable test workspace id. Use in fixtures + DAL call sites in DAL tests so
 * the convention is grep-able and identical across files. Matches the id
 * `setupTestDatabase()` seeds via `reconcileDefaults`.
 */
export const wsId = '00000000-0000-0000-0000-000000000001'

/** A second workspace id for cross-workspace isolation tests. */
export const otherWsId = '00000000-0000-0000-0000-000000000002'

/** Stable test user id. Mirrors what the trust-domain registry is seeded with by `renderWithReactivity`. */
export const testUserId = 'test-user'

/**
 * Seed a personal workspace row owned by `testUserId` so `useActiveWorkspaceId`
 * resolves `wsId` in component tests. Idempotent via `onConflictDoNothing`.
 *
 * Note: this deliberately does NOT seed a membership row — tests that need the
 * user to resolve as a workspace admin (e.g. anything reading
 * `useActiveWorkspaceMembership` or `useWorkspacePermission`) must seed it
 * themselves. See `seedTestPersonalAdminMembership`.
 */
const seedPersonalWorkspace = async (db: AnyDrizzleDatabase) => {
  await db
    .insert(workspacesTable)
    .values({
      id: wsId,
      name: 'Personal',
      isPersonal: 1,
      ownerUserId: testUserId,
    })
    .onConflictDoNothing()
}

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
  // Seed a personal workspace row so `useActiveWorkspaceId` resolves in component tests.
  await seedPersonalWorkspace(db)
  // Seed defaults under the canonical test workspace id (exported as `wsId`).
  await reconcileDefaults(db, wsId)
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
  // Personal workspace must still be present after reset — `useActiveWorkspaceId`
  // resolves through it. Defaults are deliberately not re-seeded (per existing comment).
  await seedPersonalWorkspace(db)
}

/**
 * Seeds the admin-membership row tying `testUserId` to the canonical personal
 * workspace `wsId`. Required by tests that exercise UI gated on
 * `useActiveWorkspaceMembership` or `useWorkspacePermission`. Idempotent.
 */
export const seedTestPersonalAdminMembership = async (db: AnyDrizzleDatabase = getDb()) => {
  await db
    .insert(workspaceMembershipsTable)
    .values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
    .onConflictDoNothing()
}
