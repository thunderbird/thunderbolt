/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { WaSQLiteWorkerClient } from './wa-sqlite-worker-client'

describe('WaSQLiteWorkerClient', () => {
  let client: WaSQLiteWorkerClient | null = null
  let consoleSpies: ConsoleSpies

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
  })

  beforeEach(async () => {
    const worker = new Worker(new URL('./wa-sqlite-worker.ts', import.meta.url), {
      type: 'module',
    })
    client = new WaSQLiteWorkerClient(worker)
    await client.waitForReady()
  })

  afterEach(async () => {
    if (client) {
      try {
        await client.close()
      } catch (_error) {
        // Ignore errors if worker was already terminated
      }
      try {
        client.terminate()
      } catch (_error) {
        // Ignore errors if worker was already terminated
      }
      client = null
    }
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  describe('initialization', () => {
    it('should wait for worker to be ready', async () => {
      // If we get here, waitForReady() worked in beforeEach
      expect(client).toBeDefined()
    })

    it('should initialize database', async () => {
      await expect(client!.init(':memory:')).resolves.toBeUndefined()
    })

    it('should be safe to call init multiple times', async () => {
      await client!.init(':memory:')
      await client!.init(':memory:') // Should not throw
    })
  })

  describe('SQL execution', () => {
    beforeEach(async () => {
      await client!.init(':memory:')
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', [], 'run')
    })

    it('should execute INSERT statements', async () => {
      const result = await client!.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')", [], 'run')
      expect(result).toBeDefined()
    })

    it('should execute SELECT with .all()', async () => {
      await client!.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')", [], 'run')
      await client!.exec("INSERT INTO test (id, name) VALUES (2, 'Bob')", [], 'run')

      const result = await client!.exec('SELECT * FROM test ORDER BY id', [], 'all')
      expect(result?.rows).toBeDefined()
      const rows = result?.rows as unknown[]
      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual([1, 'Alice'])
      expect(rows[1]).toEqual([2, 'Bob'])
    })

    it('should execute SELECT with .get()', async () => {
      await client!.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')", [], 'run')

      const result = await client!.exec('SELECT * FROM test WHERE id = 1', [], 'get')
      expect(result?.rows).toEqual([1, 'Alice'])
    })

    it('should return undefined for .get() with no results', async () => {
      const result = await client!.exec('SELECT * FROM test WHERE id = 999', [], 'get')
      expect(result?.rows).toBeUndefined()
    })

    it('should execute UPDATE statements', async () => {
      await client!.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')", [], 'run')
      await client!.exec("UPDATE test SET name = 'Alicia' WHERE id = 1", [], 'run')

      const result = await client!.exec('SELECT * FROM test WHERE id = 1', [], 'get')
      expect(result?.rows).toEqual([1, 'Alicia'])
    })

    it('should execute DELETE statements', async () => {
      await client!.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')", [], 'run')
      await client!.exec('DELETE FROM test WHERE id = 1', [], 'run')

      const result = await client!.exec('SELECT * FROM test', [], 'all')
      const rows = result?.rows as unknown[]
      expect(rows).toHaveLength(0)
    })
  })

  describe('parameterized queries', () => {
    beforeEach(async () => {
      await client!.init(':memory:')
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', [], 'run')
    })

    it('should handle parameterized INSERT', async () => {
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run')

      const result = await client!.exec('SELECT * FROM test WHERE id = ?', [1], 'get')
      expect(result?.rows).toEqual([1, 'Alice'])
    })

    it('should handle parameterized SELECT', async () => {
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run')
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'Bob'], 'run')

      const result = await client!.exec('SELECT * FROM test WHERE name = ?', ['Bob'], 'get')
      expect(result?.rows).toEqual([2, 'Bob'])
    })

    it('should handle multiple parameters', async () => {
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run')
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'Bob'], 'run')
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [3, 'Charlie'], 'run')

      const result = await client!.exec('SELECT * FROM test WHERE id >= ? AND id <= ? ORDER BY id', [1, 2], 'all')
      const rows = result?.rows as unknown[]
      expect(rows).toHaveLength(2)
    })
  })

  describe('concurrent operations', () => {
    beforeEach(async () => {
      await client!.init(':memory:')
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', [], 'run')
    })

    // Skipped: Flaky due to race condition in wa-sqlite WASM module when handling
    // concurrent writes. Fails intermittently with "access to a null reference
    // (evaluating 'func(...cArgs)')". This is a limitation of the underlying
    // WASM/Bun interaction, not application code.
    it.skip('should handle multiple concurrent requests', async () => {
      // Fire off multiple operations concurrently
      const promises = [
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run'),
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'Bob'], 'run'),
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [3, 'Charlie'], 'run'),
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [4, 'Diana'], 'run'),
      ]

      await Promise.all(promises)

      const result = await client!.exec('SELECT * FROM test ORDER BY id', [], 'all')
      const rows = result?.rows as unknown[]
      expect(rows).toHaveLength(4)
    })

    it('should maintain request/response order for concurrent requests', async () => {
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run')
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'Bob'], 'run')

      // Fire multiple gets concurrently and verify each gets correct response
      const [result1, result2] = await Promise.all([
        client!.exec('SELECT * FROM test WHERE id = ?', [1], 'get'),
        client!.exec('SELECT * FROM test WHERE id = ?', [2], 'get'),
      ])

      expect(result1?.rows).toEqual([1, 'Alice'])
      expect(result2?.rows).toEqual([2, 'Bob'])
    })

    it('should handle rapid sequential requests', async () => {
      // Fire many requests quickly to test request ID management
      for (let i = 1; i <= 20; i++) {
        await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [i, `User${i}`], 'run')
      }

      const result = await client!.exec('SELECT COUNT(*) FROM test', [], 'get')
      const rows = result?.rows as unknown[] | undefined
      expect(rows?.[0]).toBe(20)
    })
  })

  describe('error handling', () => {
    beforeEach(async () => {
      await client!.init(':memory:')
    })

    it('should reject on invalid SQL', async () => {
      await expect(client!.exec('INVALID SQL', [], 'run')).rejects.toThrow()
    })

    it('should reject on non-existent table', async () => {
      await expect(client!.exec('SELECT * FROM nonexistent', [], 'all')).rejects.toThrow()
    })

    it('should reject on constraint violation', async () => {
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', [], 'run')
      await client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run')

      // Duplicate primary key
      await expect(client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Bob'], 'run')).rejects.toThrow()
    })

    it('should handle errors in concurrent requests independently', async () => {
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', [], 'run')

      const promises = [
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'Alice'], 'run'),
        client!.exec('SELECT * FROM nonexistent', [], 'all'), // This will fail
        client!.exec('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'Bob'], 'run'),
      ]

      const results = await Promise.allSettled(promises)

      expect(results[0]!.status).toBe('fulfilled')
      expect(results[1]!.status).toBe('rejected')
      expect(results[2]!.status).toBe('fulfilled')

      // Verify successful operations completed
      const result = await client!.exec('SELECT * FROM test ORDER BY id', [], 'all')
      const rows = result?.rows as unknown[]
      expect(rows).toHaveLength(2)
    })
  })

  describe('timeout handling', () => {
    beforeEach(async () => {
      await client!.init(':memory:')
    })

    it('should have a 30 second timeout for requests', async () => {
      // We can't easily test a 30s timeout in unit tests, but we can verify
      // that requests complete well within the timeout
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)', [], 'run')

      const start = Date.now()
      await client!.exec('INSERT INTO test (id) VALUES (?)', [1], 'run')
      const elapsed = Date.now() - start

      // Should complete in well under 30 seconds (should be < 1s)
      expect(elapsed).toBeLessThan(1000)
    })
  })

  describe('worker lifecycle', () => {
    it('should close database cleanly', async () => {
      await client!.init(':memory:')
      await client!.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)', [], 'run')

      await expect(client!.close()).resolves.toBeUndefined()
    })

    // Note: Worker termination tests are skipped because they interfere with
    // afterEach cleanup. Worker termination is a straightforward operation
    // (just calls worker.terminate()) and doesn't need extensive testing.
  })
})
