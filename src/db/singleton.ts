import type { AnyDrizzleDatabase, DatabaseInterface } from './database-interface'

export type DatabaseType = 'wa-sqlite' | 'libsql-tauri' | 'bun-sqlite' | 'powersync'

export class DatabaseSingleton {
  static #instance: DatabaseSingleton | null = null
  static #initialized = false

  #database: DatabaseInterface | null = null

  /**
   * Get the initialized DatabaseSingleton instance.
   * Initializes the instance if it doesn't exist.
   * @returns The initialized DatabaseSingleton instance.
   */
  public static get instance(): DatabaseSingleton {
    if (!this.#instance) {
      this.#instance = new DatabaseSingleton()
    }
    return this.#instance
  }

  /**
   * Initialize the database connection.
   * This method is idempotent - it will only initialize once.
   * @param type - The database type to use ('wa-sqlite', 'libsql-tauri', or 'bun-sqlite')
   * @param config - Configuration for the database
   */
  public async initialize({
    type = 'wa-sqlite',
    path,
  }: {
    type?: DatabaseType
    path: string
  }): Promise<AnyDrizzleDatabase> {
    if (DatabaseSingleton.#initialized && this.#database) {
      return this.#database.db
    }

    if (type === 'libsql-tauri') {
      // Lazy load LibSQLTauriDatabase (only used in Tauri/mobile, not browser)
      const { LibSQLTauriDatabase } = await import('./libsql-tauri-database')
      this.#database = new LibSQLTauriDatabase()
    } else if (type === 'bun-sqlite') {
      // Lazy load BunSQLiteDatabase (only used in tests, not production)
      const { BunSQLiteDatabase } = await import('./bun-sqlite-database')
      this.#database = new BunSQLiteDatabase()
    } else if (type === 'powersync') {
      // Lazy load PowerSync for multi-device sync
      const { PowerSyncDatabaseImpl } = await import('./powersync')
      this.#database = new PowerSyncDatabaseImpl()
    } else {
      // Default to wa-sqlite for web (best performance with web workers)
      const { WaSQLiteDatabase } = await import('./wa-sqlite-database')
      this.#database = new WaSQLiteDatabase()
    }

    await this.#database.initialize(path)

    DatabaseSingleton.#initialized = true

    const getDbTypeName = (): string => {
      switch (type) {
        case 'libsql-tauri':
          return 'LibSQL for Tauri'
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
      throw new Error('DatabaseSingleton not initialized. Call initialize() first.')
    }
    return this.#database.db
  }

  /**
   * Get the database instance.
   * Throws an error if not initialized.
   */
  public get database() {
    if (!this.#database) {
      throw new Error('DatabaseSingleton not initialized. Call initialize() first.')
    }
    return this.#database
  }

  /**
   * Check if the database is initialized.
   */
  public get isInitialized(): boolean {
    return DatabaseSingleton.#initialized && this.#database !== null
  }

  /**
   * Close the database connection.
   */
  public async close(): Promise<void> {
    if (this.#database?.close) {
      await this.#database.close()
    }
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

  /**
   * Reset the singleton instance (useful for testing)
   */
  public static reset(): void {
    if (this.#instance && this.#instance.#database && this.#instance.#database.close) {
      this.#instance.#database.close()
    }
    if (this.#instance) {
      this.#instance.#database = null
    }
    this.#instance = null
    this.#initialized = false
  }
}
