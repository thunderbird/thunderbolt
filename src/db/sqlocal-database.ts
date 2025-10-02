import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { SQLocal } from 'sqlocal'
import { SQLocalDrizzle } from 'sqlocal/drizzle'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'

/**
 * Checks if an object is empty (has no own properties or all properties are undefined)
 */
const isEmptyObject = (obj: any): boolean => {
  if (!obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.length === 0 || keys.every((key) => obj[key] === undefined)
}

export class SQLocalDatabase implements DatabaseInterface {
  private _db: ReturnType<typeof drizzle<typeof schema>> | null = null
  private sqlocalDrizzle: SQLocalDrizzle | null = null
  private rawDriver: SQLocal | null = null

  get db() {
    if (!this._db) {
      throw new Error('SQLocalDatabase not initialized. Call initialize() first.')
    }
    return this._db
  }

  async initialize(path: string): Promise<void> {
    if (this._db) {
      return // Already initialized
    }

    this.rawDriver = new SQLocal(path)
    this.sqlocalDrizzle = new SQLocalDrizzle(path)

    const { driver: originalDriver } = this.sqlocalDrizzle

    // FIX: sqlocal bug where .get() returns objects with all undefined fields instead of undefined
    //
    // Problem: When querying for a non-existent record with .get(), sqlocal returns:
    //   { id: undefined, provider: undefined, name: undefined, ... }
    // instead of: undefined
    //
    // Impact: This breaks optional chaining and truthy checks throughout the app.
    // For example, getModelById() was returning malformed models, causing the chat screen
    // to render blank when a model reference was missing from the database.
    //
    // Expected behavior: .get() should return undefined when no results are found,
    // matching standard SQL driver behavior (see LibSQLTauriDatabase at line 61).
    //
    // Bug exists in: sqlocal 0.14.2 + drizzle-orm 0.44.6
    // TODO: Remove this wrapper when sqlocal fixes the upstream bug
    const driver = async (sql: string, params: any[], method: 'get' | 'all' | 'values' | 'run') => {
      const result = await originalDriver(sql, params, method)

      if (method === 'get' && result.rows && isEmptyObject(result.rows)) {
        return { rows: undefined } as any
      }

      return result
    }

    this._db = drizzle(driver, { schema })

    if (path === ':memory:') {
      console.warn('SQLocalDatabase initialized with in-memory database')
    }
  }

  async close(): Promise<void> {
    if (this.rawDriver) {
      // SQLocal doesn't have a close method, but we can clean up references
      this.rawDriver = null
      this.sqlocalDrizzle = null
      this._db = null
    }
  }
}
