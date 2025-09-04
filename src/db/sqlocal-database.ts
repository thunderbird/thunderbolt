import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { SQLocal } from 'sqlocal'
import { SQLocalDrizzle } from 'sqlocal/drizzle'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'

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

    const { driver } = this.sqlocalDrizzle
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
