/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting } from '@/stores/local-settings-store'
import { appVersionUnsupported } from '@/lib/app-version-unsupported'
import { isAppVersionUnsupported } from '@/lib/app-version'
import type { CommonPowerSyncDatabase } from '@powersync/common'
import { SyncStreamConnectionMethod, WASQLiteVFS } from '@powersync/web'
import type { PowerSyncDatabase, WebPowerSyncDatabaseOptions } from '@powersync/web'
import { wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver'
import type { DatabaseInterface, AnyDrizzleDatabase, InitialSyncOutcome } from '../database-interface'
import { isSyncEnabled } from './sync-state'
import { getDeviceId } from '@/lib/auth-token'
import { AppSchema, drizzleSchema } from './schema'
import { ThunderboltConnector } from './connector'
import { deleteIndexedDbDatabase, getPlatform, getWebBrowser, hasIndexedDbDatabase, hasOpfsFile } from '@/lib/platform'
import { ThunderboltPowerSyncDatabase } from './ThunderboltPowerSyncDatabase'
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
 * - safari-tauri: Safari web or Tauri — OPFSCoopSyncVFS in dedicated DB and sync workers.
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
 * Sync stream priority we block app init on. Covers `user_essentials` (settings, models,
 * model_profiles, devices, chat_threads) and `device_self` in
 * `powersync-service/config/config.yaml`. The lower-priority `user_data` stream (chat_messages, tasks,
 * etc.) streams in the background after the app is interactive.
 *
 * `device_self` is here so priority 1 is never empty: a revoked device loses every other
 * stream, and that one row is how it learns it was revoked.
 *
 * Falls back to global `hasSynced` if the deployed sync config doesn't declare priorities
 * (see `SyncStatus.statusForPriority`).
 */
const initialSyncPriority = 1

/**
 * Resolve once this device's own row is in the local `devices` table.
 *
 * The account streams are gated on that row, so until it reaches the sync service a
 * just-trusted device gets a priority-1 checkpoint that is complete but empty. The row
 * arrives through `device_self` at the same moment the gated streams unlock.
 * @internal Exported for testing
 */
export const waitForOwnDeviceRow = async (powerSync: CommonPowerSyncDatabase, signal: AbortSignal): Promise<void> => {
  for await (const result of powerSync.watch('SELECT 1 FROM devices WHERE id = ?', [getDeviceId()], { signal })) {
    if (result.array.length) {
      return
    }
  }
}

/** The database filename PowerSync opens: the OPFS file, or the IndexedDB database name. */
const toDbFilename = (path: string) => (path.includes('/') ? path.split('/').pop() || 'thunderbolt.db' : path)

/**
 * OPFS when usable, except on a `default`-config device whose data already lives in IndexedDB:
 * it stays there, so switching never drops local-only rows or queued uploads, until a reset
 * leaves an OPFS database file behind (`resetAppDir`).
 * @internal Exported for testing
 */
export const shouldUseOpfs = async (
  path: string,
  config: PowerSyncDatabaseConfig,
  storage: { opfsRoot?: Pick<FileSystemDirectoryHandle, 'getFileHandle'>; idb?: Pick<IDBFactory, 'databases'> } = {},
): Promise<boolean> => {
  // `getDatabasePath` returns this sentinel when OPFS is unavailable.
  if (path === ':memory:') {
    return false
  }
  const dbFilename = toDbFilename(path)
  if (config === 'safari-tauri' || (await hasOpfsFile(dbFilename, storage.opfsRoot))) {
    return true
  }
  return !(await hasIndexedDbDatabase(dbFilename, storage.idb))
}

/**
 * @internal Exported for testing
 * @param useOpfs - `OPFSCoopSyncVFS` rather than `IDBBatchAtomicVFS` (see `shouldUseOpfs`). On
 * 'safari-tauri' it also decides whether sync runs in a worker or in the tab.
 */
export const getPowerSyncOptions = (path: string, config: PowerSyncDatabaseConfig, useOpfs: boolean) => {
  const dbFilename = toDbFilename(path)
  const vfs = useOpfs ? WASQLiteVFS.OPFSCoopSyncVFS : WASQLiteVFS.IDBBatchAtomicVFS

  if (config === 'default') {
    return {
      database: { dbFilename, vfs },
      schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
      // Always use the custom SharedWorker that runs sync data through the encryption middleware.
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
   * Safari (web) + Tauri (iOS/Desktop).
   * OPFSCoopSyncVFS avoids IDBBatchAtomicVFS + Asyncify ("Maximum call stack size exceeded"
   * on Safari/iOS) and SharedArrayBuffer + SharedWorker (iOS WKWebView black-screen crash).
   * Falls back to IDBBatchAtomicVFS when OPFS is unavailable (e.g. WebKitGTK on Tauri Linux).
   *
   * `enableMultiTabs: true` selects SharedWebStreamingSyncImplementation, which drives the sync
   * worker over Comlink — a dedicated Worker (valid under tauri://) stands in for the SharedWorker,
   * keeping the sync stream off the UI thread.
   *
   * The DB worker is PowerSync's prebuilt worker, loaded from an absolute path because
   * `import.meta.url` fails under tauri:// for node_modules workers. It must be a URL, not a
   * factory: PowerSync posts the DB options to the sync worker, and a function can't be cloned.
   * With a URL PowerSync opens OPFS in a dedicated worker, but the IndexedDB fallback in a
   * SharedWorker whenever `enableMultiTabs` is on — so the fallback turns it off and syncs in
   * the tab instead.
   *
   * Docs: https://docs.powersync.com/debugging/troubleshooting#common-issues
   */
  return {
    database: {
      dbFilename,
      vfs,
      enableMultiTabs: useOpfs,
      worker: '/@powersync/worker.js',
    },
    schema: AppSchema as unknown as WebPowerSyncDatabaseOptions['schema'],
    sync: { worker: () => createDedicatedSyncWorker(dbFilename) },
  }
}

/**
 * Builds the dedicated Worker that hosts the sync stream on iOS/Safari.
 *
 * PowerSync drives a dedicated Worker directly as its Comlink endpoint and terminates it on
 * dispose; only the factory's declared return type is SharedWorker, hence the cast.
 */
const createDedicatedSyncWorker = (dbFilename: string): SharedWorker =>
  new Worker(new URL('./worker/ThunderboltDedicatedSyncImplementation.worker.ts', import.meta.url), {
    type: 'module',
    name: `dedicated-sync-${dbFilename}`,
  }) as unknown as SharedWorker

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
  private versionBlockHandler: (() => void) | null = null
  private vfs: WASQLiteVFS | null = null

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

    const config = getPowerSyncDatabaseConfig()
    const options = getPowerSyncOptions(path, config, await shouldUseOpfs(path, config))
    this.vfs = options.database.vfs
    console.info(
      this.vfs === WASQLiteVFS.OPFSCoopSyncVFS
        ? `[PowerSync] Storage: OPFS /${options.database.dbFilename}`
        : `[PowerSync] Storage: IndexedDB database "${options.database.dbFilename}"`,
    )
    // A reset deletes the IndexedDB database, but another tab holding it open can delay that.
    if (
      this.vfs === WASQLiteVFS.OPFSCoopSyncVFS &&
      config === 'default' &&
      (await hasIndexedDbDatabase(options.database.dbFilename))
    ) {
      void deleteIndexedDbDatabase(options.database.dbFilename).catch((error) =>
        console.error('[PowerSync] Failed to delete the old IndexedDB database:', error),
      )
    }

    // Always use ThunderboltPowerSyncDatabase so sync data runs through the encryption middleware.
    // The middleware is data-driven (checks __enc: prefix), so it's a no-op when E2EE is disabled.
    // This removes the hard dependency on /config at init — if the fetch fails, sync still works correctly.
    this.powerSync = new ThunderboltPowerSyncDatabase(options)

    // Wrap with Drizzle for type-safe queries.
    this._db = wrapPowerSyncWithDrizzle(this.powerSync, {
      schema: drizzleSchema,
    }) as unknown as AnyDrizzleDatabase

    // Connect to PowerSync Cloud in the background. Do not block app init on the network
    // round-trip: connectToSync transitively awaits PowerSync's _isReadyPromise (WASQLite
    // WASM compile, OPFS setup, schema sync, offline-status read) plus /powersync/token and
    // the Cloud stream open — together ~10s on cold refresh. Local queries via Drizzle still
    // wait on _isReadyPromise internally, and `waitForInitialSync` registers a listener that
    // resolves once `statusForPriority(1).hasSynced` flips true (instant for returning users
    // via offline-status restore, or once the background connect lands for new users).
    // Registered before the background connect so a 426 arriving mid-connect is caught.
    this.startVersionBlockListener()

    if (isSyncEnabled()) {
      void this.connectToSync()
    }
  }

  /**
   * Tear sync down the instant OUR backend rejects this build's version (HTTP
   * 426). A version-blocked client must not hold a sync stream: its local writes
   * would keep queuing in `ps_crud` and then flush after the upgrade, before the
   * E2EE keyring is provisioned — which is how plaintext reaches the server.
   *
   * The user's `syncEnabled` preference is deliberately left untouched (this is a
   * transient server-side block, not an opt-out), so sync resumes on its own once
   * the upgraded build connects. `isAppVersionUnsupported()` — which also covers
   * the persisted-config case, where a returning stale client is blocked before
   * any request is rejected — keeps `connectToSync` from re-opening the stream.
   */
  private startVersionBlockListener(): void {
    if (this.versionBlockHandler || typeof window === 'undefined') {
      return
    }
    this.versionBlockHandler = () => {
      console.warn('[PowerSync] App version rejected by backend (426) — disconnecting sync')
      void this.disconnectFromSync('version_blocked')
    }
    window.addEventListener(appVersionUnsupported, this.versionBlockHandler)
  }

  private stopVersionBlockListener(): void {
    if (this.versionBlockHandler) {
      window.removeEventListener(appVersionUnsupported, this.versionBlockHandler)
      this.versionBlockHandler = null
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

    if (isAppVersionUnsupported()) {
      console.info('[PowerSync] Skipping connect — app version rejected by backend')
      return
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

      // Same race for the version gate: a 426 landing during the connect window
      // fires the listener while `_isConnected` is still false, so its
      // disconnectFromSync no-ops. Re-check here or we'd leave a blocked client
      // holding a live stream.
      if (isAppVersionUnsupported()) {
        console.info('[PowerSync] app version rejected during connect — disconnecting')
        await this.powerSync.disconnect()
        return
      }

      this._isConnected = true
      console.info(`[PowerSync] Connected (total ${Math.round(performance.now() - connectStartedAt)}ms)`)
      this.logFullSyncWhenReady(connectStartedAt)
      startSyncStatusListener(this.powerSync, getPowerSyncDatabaseConfig(), this.vfs)
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
    if (this._isReconnecting || !this.powerSync || !isSyncEnabled() || isAppVersionUnsupported()) {
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
   * Call this when user disables sync. `trigger` distinguishes that from the
   * involuntary teardown when the backend rejects this build's version.
   */
  async disconnectFromSync(trigger: 'user' | 'version_blocked' = 'user'): Promise<void> {
    if (!this.powerSync || !this._isConnected) {
      return
    }

    try {
      trackSyncEvent('sync_disconnect', { trigger })
      this.stopVisibilityReconnect()
      stopSyncStatusListener()
      await this.powerSync.disconnect()
      this._isConnected = false
    } catch (error) {
      console.warn('Failed to disconnect from PowerSync Cloud:', error)
    }
  }

  /**
   * Wait for PowerSync's priority-1 streams to complete their initial sync (`user_essentials` —
   * settings, models, model_profiles, devices, chat_threads — and `device_self`). Lower-priority data
   * (chat_messages, tasks, etc.) continues streaming in the background. Also waits for this
   * device's own row, without which priority 1 can complete empty (see `waitForOwnDeviceRow`).
   *
   * Resolves after initialSyncTimeoutMs if sync never completes (e.g. network down).
   */
  async waitForInitialSync(): Promise<InitialSyncOutcome> {
    if (!this.powerSync || !isSyncEnabled()) {
      return 'disabled'
    }

    const startedAt = performance.now()
    console.info(`[PowerSync] Waiting for priority-${initialSyncPriority} sync…`)

    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        console.warn(`[PowerSync] Initial sync timed out after ${initialSyncTimeoutMs / 1000}s`)
        resolve()
      }, initialSyncTimeoutMs)
    })

    try {
      const powerSync = this.powerSync
      await Promise.race([
        (async () => {
          await powerSync.waitForFirstSync({ signal: abortController.signal, priority: initialSyncPriority })
          await waitForOwnDeviceRow(powerSync, abortController.signal)
        })(),
        timeoutPromise,
      ])
      if (timedOut) {
        return 'timed_out'
      }
      console.info(
        `[PowerSync] Priority-${initialSyncPriority} sync complete (${Math.round(performance.now() - startedAt)}ms)`,
      )
      return 'synced'
    } catch (error) {
      // First sync is best-effort — the app must boot regardless. Swallow any unexpected
      // rejection so it never propagates to the initialization caller.
      console.warn('[PowerSync] waitForInitialSync failed; continuing without sync gate:', error)
      return 'failed'
    } finally {
      clearTimeout(timeoutId)
      // Disposes the listener inside waitForFirstSync if the timeout won the race (or if
      // sync already resolved, this is a no-op on the already-disposed listener).
      abortController.abort()
    }
  }

  async close(): Promise<void> {
    this.stopVisibilityReconnect()
    this.stopVersionBlockListener()
    stopSyncStatusListener()
    if (this.powerSync) {
      await this.powerSync.disconnectAndClear()
      // Releases the storage too, so a reset can delete the OPFS file or the IndexedDB database.
      await this.powerSync.close()
      this.powerSync = null
      this._db = null
    }
  }
}
