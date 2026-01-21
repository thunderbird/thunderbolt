import { PowerSyncDatabase } from '@powersync/web'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import type { DatabaseInterface, AnyDrizzleDatabase } from '../database-interface'
import { AppSchema, drizzleSchema } from './schema'
import { ThunderboltConnector } from './connector'

const POWERSYNC_URL = import.meta.env.VITE_POWERSYNC_URL as string
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8000/v1'

/** Maximum time to wait for initial sync (10 seconds) */
const INITIAL_SYNC_TIMEOUT_MS = 10_000

/** LocalStorage key for sync enabled flag */
const SYNC_ENABLED_KEY = 'powersync_sync_enabled'

/**
 * Check if PowerSync URL is configured (available for syncing)
 */
export const isPowerSyncAvailable = (): boolean => {
  return Boolean(POWERSYNC_URL)
}

/**
 * Check if sync is enabled by user preference
 */
export const isSyncEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(SYNC_ENABLED_KEY) === 'true'
}

/**
 * Set sync enabled preference
 */
export const setSyncEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SYNC_ENABLED_KEY, String(enabled))
}

/**
 * PowerSync database implementation.
 * Wraps PowerSyncDatabase with Drizzle for type-safe queries.
 */
export class PowerSyncDatabaseImpl implements DatabaseInterface {
  private powerSync: PowerSyncDatabase | null = null
  private _db: AnyDrizzleDatabase | null = null
  private connector: ThunderboltConnector | null = null
  private _isConnected = false

  get db(): AnyDrizzleDatabase {
    if (!this._db) {
      throw new Error('PowerSync database not initialized. Call initialize() first.')
    }
    return this._db
  }

  /**
   * Get the underlying PowerSyncDatabase instance for direct access.
   * Useful for watching queries, sync status, etc.
   */
  get powerSyncInstance(): PowerSyncDatabase | null {
    return this.powerSync
  }

  /** Whether PowerSync is connected to the cloud */
  get isConnected(): boolean {
    return this._isConnected
  }

  async initialize(path: string): Promise<void> {
    if (this._db) {
      return // Already initialized
    }

    // Extract just the filename from the path
    const dbFilename = path.includes('/') ? path.split('/').pop() || 'thunderbolt.db' : path

    // Create PowerSync database
    this.powerSync = new PowerSyncDatabase({
      database: { dbFilename },
      schema: AppSchema,
    })

    // Wrap with Drizzle for type-safe queries
    // Cast through unknown since PowerSync's schema type differs from standard Drizzle
    this._db = wrapPowerSyncWithDrizzle(this.powerSync, {
      schema: drizzleSchema,
    }) as unknown as AnyDrizzleDatabase

    // Create connector for authentication
    this.connector = new ThunderboltConnector(BACKEND_URL)

    // Connect to PowerSync Cloud if URL is configured AND sync is enabled
    if (POWERSYNC_URL && isSyncEnabled()) {
      await this.connectToSync()
    }
  }

  /**
   * Connect to PowerSync Cloud for syncing.
   * Call this when user enables sync.
   */
  async connectToSync(): Promise<void> {
    if (!this.powerSync || !this.connector || !POWERSYNC_URL) {
      return
    }

    if (this._isConnected) {
      return // Already connected
    }

    try {
      await this.powerSync.connect(this.connector)
      this._isConnected = true
    } catch (error) {
      console.warn('Failed to connect to PowerSync Cloud:', error)
    }
  }

  /**
   * Disconnect from PowerSync Cloud.
   * Call this when user disables sync.
   */
  async disconnectFromSync(): Promise<void> {
    if (!this.powerSync || !this._isConnected) {
      return
    }

    try {
      await this.powerSync.disconnect()
      this._isConnected = false
    } catch (error) {
      console.warn('Failed to disconnect from PowerSync Cloud:', error)
    }
  }

  /**
   * Wait for PowerSync to complete its initial sync.
   * This ensures data from the cloud is available before reconciling defaults.
   * Times out after INITIAL_SYNC_TIMEOUT_MS to avoid blocking forever.
   */
  async waitForInitialSync(): Promise<void> {
    // Skip if sync is disabled or not connected
    if (!this.powerSync || !this._isConnected || !isSyncEnabled()) {
      return
    }

    // Check if already synced
    const status = this.powerSync.currentStatus
    if (status?.hasSynced) {
      return
    }

    return new Promise((resolve) => {
      const unsubscribe = this.powerSync!.registerListener({
        statusChanged: (newStatus) => {
          if (newStatus.hasSynced) {
            unsubscribe?.()
            resolve()
          }
        },
      })

      // Timeout after INITIAL_SYNC_TIMEOUT_MS to avoid blocking forever
      setTimeout(() => {
        unsubscribe?.()
        console.warn('PowerSync initial sync timed out, continuing with local data')
        resolve()
      }, INITIAL_SYNC_TIMEOUT_MS)
    })
  }

  async close(): Promise<void> {
    if (this.powerSync) {
      await this.powerSync.disconnectAndClear()
      this.powerSync = null
      this._db = null
      this.connector = null
    }
  }
}
