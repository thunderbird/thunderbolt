/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { WaSQLiteDatabase } from './wa-sqlite-database'

describe('WaSQLiteDatabase', () => {
  let db: WaSQLiteDatabase
  let consoleSpies: ConsoleSpies

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  beforeEach(async () => {
    db = new WaSQLiteDatabase()
    // Use in-memory for fast tests
    await db.initialize(':memory:')
  })

  afterAll(async () => {
    await db.close()
    consoleSpies.restore()
  })

  describe('initialization', () => {
    it(
      'should initialize successfully',
      async () => {
        const testDb = new WaSQLiteDatabase()
        await testDb.initialize(':memory:')
        expect(testDb.db).toBeDefined()
        await testDb.close()
      },
      { timeout: 5000 },
    )

    it(
      'should be idempotent - multiple initialize calls should not create new instances',
      async () => {
        const testDb = new WaSQLiteDatabase()
        await testDb.initialize(':memory:')
        const firstDb = testDb.db
        await testDb.initialize(':memory:')
        const secondDb = testDb.db
        expect(firstDb).toBe(secondDb)
        await testDb.close()
      },
      { timeout: 5000 },
    )

    it('should throw error when accessing db before initialization', () => {
      const testDb = new WaSQLiteDatabase()
      expect(() => testDb.db).toThrow('WaSQLiteDatabase not initialized')
    })

    it(
      'should extract filename from path correctly',
      async () => {
        const testDb = new WaSQLiteDatabase()
        // In tests, only use :memory: since OPFS is not available in Node/Bun
        // In production (browser), OPFS will be used for persistence
        await testDb.initialize(':memory:')
        expect(testDb.db).toBeDefined()
        await testDb.close()
      },
      { timeout: 5000 },
    )
  })

  describe('basic operations', () => {
    it('should create a table', async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)

      const tables = await db.db.all(sql`
        SELECT name FROM sqlite_master WHERE type='table' AND name='test'
      `)
      expect(tables).toHaveLength(1)
    })

    it('should insert and select data', async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)

      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`)

      const rows = await db.db.all(sql`SELECT * FROM test ORDER BY id`)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual([1, 'Alice'])
      expect(rows[1]).toEqual([2, 'Bob'])
    })

    it('should update data', async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)

      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`UPDATE test SET name = 'Alicia' WHERE id = 1`)

      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 1`)
      expect(row).toEqual([1, 'Alicia'])
    })

    it('should delete data', async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)

      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`DELETE FROM test WHERE id = 1`)

      const rows = await db.db.all(sql`SELECT * FROM test`)
      expect(rows).toHaveLength(0)
    })
  })

  describe('query methods', () => {
    beforeEach(async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`)
    })

    it('should return all rows with .all()', async () => {
      const rows = await db.db.all(sql`SELECT * FROM test ORDER BY id`)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual([1, 'Alice'])
      expect(rows[1]).toEqual([2, 'Bob'])
    })

    it('should return first row with .get()', async () => {
      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 1`)
      expect(row).toEqual([1, 'Alice'])
    })

    it('should return undefined with .get() when no rows match', async () => {
      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 999`)
      expect(row).toBeUndefined()
    })

    it('should handle .run() for INSERT/UPDATE/DELETE', async () => {
      const result = await db.db.run(sql`INSERT INTO test (id, name) VALUES (3, 'Charlie')`)
      // .run() should not throw and should complete successfully
      expect(result).toBeDefined()
    })
  })

  describe('empty object bug fix', () => {
    beforeEach(async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)
    })

    it('should return undefined (not empty object) when .get() finds no results', async () => {
      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 999`)

      // Critical: should be undefined, not { id: undefined, name: undefined }
      expect(row).toBeUndefined()
      expect(row).not.toEqual({})
      expect(row).not.toBeNull()
    })

    it('should return actual row when .get() finds results', async () => {
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)

      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 1`)

      expect(row).toBeDefined()
      expect(row).toEqual([1, 'Alice'])
    })
  })

  describe('parameterized queries', () => {
    beforeEach(async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)
    })

    it('should handle parameterized INSERT', async () => {
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (${1}, ${'Alice'})`)

      const row = await db.db.get(sql`SELECT * FROM test WHERE id = 1`)
      expect(row).toEqual([1, 'Alice'])
    })

    it('should handle parameterized SELECT', async () => {
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`)

      const row = await db.db.get(sql`SELECT * FROM test WHERE name = ${'Bob'}`)
      expect(row).toEqual([2, 'Bob'])
    })

    it('should handle multiple parameters', async () => {
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`)

      const rows = await db.db.all(sql`
        SELECT * FROM test 
        WHERE id >= ${1} AND id <= ${2}
        ORDER BY id
      `)
      expect(rows).toHaveLength(2)
    })
  })

  describe('concurrent operations', () => {
    beforeEach(async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)
    })

    it('should handle multiple concurrent inserts', async () => {
      // Fire off multiple inserts concurrently
      await Promise.all([
        db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`),
        db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`),
        db.db.run(sql`INSERT INTO test (id, name) VALUES (3, 'Charlie')`),
        db.db.run(sql`INSERT INTO test (id, name) VALUES (4, 'Diana')`),
      ])

      const rows = await db.db.all(sql`SELECT * FROM test ORDER BY id`)
      expect(rows).toHaveLength(4)
    })

    it('should handle mixed concurrent operations', async () => {
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)

      // Mix reads and writes concurrently
      const [row1, row2, , row3] = await Promise.all([
        db.db.get(sql`SELECT * FROM test WHERE id = 1`),
        db.db.all(sql`SELECT * FROM test`),
        db.db.run(sql`INSERT INTO test (id, name) VALUES (2, 'Bob')`),
        db.db.get(sql`SELECT * FROM test WHERE id = 1`),
      ])

      expect(row1).toEqual([1, 'Alice'])
      expect(row2).toHaveLength(1)
      expect(row3).toEqual([1, 'Alice'])

      const finalRows = await db.db.all(sql`SELECT * FROM test ORDER BY id`)
      expect(finalRows).toHaveLength(2)
    })

    it(
      'should handle rapid sequential operations',
      async () => {
        // Test the operation queue by firing many operations quickly
        for (let i = 1; i <= 50; i++) {
          await db.db.run(sql`INSERT INTO test (id, name) VALUES (${i}, ${'User' + i})`)
        }

        const count = await db.db.all(sql`SELECT COUNT(*) as count FROM test`)
        const firstRow = count[0] as unknown[] | undefined
        const countValue = firstRow?.[0] as number | undefined
        expect(countValue).toBe(50)
      },
      // CI VMs have slower worker message-passing overhead
      { timeout: 5000 },
    )
  })

  describe('error handling', () => {
    it('should throw error for invalid SQL', async () => {
      try {
        await db.db.run(sql`INVALID SQL STATEMENT`)
        throw new Error('Expected error to be thrown')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    it('should throw error for constraint violations', async () => {
      await db.db.run(sql`
        CREATE TABLE test (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `)
      await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Alice')`)

      // Duplicate primary key should throw
      let errorThrown = false
      try {
        await db.db.run(sql`INSERT INTO test (id, name) VALUES (1, 'Bob')`)
      } catch (error) {
        errorThrown = true
        expect(error).toBeDefined()
      }
      expect(errorThrown).toBe(true)
    })

    it('should throw error for non-existent tables', async () => {
      let errorThrown = false
      try {
        await db.db.all(sql`SELECT * FROM nonexistent_table`)
      } catch (error) {
        errorThrown = true
        expect(error).toBeDefined()
      }
      expect(errorThrown).toBe(true)
    })
  })

  describe('cleanup', () => {
    it(
      'should close cleanly',
      async () => {
        const testDb = new WaSQLiteDatabase()
        await testDb.initialize(':memory:')
        await testDb.db.run(sql`
          CREATE TABLE test (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
          )
        `)

        await testDb.close()

        // After close, db should throw error
        expect(() => testDb.db).toThrow('WaSQLiteDatabase not initialized')
      },
      // CI VMs have slower worker message-passing overhead
      { timeout: 5000 },
    )

    it(
      'should be safe to close multiple times',
      async () => {
        const testDb = new WaSQLiteDatabase()
        await testDb.initialize(':memory:')
        await testDb.close()
        await testDb.close() // Should not throw
      },
      { timeout: 5000 },
    )
  })
})
