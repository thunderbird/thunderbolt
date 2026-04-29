/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase, DatabaseInterface } from './database-interface'

export type DatabaseType = 'wa-sqlite' | 'bun-sqlite' | 'powersync'

export class Database {
  #database: DatabaseInterface | null = null
  #initialized = false

  /**
   * Initialize the database connection.
   * This method is idempotent - it will only initialize once.
   * @param type - The database type to use ('wa-sqlite', 'bun-sqlite', or 'powersync')
   * @param path - The path/filename for the database
   */
  public async initialize({
    type = 'wa-sqlite',
    path,
  }: {
    type?: DatabaseType
    path: string
  }): Promise<AnyDrizzleDatabase> {
    if (this.#initialized && this.#database) {
      return this.#database.db
    }

    if (type === 'bun-sqlite') {
      const { BunSQLiteDatabase } = await import('./bun-sqlite-database')
      this.#database = new BunSQLiteDatabase()
    } else if (type === 'powersync') {
      const { PowerSyncDatabaseImpl } = await import('./powersync')
      this.#database = new PowerSyncDatabaseImpl()
    } else {
      const { WaSQLiteDatabase } = await import('./wa-sqlite-database')
      this.#database = new WaSQLiteDatabase()
    }

    await this.#database.initialize(path)

    this.#initialized = true

    const getDbTypeName = (): string => {
      switch (type) {
        case 'bun-sqlite':
          return 'Bun SQLite'
        case 'powersync':
          return 'PowerSync'
        default:
          return 'wa-sqlite'
      }
    }
    console.info(`Initialized ${getDbTypeName()} database at ${path}`)

    return this.#database.db
  }

  /**
   * Get the Drizzle database instance.
   * Throws an error if not initialized.
   */
  public get db() {
    if (!this.#database) {
      throw new Error('Database not initialized. Call initialize() first.')
    }
    return this.#database.db
  }

  /**
   * Get the underlying database implementation.
   * Throws an error if not initialized.
   */
  public get database() {
    if (!this.#database) {
      throw new Error('Database not initialized. Call initialize() first.')
    }
    return this.#database
  }

  /**
   * Check if the database is initialized.
   */
  public get isInitialized(): boolean {
    return this.#initialized && this.#database !== null
  }

  /**
   * Close the database connection.
   */
  public async close(): Promise<void> {
    if (this.#database?.close) {
      await this.#database.close()
    }
    this.#database = null
    this.#initialized = false
  }

  /**
   * Wait for initial sync to complete (PowerSync only).
   * For other database types, this resolves immediately.
   */
  public async waitForInitialSync(): Promise<void> {
    if (this.#database?.waitForInitialSync) {
      await this.#database.waitForInitialSync()
    }
  }
}

// --- Module-level instance management ---

let currentInstance: Database | null = null

/**
 * Register the initialized Database instance for module-level access.
 * Called once during app initialization.
 */
export const setDatabase = (instance: Database): void => {
  currentInstance = instance
}

/**
 * Get the Drizzle database for queries.
 * Used by DAL functions and other non-React code.
 */
export const getDb = (): AnyDrizzleDatabase => {
  if (!currentInstance) {
    throw new Error('Database not registered. Call setDatabase() after initialization.')
  }
  return currentInstance.db
}

/**
 * Get the underlying DatabaseInterface implementation.
 * Used for PowerSync-specific operations.
 */
export const getDatabaseInstance = (): DatabaseInterface => {
  if (!currentInstance) {
    throw new Error('Database not registered. Call setDatabase() after initialization.')
  }
  return currentInstance.database
}

/**
 * Check if a database instance has been registered.
 * Useful for conditional logic in test wrappers.
 */
export const isDbRegistered = (): boolean => currentInstance !== null

/**
 * Get the current Database wrapper instance, or null if not registered.
 * Used by initialization code to skip re-initialization when a database is already set up.
 */
export const getCurrentDatabase = (): Database | null => currentInstance

/**
 * Reset the module-level database instance.
 * Closes the connection and clears the reference.
 */
export const resetDatabase = async (): Promise<void> => {
  if (currentInstance) {
    await currentInstance.close()
  }
  currentInstance = null
}
