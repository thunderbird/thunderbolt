/**
 * Sync service for cr-sqlite database synchronization
 * Handles change tracking and sync coordination between devices
 */

import type { KyInstance } from 'ky'
import type { CRSQLChange } from './crsqlite-worker'
import { DatabaseSingleton } from './singleton'

const SYNC_VERSION_KEY = 'thunderbolt_sync_version'
const SYNC_SERVER_VERSION_KEY = 'thunderbolt_server_version'
const SITE_ID_KEY = 'thunderbolt_site_id'

/**
 * Serialized change format for network transport
 * Uses base64 for binary data (pk, site_id)
 */
export type SerializedChange = {
  table: string
  pk: string // base64 encoded
  cid: string
  val: unknown
  col_version: string // bigint as string
  db_version: string // bigint as string
  site_id: string // base64 encoded
  cl: number
  seq: number
}

/**
 * Response from sync push endpoint
 */
type SyncPushResponse = {
  success: boolean
  serverVersion: string
}

/**
 * Response from sync pull endpoint
 */
type SyncPullResponse = {
  changes: SerializedChange[]
  serverVersion: string
}

/**
 * Encode Uint8Array to base64 string
 */
const encodeBase64 = (data: Uint8Array): string => {
  const bytes = Array.from(data)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Decode base64 string to Uint8Array
 */
const decodeBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Serialize a CRSQLChange for network transport
 */
const serializeChange = (change: CRSQLChange): SerializedChange => ({
  table: change.table,
  pk: encodeBase64(change.pk),
  cid: change.cid,
  val: change.val,
  col_version: change.col_version.toString(),
  db_version: change.db_version.toString(),
  site_id: encodeBase64(change.site_id),
  cl: change.cl,
  seq: change.seq,
})

/**
 * Deserialize a network change to CRSQLChange
 */
const deserializeChange = (serialized: SerializedChange): CRSQLChange => ({
  table: serialized.table,
  pk: decodeBase64(serialized.pk),
  cid: serialized.cid,
  val: serialized.val,
  col_version: BigInt(serialized.col_version),
  db_version: BigInt(serialized.db_version),
  site_id: decodeBase64(serialized.site_id),
  cl: serialized.cl,
  seq: serialized.seq,
})

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

export type SyncServiceOptions = {
  httpClient: KyInstance
  syncIntervalMs?: number
  onStatusChange?: (status: SyncStatus) => void
  onError?: (error: Error) => void
}

export class SyncService {
  private httpClient: KyInstance
  private syncIntervalMs: number
  private syncIntervalId: ReturnType<typeof setInterval> | null = null
  private status: SyncStatus = 'idle'
  private onStatusChange?: (status: SyncStatus) => void
  private onError?: (error: Error) => void
  private isSyncing = false

  constructor(options: SyncServiceOptions) {
    this.httpClient = options.httpClient
    this.syncIntervalMs = options.syncIntervalMs ?? 30000 // Default 30 seconds
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
  }

  /**
   * Get the last synced local db version
   */
  private getLastSyncedVersion(): bigint {
    const stored = localStorage.getItem(SYNC_VERSION_KEY)
    return stored ? BigInt(stored) : 0n
  }

  /**
   * Set the last synced local db version
   */
  private setLastSyncedVersion(version: bigint): void {
    localStorage.setItem(SYNC_VERSION_KEY, version.toString())
  }

  /**
   * Get the last known server version
   */
  private getServerVersion(): bigint {
    const stored = localStorage.getItem(SYNC_SERVER_VERSION_KEY)
    return stored ? BigInt(stored) : 0n
  }

  /**
   * Set the last known server version
   */
  private setServerVersion(version: bigint): void {
    localStorage.setItem(SYNC_SERVER_VERSION_KEY, version.toString())
  }

  /**
   * Get or register site ID for this device
   */
  async getSiteId(): Promise<string> {
    // Check localStorage first
    const storedSiteId = localStorage.getItem(SITE_ID_KEY)
    if (storedSiteId) {
      return storedSiteId
    }

    // Get from database
    const db = DatabaseSingleton.instance.syncableDatabase
    const siteId = await db.getSiteId()

    // Store in localStorage for quick access
    localStorage.setItem(SITE_ID_KEY, siteId)

    return siteId
  }

  /**
   * Update the sync status
   */
  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status
      this.onStatusChange?.(status)
    }
  }

  /**
   * Get local changes since last sync
   */
  async getLocalChanges(): Promise<{ changes: CRSQLChange[]; dbVersion: bigint }> {
    const db = DatabaseSingleton.instance.syncableDatabase
    const lastSyncedVersion = this.getLastSyncedVersion()
    return db.getChanges(lastSyncedVersion)
  }

  /**
   * Apply remote changes to local database
   */
  async applyRemoteChanges(changes: CRSQLChange[]): Promise<void> {
    if (changes.length === 0) return

    const db = DatabaseSingleton.instance.syncableDatabase
    await db.applyChanges(changes)
  }

  /**
   * Push local changes to the server
   */
  async pushChanges(): Promise<boolean> {
    const { changes, dbVersion } = await this.getLocalChanges()

    if (changes.length === 0) {
      // No local changes to push
      return true
    }

    const siteId = await this.getSiteId()
    const serializedChanges = changes.map(serializeChange)

    const response = await this.httpClient
      .post('sync/push', {
        json: {
          siteId,
          changes: serializedChanges,
          dbVersion: dbVersion.toString(),
        },
      })
      .json<SyncPushResponse>()

    if (response.success) {
      // Update last synced version
      this.setLastSyncedVersion(dbVersion)
      this.setServerVersion(BigInt(response.serverVersion))
      return true
    }

    return false
  }

  /**
   * Pull changes from the server
   */
  async pullChanges(): Promise<boolean> {
    const serverVersion = this.getServerVersion()
    const siteId = await this.getSiteId()

    const response = await this.httpClient
      .get('sync/pull', {
        searchParams: {
          since: serverVersion.toString(),
          siteId,
        },
      })
      .json<SyncPullResponse>()

    if (response.changes.length > 0) {
      const changes = response.changes.map(deserializeChange)
      await this.applyRemoteChanges(changes)
    }

    this.setServerVersion(BigInt(response.serverVersion))
    return true
  }

  /**
   * Perform a full sync (push local changes, then pull remote changes)
   */
  async sync(): Promise<void> {
    if (this.isSyncing) {
      return // Already syncing
    }

    if (!DatabaseSingleton.instance.supportsSyncing) {
      return // Database doesn't support syncing
    }

    this.isSyncing = true
    this.setStatus('syncing')

    try {
      // Push local changes first
      await this.pushChanges()

      // Then pull remote changes
      await this.pullChanges()

      this.setStatus('idle')
    } catch (error) {
      const errorInstance = error instanceof Error ? error : new Error(String(error))

      // Check if it's a network error
      if (errorInstance.message.includes('Failed to fetch') || errorInstance.message.includes('NetworkError')) {
        this.setStatus('offline')
      } else {
        this.setStatus('error')
        this.onError?.(errorInstance)
      }

      console.error('Sync failed:', error)
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Start periodic sync
   */
  start(): void {
    if (this.syncIntervalId) {
      return // Already started
    }

    // Do an initial sync
    this.sync()

    // Set up periodic sync
    this.syncIntervalId = setInterval(() => {
      this.sync()
    }, this.syncIntervalMs)

    console.info(`Sync service started with ${this.syncIntervalMs}ms interval`)
  }

  /**
   * Stop periodic sync
   */
  stop(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId)
      this.syncIntervalId = null
      console.info('Sync service stopped')
    }
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Force an immediate sync
   */
  async forceSync(): Promise<void> {
    await this.sync()
  }
}

// Singleton instance
let syncServiceInstance: SyncService | null = null

/**
 * Initialize the sync service singleton
 */
export const initSyncService = (options: SyncServiceOptions): SyncService => {
  if (syncServiceInstance) {
    syncServiceInstance.stop()
  }
  syncServiceInstance = new SyncService(options)
  return syncServiceInstance
}

/**
 * Get the sync service singleton
 */
export const getSyncService = (): SyncService | null => {
  return syncServiceInstance
}
