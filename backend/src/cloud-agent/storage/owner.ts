/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import postgres from 'postgres'

export type QueryParameter = string | number | boolean | null
export type RuntimeSql = {
  query: <T extends object>(statement: string, parameters?: QueryParameter[]) => Promise<T[]>
}

export type RuntimeStoreOptions = {
  connectionString: string
  onFatal?: (error: Error) => void
}

/** One session owns the advisory lock and every runtime query; a lost session is never replaced. */
export class RuntimeOwner {
  private readonly pool: postgres.Sql
  private connection: postgres.ReservedSql | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private failure: Error | undefined
  private closing = false
  private closePromise: Promise<void> | undefined
  private opened = false
  private readonly onFatal: RuntimeStoreOptions['onFatal']

  constructor(options: RuntimeStoreOptions) {
    this.onFatal = options.onFatal
    this.pool = postgres(options.connectionString, {
      max: 1,
      connection: { application_name: 'thunderbolt-cloud-runtime' },
      idle_timeout: 0,
      max_lifetime: 0,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
      onclose: () => {
        if (this.opened && !this.closing) {
          this.fail(new Error('Cloud runtime owner connection was lost'))
        }
      },
    })
  }

  async open(): Promise<void> {
    this.connection = await this.pool.reserve()
    const rows = await this.connection.unsafe<{ owned: boolean }[]>(
      "SELECT pg_try_advisory_lock(hashtextextended('thunderbolt-cloud-runtime:' || current_schema(), 0)) AS owned",
    )
    if (!rows[0]?.owned) {
      await this.close()
      throw new Error('Cloud runtime already has a database owner')
    }
    this.opened = true
  }

  /** Serialize reads as well as writes, including multi-query snapshots and commit publication. */
  run<T>(operation: (sql: RuntimeSql) => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('Cloud runtime store is closed'))
    }
    const result = this.tail.then(async () => {
      this.assertHealthy()
      const sql: RuntimeSql = {
        query: async <R extends object>(statement: string, parameters: QueryParameter[] = []) => {
          this.assertHealthy()
          const rows = await this.connection!.unsafe<R[]>(statement, parameters)
          this.assertHealthy()
          return [...rows]
        },
      }
      return operation(sql)
    })
    this.tail = result.catch(() => {})
    return result
  }

  /** Roll back definite failures; an uncertain COMMIT permanently stops the owner. */
  transaction<T>(operation: (sql: RuntimeSql) => Promise<T>, adopt?: (value: T) => void): Promise<T> {
    return this.run(async (sql) => {
      await sql.query('BEGIN')
      const value = await operation(sql).catch(async (error: unknown) => {
        try {
          await sql.query('ROLLBACK')
        } catch {
          this.fail(new Error('Cloud runtime transaction rollback could not be confirmed'))
        }
        throw error
      })
      try {
        await sql.query('COMMIT')
      } catch (error) {
        this.fail(new Error('Cloud runtime commit outcome is unknown; reopen required', { cause: error }))
        throw error
      }
      adopt?.(value)
      return value
    })
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closing = true
    this.closePromise = this.tail.then(async () => {
      // This private pool has no other callers: releasing during shutdown cannot admit another writer.
      this.connection?.release()
      await this.pool.end({ timeout: 1 })
    })
    return this.closePromise
  }

  private assertHealthy(): void {
    if (this.failure) {
      throw this.failure
    }
    if (!this.connection) {
      throw new Error('Cloud runtime owner is not open')
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return
    }
    this.failure = error
    this.onFatal?.(error)
  }
}
