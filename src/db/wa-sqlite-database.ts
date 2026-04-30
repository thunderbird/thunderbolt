/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'
import { WaSQLiteWorkerClient } from './wa-sqlite-worker-client'

/**
 * Checks if an object is empty (has no own properties or all properties are undefined)
 */
const isEmptyObject = (obj: unknown): boolean => {
  if (!obj || typeof obj !== 'object') {
    return false
  }
  const keys = Object.keys(obj)
  return keys.length === 0 || keys.every((key) => (obj as Record<string, unknown>)[key] === undefined)
}

export class WaSQLiteDatabase implements DatabaseInterface {
  private _db: ReturnType<typeof drizzle<typeof schema>> | null = null
  private workerClient: WaSQLiteWorkerClient | null = null

  get db() {
    if (!this._db) {
      throw new Error('WaSQLiteDatabase not initialized. Call initialize() first.')
    }
    return this._db
  }

  async initialize(path: string): Promise<void> {
    if (this._db) {
      return // Already initialized
    }

    // Extract just the filename from the path
    const dbFilename = path.includes('/') ? path.split('/').pop() || 'thunderbolt.db' : path

    // Create and initialize the worker
    const worker = new Worker(new URL('./wa-sqlite-worker.ts', import.meta.url), {
      type: 'module',
    })

    this.workerClient = new WaSQLiteWorkerClient(worker)
    await this.workerClient.waitForReady()

    // Initialize database in worker
    await this.workerClient.init(dbFilename)

    if (path === ':memory:') {
      console.warn('Using in-memory SQLite database (data will not persist)')
    }

    // Create Drizzle driver adapter
    const driver = async (sql: string, params: unknown[], method: 'get' | 'all' | 'values' | 'run') => {
      if (!this.workerClient) {
        throw new Error('Database not initialized')
      }

      try {
        const result = await this.workerClient.exec(sql, params, method)

        if (method === 'run') {
          return { rows: [] }
        }

        const rows = result?.rows

        if (method === 'get') {
          // For .get(), return the single row or undefined
          // Worker returns a single row array like [1, 'Alice'] or undefined
          if (!rows || isEmptyObject(rows)) {
            return { rows: undefined as unknown as unknown[] }
          }

          // Return the row directly (already in array format from worker)
          return { rows: rows as unknown[] }
        }

        // For .all(), always return an array
        return { rows: (Array.isArray(rows) ? rows : []) as unknown[] }
      } catch (error) {
        // Suppress expected "no such table" errors during migrations
        const errorMsg = error instanceof Error ? error.message : String(error)
        if (!errorMsg.includes('no such table: __drizzle_migrations')) {
          console.error('wa-sqlite query error:', error, '\nSQL:', sql, '\nParams:', params)
        }
        throw error
      }
    }

    this._db = drizzle(driver, { schema })
  }

  async close(): Promise<void> {
    if (this.workerClient) {
      await this.workerClient.close()
      this.workerClient.terminate()
      this.workerClient = null
      this._db = null
    }
  }
}
