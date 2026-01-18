/**
 * WebSocket-based sync service for cr-sqlite database synchronization
 * Provides real-time change streaming between devices via persistent WebSocket connection
 */

import { getAuthToken } from '@/lib/auth-token'
import { getLatestMigrationVersion } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import {
  applyPullChanges,
  extractChatThreadIds,
  handlePushSuccess,
  preparePush,
  type PullResponse,
  type PushResponse,
  type SerializedChange,
} from './core'
import { getServerVersion, getSiteId, setServerVersion } from './utils'

// Re-export for external consumers
export type { SerializedChange } from './core'

/**
 * WebSocket message types
 */
type WSMessage =
  | { type: 'auth'; siteId: string; migrationVersion?: string; token?: string }
  | { type: 'push'; changes: SerializedChange[]; dbVersion: string }
  | { type: 'pull'; since: string }

type WSResponse =
  | { type: 'auth_success'; serverVersion: string }
  | { type: 'auth_error'; error: string }
  | { type: 'push_success'; serverVersion: string }
  | { type: 'push_error'; error: string }
  | { type: 'changes'; changes: SerializedChange[]; serverVersion: string }
  | { type: 'version_mismatch'; requiredVersion: string }

export type SyncStatus = 'idle' | 'connecting' | 'connected' | 'syncing' | 'error' | 'offline' | 'version_mismatch'

export type SyncServiceOptions = {
  /** WebSocket URL (e.g., ws://localhost:3000/v1/sync/ws) */
  wsUrl: string
  onStatusChange?: (status: SyncStatus) => void
  onError?: (error: Error) => void
  /** Called when tables have been updated from remote changes */
  onTablesChanged?: (tables: string[]) => void
  /** Called when a version mismatch is detected (client needs upgrade) */
  onVersionMismatch?: (requiredVersion: string) => void
  /** Called when chat sessions have been updated from remote changes */
  onChatSessionsChanged?: (chatThreadIds: string[]) => void
}

export class SyncService {
  private wsUrl: string
  private ws: WebSocket | null = null
  private status: SyncStatus = 'idle'
  private onStatusChange?: (status: SyncStatus) => void
  private onError?: (error: Error) => void
  private onTablesChanged?: (tables: string[]) => void
  private onVersionMismatch?: (requiredVersion: string) => void
  private onChatSessionsChanged?: (chatThreadIds: string[]) => void
  private _requiredVersion: string | null = null
  private _isOnline: boolean
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null
  private isRunning = false
  private isPushingChanges = false
  private dbChangeListener: (() => void) | null = null
  private lastPushedVersion = 0n

  private handleOnline = () => this.handleNetworkChange(true)
  private handleOffline = () => this.handleNetworkChange(false)

  constructor(options: SyncServiceOptions) {
    this._isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
    this.wsUrl = options.wsUrl
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
    this.onTablesChanged = options.onTablesChanged
    this.onVersionMismatch = options.onVersionMismatch
    this.onChatSessionsChanged = options.onChatSessionsChanged
  }

  get requiredVersion(): string | null {
    return this._requiredVersion
  }

  get isOnline(): boolean {
    return this._isOnline
  }

  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status
      this.onStatusChange?.(status)
    }
  }

  private handleNetworkChange(isOnline: boolean): void {
    const wasOffline = !this._isOnline
    this._isOnline = isOnline

    if (!isOnline) {
      this.setStatus('offline')
      this.disconnect()
    } else if (wasOffline && this.isRunning) {
      this.setStatus('idle')
      this.connect()
    }
  }

  private async connect(): Promise<void> {
    if (!DatabaseSingleton.instance.supportsSyncing) {
      return
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    if (!this._isOnline) {
      this.setStatus('offline')
      return
    }

    this.setStatus('connecting')

    try {
      this.ws = new WebSocket(this.wsUrl)

      this.ws.onopen = async () => {
        console.info('WebSocket connected, authenticating...')
        this.reconnectAttempts = 0

        // Authenticate with bearer token
        const siteId = await getSiteId()
        const migrationVersion = getLatestMigrationVersion()
        const token = getAuthToken()

        this.send({
          type: 'auth',
          siteId,
          migrationVersion,
          token: token ?? undefined,
        })
      }

      this.ws.onmessage = async (event) => {
        try {
          const response = JSON.parse(event.data) as WSResponse
          await this.handleMessage(response)
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error)
        }
      }

      this.ws.onerror = (event) => {
        console.error('WebSocket error:', event)
        this.setStatus('error')
        this.onError?.(new Error('WebSocket connection error'))
      }

      this.ws.onclose = () => {
        console.info('WebSocket closed')
        this.ws = null

        if (this.isRunning && this._isOnline && this.status !== 'version_mismatch') {
          this.scheduleReconnect()
        }
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
      this.setStatus('error')
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.scheduleReconnect()
    }
  }

  private async handleMessage(response: WSResponse): Promise<void> {
    switch (response.type) {
      case 'auth_success': {
        console.info('WebSocket authenticated, server version:', response.serverVersion)
        this.setStatus('connected')
        setServerVersion(BigInt(response.serverVersion))

        // Request any changes we might have missed while offline
        const serverVersion = getServerVersion()
        this.send({ type: 'pull', since: serverVersion.toString() })

        // Set up database change listener for real-time push
        await this.setupDbChangeListener()

        // Push any pending local changes
        await this.pushLocalChanges()
        break
      }

      case 'auth_error': {
        console.error('WebSocket auth error:', response.error)
        this.setStatus('error')
        this.onError?.(new Error(response.error))
        this.disconnect()
        break
      }

      case 'push_success': {
        console.info('Push successful, server version:', response.serverVersion)
        const pushResponse: PushResponse = { success: true, serverVersion: response.serverVersion }
        handlePushSuccess(pushResponse, this.lastPushedVersion)
        this.isPushingChanges = false

        // Push any pending changes that accumulated during the push
        const prepared = await preparePush()
        if (prepared && prepared.changes.length > 0) {
          await this.pushLocalChanges()
        } else {
          this.setStatus('connected')
        }
        break
      }

      case 'push_error': {
        console.error('Push error:', response.error)
        this.isPushingChanges = false
        this.setStatus('error')
        this.onError?.(new Error(response.error))
        break
      }

      case 'changes': {
        console.info(`Received ${response.changes.length} changes from server`)

        if (response.changes.length > 0) {
          // Apply changes using core function
          const pullResponse: PullResponse = {
            changes: response.changes,
            serverVersion: response.serverVersion,
          }
          const affectedTables = await applyPullChanges(pullResponse.changes)
          this.onTablesChanged?.(affectedTables)

          // Extract chat thread IDs using core function
          const affectedChatThreadIds = extractChatThreadIds(response.changes)
          if (affectedChatThreadIds.length > 0) {
            this.onChatSessionsChanged?.(affectedChatThreadIds)
          }
        }

        setServerVersion(BigInt(response.serverVersion))
        break
      }

      case 'version_mismatch': {
        console.warn('Version mismatch, required:', response.requiredVersion)
        this._requiredVersion = response.requiredVersion
        this.setStatus('version_mismatch')
        this.onVersionMismatch?.(response.requiredVersion)
        this.stop()
        break
      }
    }
  }

  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached')
      this.setStatus('error')
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 32s)
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 32000)
    this.reconnectAttempts++

    console.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`)

    this.reconnectTimeoutId = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private disconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }

    if (this.ws) {
      this.ws.onclose = null // Prevent reconnect on intentional close
      this.ws.close()
      this.ws = null
    }

    this.removeDbChangeListener()
  }

  private async setupDbChangeListener(): Promise<void> {
    const db = DatabaseSingleton.instance.syncableDatabase

    // Subscribe to change notifications in the worker
    await db.subscribeToChanges()

    // Set up listener that triggers when any table changes
    // This uses @vlcn.io/rx-tbl under the hood for reactive updates
    const unsubscribe = db.onTablesChanged(() => {
      if (this.ws?.readyState === WebSocket.OPEN && !this.isPushingChanges) {
        this.pushLocalChanges()
      }
    })

    this.dbChangeListener = () => {
      unsubscribe()
      db.unsubscribeFromChanges().catch(console.error)
    }
  }

  private removeDbChangeListener(): void {
    if (this.dbChangeListener) {
      this.dbChangeListener()
      this.dbChangeListener = null
    }
  }

  private async pushLocalChanges(): Promise<void> {
    if (!DatabaseSingleton.instance.supportsSyncing) {
      return
    }

    if (this.isPushingChanges) {
      return
    }

    if (this.ws?.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      // Use core function to prepare push
      const prepared = await preparePush()

      if (!prepared) {
        return
      }

      this.isPushingChanges = true
      this.setStatus('syncing')
      this.lastPushedVersion = prepared.rawDbVersion

      this.send({
        type: 'push',
        changes: prepared.changes,
        dbVersion: prepared.dbVersion,
      })

      console.info(`Pushing ${prepared.changes.length} local changes`)
    } catch (error) {
      console.error('Failed to push local changes:', error)
      this.isPushingChanges = false
      this.setStatus('error')
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Start the sync service
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true

    // Listen for network status changes
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
    }

    // Update online status
    if (typeof navigator !== 'undefined') {
      this._isOnline = navigator.onLine
    }

    // Connect WebSocket
    this.connect()

    console.info('WebSocket sync service started')
  }

  /**
   * Stop the sync service
   */
  stop(): void {
    this.isRunning = false

    // Remove network status listeners
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
    }

    this.disconnect()
    console.info('WebSocket sync service stopped')
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Force an immediate sync (push + pull)
   */
  async forceSync(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect()
      return
    }

    await this.pushLocalChanges()

    const serverVersion = getServerVersion()
    this.send({ type: 'pull', since: serverVersion.toString() })
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
