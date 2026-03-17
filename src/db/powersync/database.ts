import { getSettings } from '@/dal'
import { defaultSettingCloudUrl } from '@/defaults/settings'
import { withTimeout } from '@/lib/timeout'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { PowerSyncDatabase, SyncStreamConnectionMethod, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import type { WebPowerSyncDatabaseOptions } from '@powersync/web'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import type { DatabaseInterface, AnyDrizzleDatabase } from '../database-interface'
import { getDatabaseInstance } from '../database'
import { AppSchema, drizzleSchema } from './schema'
import { ThunderboltConnector } from './connector'
import { setupDecryptionWatchers } from '../encryption'
import { getPlatform, getWebBrowser } from '@/lib/platform'

/** PowerSync config: default (Chrome/Edge/Firefox web) vs safari-tauri (Safari web, Tauri) */
export type PowerSyncDatabaseConfig = 'default' | 'safari-tauri'

/**
 * Determines which PowerSync database config to use based on platform and browser.
 * - default: Non-Safari web — PowerSync's default setup works well.
 * - safari-tauri: Safari web or Tauri — full WASQLiteOpenFactory with OPFSCoopSyncVFS required.
 */
export const getPowerSyncDatabaseConfig = (): PowerSyncDatabaseConfig => {
  const isWeb = getPlatform() === 'web'
  const isSafari = getWebBrowser() === 'safari'
  if (isWeb && !isSafari) {
    return 'default'
  }
  return 'safari-tauri'
}

/** LocalStorage key for sync enabled flag */
const syncEnabledKey = 'powersync_sync_enabled'

/** Max time to wait for initial sync before continuing (e.g. when network is down) */
const initialSyncTimeoutMs = 10_000

/** Custom event name for sync enabled changes */
export const syncEnabledChangeEvent = 'powersync_sync_enabled_change'

/**
 * Get PowerSync instance from singleton if available.
 * Returns null if not using PowerSync or not initialized.
 */
export const getPowerSyncInstance = (): PowerSyncDatabase | null => {
  try {
    const database = getDatabaseInstance()
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
  if (typeof localStorage === 'undefined') {
    return false
  }
  return localStorage.getItem(syncEnabledKey) === 'true'
}

/**
 * Set sync enabled preference, connect/disconnect from PowerSync, and dispatch change event
 */
export const setSyncEnabled = async (enabled: boolean): Promise<void> => {
  if (typeof localStorage === 'undefined') {
    return
  }

  // Update localStorage and dispatch event
  localStorage.setItem(syncEnabledKey, String(enabled))
  window.dispatchEvent(new CustomEvent(syncEnabledChangeEvent, { detail: enabled }))

  // Connect or disconnect from PowerSync Cloud
  try {
    const database = getDatabaseInstance()
    if ('connectToSync' in database && 'disconnectFromSync' in database) {
      if (enabled) {
        await (database as { connectToSync: () => Promise<void> }).connectToSync()
      } else {
        await withTimeout(
          (database as { disconnectFromSync: () => Promise<void> }).disconnectFromSync(),
          10_000,
          'disconnectFromSync',
        )
      }
    }
  } catch (error) {
    console.error('Failed to connect/disconnect from PowerSync:', error)
  }
}

/** @internal Exported for testing */
export const getPowerSyncOptions = (path: string) => {
  const dbFilename = path.includes('/') ? path.split('/').pop() || 'thunderbolt.db' : path
  const config = getPowerSyncDatabaseConfig()

  if (config === 'default') {
    return {
      database: { dbFilename },
      schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
    }
  }

  /**
   * Safari (web) + Tauri (iOS/Desktop): Full WASQLiteOpenFactory required.
   * OPFSCoopSyncVFS — synchronous OPFS handles. Avoids IDBBatchAtomicVFS + Asyncify
   * (causes "Maximum call stack size exceeded" on Safari/iOS; JSC has smaller stack than V8)
   * and SharedArrayBuffer + SharedWorker (exceeds iOS WKWebView memory, black-screen crash).
   * Explicit UMD worker paths — bypasses import.meta.url which fails under tauri://.
   * enableMultiTabs: false — dedicated worker, not SharedWorker (fails under tauri://).
   *
   * Docs: https://docs.powersync.com/debugging/troubleshooting#common-issues
   */
  return {
    database: new WASQLiteOpenFactory({
      dbFilename: dbFilename,
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      worker: '/@powersync/worker/WASQLiteDB.umd.js',
      flags: { enableMultiTabs: false },
    }),
    schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
    flags: { enableMultiTabs: false },
    sync: { worker: '/@powersync/worker/SharedSyncImplementation.umd.js' },
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
  private cleanupDecryptionWatcher: (() => Promise<void>) | null = null

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

    const options = getPowerSyncOptions(path)

    this.powerSync = new PowerSyncDatabase(options)

    // Wrap with Drizzle for type-safe queries.
    // Cast instance: drizzle-driver expects AbstractPowerSyncDatabase from root @powersync/common; PowerSyncDatabase is from @powersync/web (nested common).
    this._db = wrapPowerSyncWithDrizzle(this.powerSync as unknown as AbstractPowerSyncDatabase, {
      schema: drizzleSchema,
    }) as unknown as AnyDrizzleDatabase

    // Set up trigger-based decryption watchers for all encrypted tables
    this.cleanupDecryptionWatcher = await setupDecryptionWatchers(this.powerSync)

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
    if (!this.powerSync || !this._db) {
      return
    }

    if (this._isConnected) {
      return // Already connected
    }

    try {
      const { cloudUrl } = await getSettings(this._db, { cloud_url: defaultSettingCloudUrl.value })
      const connector = new ThunderboltConnector(cloudUrl ?? defaultSettingCloudUrl.value)
      // Use HTTP streaming to avoid WebSocket "invalid opcode 7" with self-hosted service (ws library).
      await this.powerSync.connect(connector, {
        connectionMethod: SyncStreamConnectionMethod.HTTP,
        crudUploadThrottleMs: 5000,
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
    if (this.cleanupDecryptionWatcher) {
      await this.cleanupDecryptionWatcher()
      this.cleanupDecryptionWatcher = null
    }
    if (this.powerSync) {
      await this.powerSync.disconnectAndClear()
      this.powerSync = null
      this._db = null
    }
  }
}
