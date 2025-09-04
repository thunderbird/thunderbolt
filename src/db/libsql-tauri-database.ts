import Database from '@/lib/libsql'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { DatabaseInterface } from './database-interface'
import * as schema from './schema'

export class LibSQLTauriDatabase implements DatabaseInterface {
  private _db: ReturnType<typeof drizzle<typeof schema>> | null = null
  private database: Database | null = null

  get db() {
    if (!this._db) {
      throw new Error('LibSQLTauriDatabase not initialized. Call initialize() first.')
    }
    return this._db
  }

  private isSelectQuery(sql: string): boolean {
    return sql.trim().toLowerCase().startsWith('select')
  }

  async initialize(path: string): Promise<void> {
    if (this._db) {
      return // Already initialized
    }

    // Load the Tauri database
    this.database = await Database.load(path)

    // Create Drizzle instance using sqlite-proxy pattern
    this._db = drizzle(
      async (sql: string, params?: any[], method?: 'all' | 'get' | 'values' | 'run') => {
        if (!this.database) {
          throw new Error('Database not initialized')
        }

        let rows: any = []
        let results: any = []

        try {
          // If the query is a SELECT, use the select method
          if (this.isSelectQuery(sql)) {
            rows = await this.database.select(sql, params).catch((e) => {
              console.error('SQL Error:', e)
              return []
            })
          } else {
            // Otherwise, use the execute method
            await this.database.execute(sql, params).catch((e) => {
              console.error('SQL Error:', e)
              return { rowsAffected: 0, lastInsertId: 0 }
            })
            return { rows: [] }
          }

          // Transform rows to match expected format (array of values)
          rows = rows.map((row: any) => {
            return Object.values(row)
          })

          // Return based on method type
          results = method === 'all' ? rows : rows[0]
          return { rows: results }
        } catch (error) {
          console.error('Database query error:', error)
          return { rows: [] }
        }
      },
      {
        schema,
        // logger: process.env.NODE_ENV === 'development',
      },
    )
  }

  async close(): Promise<void> {
    if (this.database) {
      await this.database.close()
      this.database = null
      this._db = null
    }
  }
}
