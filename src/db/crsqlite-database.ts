/**
 * CRSQLite database implementation using web worker
 * Provides CRDT-enabled SQLite with sync support
 */

import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { CRSQLChange } from './crsqlite-worker'
import { CRSQLiteWorkerClient } from './crsqlite-worker-client'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'

export class CRSQLiteDatabase implements DatabaseInterface {
  private _db: ReturnType<typeof drizzle<typeof schema>> | null = null
  private workerClient: CRSQLiteWorkerClient | null = null

  get db() {
    if (!this._db) {
      throw new Error('Database not initialized')
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
    const worker = new Worker(new URL('./crsqlite-worker.ts', import.meta.url), {
      type: 'module',
    })

    this.workerClient = new CRSQLiteWorkerClient(worker)
    await this.workerClient.waitForReady()

    // Initialize database in worker
    await this.workerClient.init(dbFilename)

    if (path === ':memory:') {
      console.warn('Using in-memory SQLite database (data will not persist)')
    }

    // Create Drizzle driver adapter
    const driver = async (
      sql: string,
      params: unknown[],
      method: 'get' | 'all' | 'values' | 'run',
    ): Promise<{ rows: unknown[] }> => {
      if (!this.workerClient) {
        throw new Error('Database not initialized')
      }

      const result = await this.workerClient.exec(sql, params, method)

      // Handle the result based on method type
      if (method === 'run') {
        return { rows: [] }
      }

      // For get/all/values, return the rows (ensure array type)
      const rows = result?.rows
      return { rows: Array.isArray(rows) ? rows : rows !== undefined ? [rows] : [] }
    }

    // Create Drizzle instance using sqlite-proxy
    this._db = drizzle(driver, {
      schema,
    })
  }

  /**
   * Get the site ID of the current database
   */
  async getSiteId(): Promise<string> {
    if (!this.workerClient) {
      throw new Error('Database not initialized')
    }
    return this.workerClient.getSiteId()
  }

  /**
   * Get changes since a given version for sync
   */
  async getChanges(sinceVersion: bigint): Promise<{ changes: CRSQLChange[]; dbVersion: bigint }> {
    if (!this.workerClient) {
      throw new Error('Database not initialized')
    }
    return this.workerClient.getChanges(sinceVersion)
  }

  /**
   * Apply remote changes from sync
   */
  async applyChanges(changes: CRSQLChange[]): Promise<void> {
    if (!this.workerClient) {
      throw new Error('Database not initialized')
    }
    return this.workerClient.applyChanges(changes)
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
