import { getSettings } from '@/dal'
import { defaultSettingCloudUrl } from '@/defaults/settings'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { PowerSyncDatabase, SyncStreamConnectionMethod, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import type { WebPowerSyncDatabaseOptions } from '@powersync/web'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import type { DatabaseInterface, AnyDrizzleDatabase } from '../database-interface'
import { DatabaseSingleton } from '../singleton'
import { AppSchema, drizzleSchema } from './schema'
import { ThunderboltConnector } from './connector'
import { getPlatform } from '@/lib/platform'

/** LocalStorage key for sync enabled flag */
const syncEnabledKey = 'powersync_sync_enabled'

/** Max time to wait for initial sync before continuing (e.g. when network is down) */
const initialSyncTimeoutMs = 10_000

/** Custom event name for sync enabled changes */
export const SYNC_ENABLED_CHANGE_EVENT = 'powersync_sync_enabled_change'

/**
 * Get PowerSync instance from singleton if available.
 * Returns null if not using PowerSync or not initialized.
 */
export const getPowerSyncInstance = (): PowerSyncDatabase | null => {
  try {
    const database = DatabaseSingleton.instance.database
    if ('powerSyncInstance' in database) {
      return (database as { powerSyncInstance: PowerSyncDatabase | null }).powerSyncInstance
    }
  } catch {
    // Not initialized or not PowerSync
  }
  return null
}

/**
 * Check if sync is enabled by user preference
 */
export const isSyncEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(syncEnabledKey) === 'true'
}

/**
 * Set sync enabled preference, connect/disconnect from PowerSync, and dispatch change event
 */
export const setSyncEnabled = async (enabled: boolean): Promise<void> => {
  if (typeof localStorage === 'undefined') return

  // Update localStorage and dispatch event
  localStorage.setItem(syncEnabledKey, String(enabled))
  window.dispatchEvent(new CustomEvent(SYNC_ENABLED_CHANGE_EVENT, { detail: enabled }))

  // Connect or disconnect from PowerSync Cloud
  try {
    const database = DatabaseSingleton.instance.database
    if ('connectToSync' in database && 'disconnectFromSync' in database) {
      if (enabled) {
        await (database as { connectToSync: () => Promise<void> }).connectToSync()
      } else {
        await (database as { disconnectFromSync: () => Promise<void> }).disconnectFromSync()
      }
    }
  } catch (error) {
    console.error('Failed to connect/disconnect from PowerSync:', error)
  }
}

/**
 * PowerSync database implementation.
 * Wraps PowerSyncDatabase with Drizzle for type-safe queries.
 */
export class PowerSyncDatabaseImpl implements DatabaseInterface {
  private powerSync: PowerSyncDatabase | null = null
  private _db: AnyDrizzleDatabase | null = null
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

    const DB_WORKER_PATH = '/@powersync/worker/WASQLiteDB.umd.js'
    const SYNC_WORKER_PATH = '/@powersync/worker/SharedSyncImplementation.umd.js'

    const isIOS = getPlatform() === 'ios'

    // Create PowerSync database.
    // Cast options: @powersync/web uses a nested @powersync/common, so Schema/Table types differ from our Drizzle schema.
    const options: WebPowerSyncDatabaseOptions = {
      database: new WASQLiteOpenFactory({
        dbFilename: dbFilename,
        vfs: isIOS ? WASQLiteVFS.OPFSCoopSyncVFS : WASQLiteVFS.IDBBatchAtomicVFS,
        worker: DB_WORKER_PATH,
        flags: { enableMultiTabs: false },
      }),
      // { dbFilename },
      schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
      // Disable web workers on iOS: WASM + Web Worker memory causes iOS to kill the
      // WKWebView WebContent process (~30s after launch), resulting in a black screen.
      // See: https://github.com/tauri-apps/tauri/issues/14371
      flags: { enableMultiTabs: false },
      sync: { worker: SYNC_WORKER_PATH },
    }
    this.powerSync = new PowerSyncDatabase(options)

    // Wrap with Drizzle for type-safe queries.
    // Cast instance: drizzle-driver expects AbstractPowerSyncDatabase from root @powersync/common; PowerSyncDatabase is from @powersync/web (nested common).
    this._db = wrapPowerSyncWithDrizzle(this.powerSync as unknown as AbstractPowerSyncDatabase, {
      schema: drizzleSchema,
    }) as unknown as AnyDrizzleDatabase

    // Connect to PowerSync Cloud if sync is enabled
    if (isSyncEnabled()) {
      await this.connectToSync()
    }
  }

  /**
   * Connect to PowerSync Cloud for syncing.
   * Call this when user enables sync.
   */
  async connectToSync(): Promise<void> {
    if (!this.powerSync) {
      return
    }

    if (this._isConnected) {
      return // Already connected
    }

    try {
      const { cloudUrl } = await getSettings({ cloud_url: defaultSettingCloudUrl.value })
      const connector = new ThunderboltConnector(cloudUrl ?? defaultSettingCloudUrl.value)
      // Use HTTP streaming to avoid WebSocket "invalid opcode 7" with self-hosted service (ws library).
      await this.powerSync.connect(connector, {
        connectionMethod: SyncStreamConnectionMethod.HTTP,
      })
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
   * Clear pending CRUD operations from PowerSync queue.
   * Useful for returning users to avoid conflicts with cloud data.
   */
  async clearPendingCrudOperations(): Promise<void> {
    if (!this.powerSync) {
      return
    }

    try {
      await this.powerSync.execute('DELETE FROM ps_crud')
    } catch (error) {
      console.warn('Failed to clear pending CRUD operations:', error)
    }
  }

  /**
   * Wait for PowerSync to complete its initial sync.
   * This ensures data from the cloud is available before reconciling defaults.
   * Resolves after initialSyncTimeoutMs if sync never completes (e.g. network down).
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

    let unsubscribe: (() => void) | undefined
    const syncPromise = new Promise<void>((resolve) => {
      unsubscribe = this.powerSync!.registerListener({
        statusChanged: (newStatus) => {
          if (newStatus.hasSynced) {
            unsubscribe?.()
            resolve()
          }
        },
      })
    })

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        unsubscribe?.()
        console.warn('Initial sync timed out after', initialSyncTimeoutMs / 1000, 'seconds')
        resolve()
      }, initialSyncTimeoutMs)
    })

    await Promise.race([syncPromise, timeoutPromise])
  }

  async close(): Promise<void> {
    if (this.powerSync) {
      await this.powerSync.disconnectAndClear()
      this.powerSync = null
      this._db = null
    }
  }
}
