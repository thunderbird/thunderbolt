import { drizzle } from 'drizzle-orm/sqlite-proxy'
// @ts-expect-error - sqlite3Worker1Promiser exists but TypeScript definitions are incomplete
import { sqlite3Worker1Promiser } from '@sqlite.org/sqlite-wasm'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'

type Worker1Promiser = (methodName: string, args: any) => Promise<any>

/**
 * Checks if an object is empty (has no own properties or all properties are undefined)
 */
const isEmptyObject = (obj: any): boolean => {
  if (!obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  return keys.length === 0 || keys.every((key) => obj[key] === undefined)
}

export class WaSQLiteDatabase implements DatabaseInterface {
  private _db: ReturnType<typeof drizzle<typeof schema>> | null = null
  private promiser: Worker1Promiser | null = null
  private dbId: string | null = null

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

    // Initialize the worker-based SQLite (supports OPFS)
    this.promiser = await new Promise<Worker1Promiser>((resolve) => {
      const _promiser = sqlite3Worker1Promiser({
        onready: () => resolve(_promiser),
      })
    })

    // Open database with OPFS persistence
    const dbPath = path === ':memory:' ? ':memory:' : `file:${dbFilename}?vfs=opfs`

    const openResponse = await this.promiser('open', {
      filename: dbPath,
    })

    this.dbId = openResponse.dbId

    if (path === ':memory:') {
      console.warn('Using in-memory SQLite database (data will not persist)')
    } else {
      console.info(`Using WA-SQLite with OPFS persistence: ${dbFilename}`)
    }

    // Create Drizzle driver adapter
    const driver = async (sql: string, params: any[], method: 'get' | 'all' | 'values' | 'run') => {
      if (!this.promiser || !this.dbId) {
        throw new Error('Database not initialized')
      }

      try {
        const response = await this.promiser('exec', {
          dbId: this.dbId,
          sql,
          bind: params,
          returnValue: method === 'run' ? undefined : 'resultRows',
          // Drizzle expects arrays for 'all' and 'values', objects for 'get'
          rowMode: method === 'get' ? 'object' : 'array',
        })

        if (method === 'run') {
          return { rows: [] }
        }

        const rows = response.result.resultRows || []

        if (method === 'get') {
          if (rows.length === 0) {
            return { rows: undefined }
          }

          const row = rows[0]

          // Apply same fix as SQLocalDatabase for empty objects
          if (isEmptyObject(row)) {
            return { rows: undefined }
          }

          return { rows: row }
        }

        return { rows }
      } catch (error) {
        console.error('WaSQLite query error:', error, '\nSQL:', sql, '\nParams:', params)
        throw error
      }
    }

    this._db = drizzle(driver, { schema })
  }

  async close(): Promise<void> {
    if (this.promiser && this.dbId) {
      await this.promiser('close', { dbId: this.dbId })
      this.promiser = null
      this.dbId = null
      this._db = null
    }
  }
}
