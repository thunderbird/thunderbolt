import type { DatabaseInterface, AnyDrizzleDatabase } from './database-interface'
import { LibSQLTauriDatabase } from './libsql-tauri-database'
import { SQLocalDatabase } from './sqlocal-database'

export type DatabaseType = 'sqlocal' | 'libsql-tauri'

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
   * @param type - The database type to use ('sqlocal' or 'libsql-tauri')
   * @param config - Configuration for the database
   */
  public async initialize({
    type = 'sqlocal',
    path,
  }: {
    type?: DatabaseType
    path: string
  }): Promise<AnyDrizzleDatabase> {
    if (DatabaseSingleton.#initialized && this.#database) {
      return this.#database.db
    }

    if (type === 'libsql-tauri') {
      console.log('Initializing LibSQL for Tauri Database')
      this.#database = new LibSQLTauriDatabase()
    } else {
      console.log('Initializing SQLocal Database')
      this.#database = new SQLocalDatabase()
    }

    console.log('Initializing database at path:', path)

    await this.#database.initialize(path)
    DatabaseSingleton.#initialized = true

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
