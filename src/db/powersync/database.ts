/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { withTimeout } from '@/lib/timeout'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { SyncStreamConnectionMethod, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import type { PowerSyncDatabase, WebPowerSyncDatabaseOptions } from '@powersync/web'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import type { DatabaseInterface, AnyDrizzleDatabase } from '../database-interface'
import { getDatabaseInstance } from '../database'
import { AppSchema, drizzleSchema } from './schema'
import { ThunderboltConnector } from './connector'
import { getPlatform, getWebBrowser } from '@/lib/platform'
import { ThunderboltPowerSyncDatabase } from './ThunderboltPowerSyncDatabase'
import { encryptionMiddleware } from './middleware/EncryptionMiddleware'
import {
  getMsSinceLastDownload,
  sanitizeErrorForTracking,
  startSyncStatusListener,
  stopSyncStatusListener,
  trackSyncEvent,
} from './sync-tracker'

/** PowerSync config: default (Chrome/Edge/Firefox web) vs safari-tauri (Safari web, Tauri) */
export type PowerSyncDatabaseConfig = 'default' | 'safari-tauri'

/**
 * Determines which PowerSync database config to use based on platform and browser.
 * - default: Non-Safari web — PowerSync's default setup works well.
 * - safari-tauri: Safari web or Tauri — full WASQLiteOpenFactory with OPFSCoopSyncVFS required.
 */
export const getPowerSyncDatabaseConfig = (
  platform: ReturnType<typeof getPlatform> = getPlatform(),
  browser: ReturnType<typeof getWebBrowser> = getWebBrowser(),
): PowerSyncDatabaseConfig => {
  const isWeb = platform === 'web'
  const isSafari = browser === 'safari'
  if (isWeb && !isSafari) {
    return 'default'
  }
  return 'safari-tauri'
}

/** Max time to wait for initial sync before continuing (e.g. when network is down) */
const initialSyncTimeoutMs = 10_000

/**
 * Sync rule priority we block app init on. Matches the `user_essentials` bucket in
 * `powersync-service/config/config.yaml` (and the PowerSync Cloud dashboard rules):
 * settings, models, modes, model_profiles, devices, chat_threads. Lower-priority buckets
 * (chat_messages, tasks, etc.) stream in the background after the app is interactive.
 *
 * Falls back to global `hasSynced` if the deployed sync rules don't declare priorities yet
 * (see `SyncStatus.statusForPriority`).
 */
const initialSyncPriority = 1

/** Custom event name for sync enabled changes */
export const syncEnabledChangeEvent = 'powersync_sync_enabled_change'

/**
 * Get PowerSync instance from singleton if available.
 * Returns null if not using PowerSync or not initialized.
 */
export const getPowerSyncInstance = (): PowerSyncDatabase | null => {
  try {
    const database = getDatabaseInstance()
    // PowerSyncDatabaseImpl exposes powerSyncInstance as a typed getter, but getDatabaseInstance()
    // returns the DatabaseInterface union which doesn't include PowerSync-specific properties.
    if ('powerSyncInstance' in database) {
      return (database as { powerSyncInstance: PowerSyncDatabase | null }).powerSyncInstance
    }
  } catch {
    // Not initialized or not PowerSync
  }
  return null
}

/**
 * Force a disconnect + reconnect cycle via the singleton database.
 * Guarded against concurrent attempts — no-ops if a reconnect is already in-flight.
 */
export const reconnectSync = async (): Promise<void> => {
  try {
    const database = getDatabaseInstance()
    if ('reconnect' in database) {
      await (database as { reconnect: () => Promise<void> }).reconnect()
    }
  } catch (error) {
    console.warn('Failed to reconnect PowerSync:', error)
  }
}

/**
 * Check if sync is enabled by user preference
 */
export const isSyncEnabled = (): boolean => getLocalSetting('syncEnabled')

/**
 * Set sync enabled preference, connect/disconnect from PowerSync, and dispatch change event
 */
export const setSyncEnabled = async (enabled: boolean): Promise<void> => {
  // Update store and dispatch event
  useLocalSettingsStore.getState().setLocalSetting('syncEnabled', enabled)
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
export const getPowerSyncOptions = (path: string, config: PowerSyncDatabaseConfig = getPowerSyncDatabaseConfig()) => {
  const dbFilename = path.includes('/') ? path.split('/').pop() || 'thunderbolt.db' : path

  if (config === 'default') {
    return {
      database: { dbFilename },
      schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
      transformers: [encryptionMiddleware],
      // Always use the custom SharedWorker that embeds TransformableBucketStorage with encryption middleware.
      // The middleware is data-driven (checks __enc: prefix per-value), so it safely passes through plaintext
      // when E2EE is disabled. This avoids a hard dependency on the /config endpoint at init time — if the
      // fetch fails, encrypted sync data is still decrypted correctly instead of being stored as ciphertext.
      sync: {
        worker: () =>
          new SharedWorker(new URL('./worker/ThunderboltSharedSyncImplementation.worker.ts', import.meta.url), {
            type: 'module',
            name: `shared-sync-${dbFilename}`,
          }),
      },
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
    transformers: [encryptionMiddleware],
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
  private visibilityHandler: (() => void) | null = null
  private hiddenAt: number | null = null
  private _isReconnecting = false

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

    // Always use ThunderboltPowerSyncDatabase with TransformableBucketStorage + encryption middleware.
    // The middleware is data-driven (checks __enc: prefix), so it's a no-op when E2EE is disabled.
    // This removes the hard dependency on /config at init — if the fetch fails, sync still works correctly.
    this.powerSync = new ThunderboltPowerSyncDatabase(options)

    // Wrap with Drizzle for type-safe queries.
    // Cast instance: drizzle-driver expects AbstractPowerSyncDatabase from root @powersync/common; PowerSyncDatabase is from @powersync/web (nested common).
    this._db = wrapPowerSyncWithDrizzle(this.powerSync as unknown as AbstractPowerSyncDatabase, {
      schema: drizzleSchema,
    }) as unknown as AnyDrizzleDatabase

    // Connect to PowerSync Cloud in the background. Do not block app init on the network
    // round-trip: connectToSync transitively awaits PowerSync's _isReadyPromise (WASQLite
    // WASM compile, OPFS setup, schema sync, offline-status read) plus /powersync/token and
    // the Cloud stream open — together ~10s on cold refresh. Local queries via Drizzle still
    // wait on _isReadyPromise internally, and `waitForInitialSync` registers a listener that
    // resolves once `statusForPriority(1).hasSynced` flips true (instant for returning users
    // via offline-status restore, or once the background connect lands for new users).
    if (isSyncEnabled()) {
      void this.connectToSync()
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

    const connectStartedAt = performance.now()
    console.info('[PowerSync] Connecting…')

    // Temporary status listener used only to time the connect() lifecycle; disposed
    // before the long-lived sync-tracker listener is attached below.
    let connectingEnteredAt: number | null = null
    const disposeConnectTimer = this.powerSync.registerListener({
      statusChanged: (status) => {
        if (status.connecting && connectingEnteredAt === null) {
          connectingEnteredAt = performance.now()
          console.info(
            `[PowerSync] connecting=true (${Math.round(connectingEnteredAt - connectStartedAt)}ms after connect start)`,
          )
        } else if (!status.connecting && connectingEnteredAt !== null) {
          console.info(
            `[PowerSync] stream established (${Math.round(performance.now() - connectingEnteredAt)}ms in connecting state)`,
          )
          connectingEnteredAt = null
        }
      },
    })

    try {
      const cloudUrl = getLocalSetting('cloudUrl')
      const connector = new ThunderboltConnector(cloudUrl)
      // Use HTTP streaming to avoid WebSocket "invalid opcode 7" with self-hosted service (ws library).
      const connectInnerStartedAt = performance.now()
      await this.powerSync.connect(connector, {
        connectionMethod: SyncStreamConnectionMethod.HTTP,
        crudUploadThrottleMs: 5000,
      })
      console.info(`[PowerSync] powerSync.connect: ${Math.round(performance.now() - connectInnerStartedAt)}ms`)

      // The fire-and-forget connect from initialize() can race with the user disabling sync
      // mid-flight: disconnectFromSync would no-op while `_isConnected` is still false. Re-check
      // the preference here; if the user opted out during the ~10s connect window, tear down
      // immediately so we don't leave PowerSync connected against their will.
      if (!isSyncEnabled()) {
        console.info('[PowerSync] sync disabled during connect — disconnecting')
        await this.powerSync.disconnect()
        return
      }

      this._isConnected = true
      console.info(`[PowerSync] Connected (total ${Math.round(performance.now() - connectStartedAt)}ms)`)
      this.logFullSyncWhenReady(connectStartedAt)
      startSyncStatusListener(this.powerSync, getPowerSyncDatabaseConfig())
      trackSyncEvent('sync_connect')
      this.startVisibilityReconnect()
    } catch (error) {
      console.warn('Failed to connect to PowerSync Cloud:', error)
      trackSyncEvent('sync_connect_error', { error: sanitizeErrorForTracking(error) })
    } finally {
      disposeConnectTimer()
    }
  }

  /**
   * Logs when the full sync (all priorities) completes, measured from the time connectToSync started.
   * One-shot: disposes itself once `hasSynced` is true.
   */
  private logFullSyncWhenReady(connectStartedAt: number): void {
    if (!this.powerSync) {
      return
    }
    if (this.powerSync.currentStatus?.hasSynced) {
      console.info(
        `[PowerSync] Full sync already complete (${Math.round(performance.now() - connectStartedAt)}ms since connect)`,
      )
      return
    }
    const dispose = this.powerSync.registerListener({
      statusChanged: (status) => {
        if (status.hasSynced) {
          console.info(
            `[PowerSync] Full sync complete (${Math.round(performance.now() - connectStartedAt)}ms since connect)`,
          )
          dispose()
        }
      },
    })
  }

  /**
   * Force a disconnect + reconnect cycle, guarded against concurrent attempts.
   * Used by both the visibility reconnect handler and manual retry button.
   * No-ops if a reconnect is already in-flight or sync is disabled.
   */
  async reconnect(trigger: 'visibility' | 'manual' = 'manual', hiddenDurationMs?: number): Promise<void> {
    if (this._isReconnecting || !this.powerSync || !isSyncEnabled()) {
      return
    }
    this._isReconnecting = true
    trackSyncEvent('sync_reconnect_start', { trigger })
    try {
      trackSyncEvent('sync_disconnect', { trigger: 'reconnect' })
      stopSyncStatusListener()
      await this.powerSync.disconnect()
      this._isConnected = false
      await this.connectToSync()
      if (this._isConnected) {
        trackSyncEvent('sync_reconnect_success', {
          trigger,
          hidden_duration_ms: hiddenDurationMs,
        })
      } else {
        trackSyncEvent('sync_reconnect_error', {
          trigger,
          error: 'connectToSync failed internally',
        })
      }
    } catch (err) {
      console.warn('[PowerSync] Reconnect failed:', err)
      trackSyncEvent('sync_reconnect_error', { trigger, error: sanitizeErrorForTracking(err) })
    } finally {
      this._isReconnecting = false
    }
  }

  /**
   * Reconnect PowerSync when the app returns to foreground after being hidden.
   *
   * Browsers/OS silently kill background HTTP streams. The pending read hangs forever,
   * so PowerSync's `connected` status stays true even though the stream is dead.
   * We track how long the page was hidden — if >15s, the stream is almost certainly
   * dead, so we force disconnect + reconnect to restore it immediately.
   *
   * Only activated for safari-tauri config — on web (default), the SharedWorker
   * keeps the HTTP stream alive independently of page visibility.
   */
  private startVisibilityReconnect(): void {
    if (getPowerSyncDatabaseConfig() !== 'safari-tauri') {
      return
    }
    if (this.visibilityHandler || typeof document === 'undefined') {
      return
    }
    const hiddenThresholdMs = 15_000
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now()
        trackSyncEvent('sync_visibility_change', { state: 'hidden' })
        return
      }
      const hiddenDuration = this.hiddenAt ? Date.now() - this.hiddenAt : undefined
      const willReconnect = Boolean(
        this._isConnected && this.powerSync && this.hiddenAt && hiddenDuration && hiddenDuration >= hiddenThresholdMs,
      )
      trackSyncEvent('sync_visibility_change', {
        state: 'visible',
        hidden_duration_ms: hiddenDuration,
        will_reconnect: willReconnect,
        ms_since_last_download: getMsSinceLastDownload(),
      })
      if (!this._isConnected || !this.powerSync || !this.hiddenAt) {
        return
      }
      this.hiddenAt = null
      if (!hiddenDuration || hiddenDuration < hiddenThresholdMs) {
        return
      }
      console.info(`[PowerSync] App was hidden for ${Math.round(hiddenDuration / 1000)}s — forcing reconnect`)
      void this.reconnect('visibility', hiddenDuration)
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private stopVisibilityReconnect(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
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
      trackSyncEvent('sync_disconnect', { trigger: 'user' })
      this.stopVisibilityReconnect()
      stopSyncStatusListener()
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
   * Wait for PowerSync's priority-1 buckets to complete their initial sync (essentials —
   * settings, models, modes, model_profiles, devices, chat_threads). Lower-priority data
   * (chat_messages, tasks, etc.) continues streaming in the background.
   *
   * Resolves after initialSyncTimeoutMs if sync never completes (e.g. network down).
   */
  async waitForInitialSync(): Promise<void> {
    if (!this.powerSync || !isSyncEnabled()) {
      return
    }

    const startedAt = performance.now()
    console.info(`[PowerSync] Waiting for priority-${initialSyncPriority} sync…`)

    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        console.warn(`[PowerSync] Priority-${initialSyncPriority} sync timed out after ${initialSyncTimeoutMs / 1000}s`)
        resolve()
      }, initialSyncTimeoutMs)
    })

    try {
      await Promise.race([
        this.powerSync.waitForFirstSync({ signal: abortController.signal, priority: initialSyncPriority }),
        timeoutPromise,
      ])
      if (!timedOut) {
        console.info(
          `[PowerSync] Priority-${initialSyncPriority} sync complete (${Math.round(performance.now() - startedAt)}ms)`,
        )
      }
    } catch (error) {
      // First sync is best-effort — the app must boot regardless. Swallow any unexpected
      // rejection so it never propagates to the initialization caller.
      console.warn('[PowerSync] waitForInitialSync failed; continuing without sync gate:', error)
    } finally {
      clearTimeout(timeoutId)
      // Disposes the listener inside waitForFirstSync if the timeout won the race (or if
      // sync already resolved, this is a no-op on the already-disposed listener).
      abortController.abort()
    }
  }

  async close(): Promise<void> {
    this.stopVisibilityReconnect()
    stopSyncStatusListener()
    if (this.powerSync) {
      await this.powerSync.disconnectAndClear()
      this.powerSync = null
      this._db = null
    }
  }
}
