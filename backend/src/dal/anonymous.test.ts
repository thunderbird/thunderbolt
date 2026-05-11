/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { powersyncTableNames } from '@shared/powersync-tables'
import { eq, getTableName } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  AnonymousRowCapExceededError,
  excludedFromMigration,
  assertAnonymousRowCountUnderCap,
  isTransientDbError,
  migrateAnonymousUserData,
  tablesToMigrate,
} from './anonymous'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof createTestDb>>['db']

const insertUser = async (db: Db, id: string) => {
  const now = new Date()
  await db.insert(user).values({
    id,
    name: 'Test User',
    email: `${id}@test.com`,
    emailVerified: true,
    isNew: false,
    createdAt: now,
    updatedAt: now,
  })
}

/** Seed one row in every content table for `userId`. Returns a map of table → inserted id. */
const seedAllTables = async (db: Db, userId: string) => {
  const id = `row-${userId}`

  await db.insert(settingsTable).values({ key: 'theme', value: 'dark', userId })
  await db.insert(chatThreadsTable).values({ id: `ct-${userId}`, title: 'Thread', userId })
  await db
    .insert(chatMessagesTable)
    .values({ id: `cm-${userId}`, content: 'Hello', role: 'user', chatThreadId: `ct-${userId}`, userId })
  await db.insert(tasksTable).values({ id, userId })
  await db.insert(modelsTable).values({ id, name: 'GPT', provider: 'openai', userId })
  await db.insert(mcpServersTable).values({ id: `mcp-${userId}`, name: 'Server', userId })
  await db.insert(promptsTable).values({ id, title: 'Prompt', prompt: 'Do thing', userId })
  await db.insert(triggersTable).values({ id: `tr-${userId}`, userId })
  await db.insert(modesTable).values({ id, name: 'default', userId })
  await db.insert(modelProfilesTable).values({ id, userId })
}

const countRowsForUser = async (db: Db, userId: string) => {
  const tables = [
    { t: settingsTable, col: settingsTable.userId },
    { t: chatThreadsTable, col: chatThreadsTable.userId },
    { t: chatMessagesTable, col: chatMessagesTable.userId },
    { t: tasksTable, col: tasksTable.userId },
    { t: modelsTable, col: modelsTable.userId },
    { t: mcpServersTable, col: mcpServersTable.userId },
    { t: promptsTable, col: promptsTable.userId },
    { t: triggersTable, col: triggersTable.userId },
    { t: modesTable, col: modesTable.userId },
    { t: modelProfilesTable, col: modelProfilesTable.userId },
  ] as const

  let total = 0
  for (const { t, col } of tables) {
    const rows = await db.select().from(t).where(eq(col, userId))
    total += rows.length
  }
  return total
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('anonymous DAL', () => {
  let db: Db
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  // -------------------------------------------------------------------------
  describe('schema-drift test — tablesToMigrate registry', () => {
    it('covers every powersync table not in excludedFromMigration', () => {
      const expected = powersyncTableNames.filter((name) => !excludedFromMigration.has(name))
      const registered: Set<string> = new Set(tablesToMigrate.map((t) => getTableName(t)))
      const missing = expected.filter((name) => !registered.has(name))
      expect(missing).toEqual(
        // prettier-ignore
        /** If this fails, either add the new table to `tablesToMigrate`, or add it to
         * `excludedFromMigration` with a comment explaining why anonymous users
         * can't have rows in it. */
        [],
      )
    })

    it('has exactly 10 tables registered', () => {
      expect(tablesToMigrate).toHaveLength(10)
    })
  })

  // -------------------------------------------------------------------------
  describe('migrateAnonymousUserData — argument validation', () => {
    it('throws synchronously for empty fromAnonId', () => {
      expect(() => migrateAnonymousUserData(db, '', 'real-id')).toThrow()
    })

    it('throws synchronously for empty toRealId', () => {
      expect(() => migrateAnonymousUserData(db, 'anon-id', '')).toThrow()
    })
  })

  // -------------------------------------------------------------------------
  describe('migrateAnonymousUserData — happy path', () => {
    it('re-keys all 10 tables from anonId to newId', async () => {
      await insertUser(db, 'anon-user')
      await insertUser(db, 'real-user')
      await seedAllTables(db, 'anon-user')

      await migrateAnonymousUserData(db, 'anon-user', 'real-user')

      const anonCount = await countRowsForUser(db, 'anon-user')
      const realCount = await countRowsForUser(db, 'real-user')

      expect(anonCount).toBe(0)
      expect(realCount).toBe(10)
    })
  })

  // -------------------------------------------------------------------------
  describe('migrateAnonymousUserData — PK conflict on settings', () => {
    it('throws PG error 23505 when dest user already has conflicting settings row', async () => {
      await insertUser(db, 'anon-pk')
      await insertUser(db, 'real-pk')
      // Both users have the same settings key → composite PK (key, user_id) collision
      await db.insert(settingsTable).values({ key: 'theme', value: 'dark', userId: 'anon-pk' })
      await db.insert(settingsTable).values({ key: 'theme', value: 'light', userId: 'real-pk' })

      const err = await migrateAnonymousUserData(db, 'anon-pk', 'real-pk').catch((e) => e)
      // PGlite wraps the PG error in DrizzleQueryError; the PG code is in cause
      const pgCode = err?.code ?? err?.cause?.code
      expect(pgCode).toBe('23505')
    })
  })

  // -------------------------------------------------------------------------
  describe('assertAnonymousRowCountUnderCap', () => {
    it('resolves when all tables are under the cap', async () => {
      await insertUser(db, 'anon-cap')
      await seedAllTables(db, 'anon-cap')

      await expect(assertAnonymousRowCountUnderCap(db, 'anon-cap', 100)).resolves.toBeUndefined()
    })

    it('throws AnonymousRowCapExceededError when a table exceeds the cap', async () => {
      await insertUser(db, 'anon-over')
      // Seed 5 rows in tasksTable for 'anon-over', then use a cap of 3
      for (let i = 0; i < 5; i++) {
        await db.insert(tasksTable).values({ id: `task-${i}`, userId: 'anon-over' })
      }

      const err = await assertAnonymousRowCountUnderCap(db, 'anon-over', 3).catch((e) => e)
      expect(err).toBeInstanceOf(AnonymousRowCapExceededError)
      expect((err as AnonymousRowCapExceededError).tableName).toBe('tasks')
      expect((err as AnonymousRowCapExceededError).count).toBeGreaterThan(3)
    })
  })

  // -------------------------------------------------------------------------
  describe('isTransientDbError', () => {
    it('returns true for deadlock (40P01)', () => {
      expect(isTransientDbError({ code: '40P01' })).toBe(true)
    })

    it('returns true for serialization failure (40001)', () => {
      expect(isTransientDbError({ code: '40001' })).toBe(true)
    })

    it('returns true for connection failure (08006)', () => {
      expect(isTransientDbError({ code: '08006' })).toBe(true)
    })

    it('returns false for PK violation (23505)', () => {
      expect(isTransientDbError({ code: '23505' })).toBe(false)
    })

    it('returns false for FK violation (23503)', () => {
      expect(isTransientDbError({ code: '23503' })).toBe(false)
    })

    it('returns false for generic Error', () => {
      expect(isTransientDbError(new Error('oops'))).toBe(false)
    })

    it('returns false for null', () => {
      expect(isTransientDbError(null)).toBe(false)
    })
  })
})
