/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetchConfig } from '@/api/config'
import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { getAuthToken } from '@/lib/auth-token'
import { Database, getCurrentDatabase, setDatabase } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getLocalSetting } from '@/stores/local-settings-store'
import { createHandleError } from '@/lib/error-utils'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { isSsoMode } from '@/lib/auth-mode'
import { createAuthenticatedClient } from '@/lib/http'
import { beginInitRun, getInitTimingPayload, recordInitStep } from '@/lib/init-timing'
import { getDatabasePath, getDatabaseType, getPlatform, isIndexedDbAvailable } from '@/lib/platform'
import { initPosthog, trackError, trackEvent } from '@/lib/posthog'
import { runDataMigrations } from '@/lib/data-migrations'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { TrayManager } from '@/lib/tray'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { PostHog } from 'posthog-js'
import { sql } from 'drizzle-orm'
import { useCallback, useEffect, useState } from 'react'

const createAppDirectory = async (): Promise<string> => {
  return await createAppDir()
}

const initializeDatabase = async (appDirPath: string): Promise<{ db: AnyDrizzleDatabase; database: Database }> => {
  const existing = getCurrentDatabase()
  if (existing?.isInitialized) {
    return { db: existing.db, database: existing }
  }

  const databaseType = await getDatabaseType()
  const dbPath = await getDatabasePath(databaseType, appDirPath)

  const database = new Database()
  const db = await database.initialize({ type: databaseType, path: dbPath })
  setDatabase(database)
  return { db, database }
}

type TrayInitResult = { tray: TrayIcon | undefined; window: Window | undefined }

const initializeTray = async (): Promise<TrayInitResult> => {
  return await TrayManager.initIfSupported()
}

const initializePostHog = async (httpClient?: HttpClient): Promise<PostHog | null> => {
  const result = await initPosthog(httpClient)
  return result.success ? result.data : null
}

const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    const durationMs = performance.now() - startedAt
    recordInitStep(label, durationMs)
    console.info(`[init] ${label}: ${Math.round(durationMs)}ms`)
  }
}

/** Step 7 wrapper: never throws — falls back to an empty tray on failure. */
const initializeTraySafely = async (): Promise<TrayInitResult> => {
  try {
    return await time('step7_initialize_tray', () => initializeTray())
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
    return { tray: undefined, window: undefined }
  }
}

/** Step 8 wrapper: never throws — falls back to a null PostHog client on failure. */
const initializePostHogSafely = async (httpClient: HttpClient): Promise<PostHog | null> => {
  try {
    return await time('step8_initialize_posthog', () => initializePostHog(httpClient))
  } catch (error) {
    console.warn('Unexpected error during PostHog initialization:', error)
    return null
  }
}

const executeInitializationSteps = async (httpClient?: HttpClient): Promise<HandleResult<InitData>> => {
  beginInitRun()
  const totalStartedAt = performance.now()
  console.info('[init] start')

  // Step 0: Fetch backend config and hydrate store (only on success).
  // When fetch fails (offline/error), the store retains its persisted localStorage value.
  // Not awaited here: nothing in this pipeline consumes the config (it is read
  // reactively from the store later), so it overlaps with the steps below
  // (including the storage probe) and is only awaited at the end to land its
  // duration in app_init_timing.
  const fetchConfigPromise = time('step0_fetch_config', () => fetchConfig(getLocalSetting('cloudUrl'), httpClient))

  // Step 0.5: Storage pre-flight. IndexedDB is required by both the local
  // PowerSync VFS (web) and the E2EE key store (all platforms). iOS Lockdown
  // Mode disables it, which would otherwise hang the app on the loading spinner
  // — detect it before the DB steps and surface a friendly screen. Kicked off
  // after the config fetch so the network request overlaps the probe.
  const storageAvailable = await time('step0_5_storage_check', () => isIndexedDbAvailable())
  if (!storageAvailable) {
    const storageError = createHandleError('STORAGE_UNAVAILABLE', 'Storage (IndexedDB) is unavailable')
    trackError(storageError, { initialization_step: 'storage_check' })
    return { success: false, error: storageError }
  }

  // Step 1: App directory creation
  let appDirPath: string
  try {
    appDirPath = await time('step1_create_app_dir', () => createAppDirectory())
  } catch (error) {
    console.error('Failed to create app directory:', error)
    const appDirError = createHandleError('APP_DIR_CREATION_FAILED', 'Failed to create app directory', error)
    trackError(appDirError, { initialization_step: 'app_directory' })
    return {
      success: false,
      error: appDirError,
    }
  }

  // Step 2: Database initialization
  let db: AnyDrizzleDatabase
  let database: Database
  try {
    const result = await time('step2_initialize_database', () => initializeDatabase(appDirPath))
    db = result.db
    database = result.database
  } catch (error) {
    console.error('Failed to initialize database:', error)
    const dbError = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database', error)
    trackError(dbError, { initialization_step: 'database_init' })
    return {
      success: false,
      error: dbError,
    }
  }

  // Step 2b: Trivial first query. PowerSync defers its heavy ready gate (WASM
  // compile, OPFS open, schema replace) to the first query — absorb it here so
  // step4 measures only the reconcile work itself.
  await time('step2b_db_ready', async () => {
    await db.get(sql`select 1`)
  })

  // Step 3: Wait for PowerSync initial sync before reconciling defaults.
  // This ensures synced data from the cloud is available before we check for missing
  // defaults. The implementation never rejects (best-effort with internal timeout);
  // the outcome is reported in the app_init_timing event below.
  const initialSyncOutcome = await time('step3_wait_for_initial_sync', () => database.waitForInitialSync())

  // Step 4: Reconcile defaults
  try {
    await time('step4_reconcile_defaults', () => reconcileDefaults(db))
  } catch (error) {
    console.error('Failed to reconcile default settings:', error)
    const reconcileError = createHandleError('RECONCILE_DEFAULTS_FAILED', 'Failed to reconcile default settings', error)
    trackError(reconcileError, { initialization_step: 'reconcile_defaults' })
    return {
      success: false,
      error: reconcileError,
    }
  }

  // Step 4b: Run data migrations. Sits *after* reconcileDefaults so any
  // newly-seeded defaults (e.g. the daily-brief skill) are present when a
  // migration checks for slug collisions. The runner swallows per-migration
  // failures itself (logging each one), so it never throws and never blocks
  // initialization — each migration retries on the next launch.
  await time('step4b_run_data_migrations', () => runDataMigrations(db))

  // Step 5: Get cloud url and experimental feature tasks
  const cloudUrl = getLocalSetting('cloudUrl')
  const { experimentalFeatureTasks } = await time('step5_get_settings', () =>
    getSettings(db, {
      experimental_feature_tasks: false,
    }),
  )

  // Step 6: HTTP client initialization (use provided client or create one)
  let client: HttpClient

  if (httpClient) {
    client = httpClient
  } else {
    try {
      client = await time('step6_create_http_client', async () =>
        createAuthenticatedClient(cloudUrl, getAuthToken, {
          credentials: isSsoMode() ? 'include' : undefined,
        }),
      )
    } catch (error) {
      console.error('Failed to initialize HTTP client:', error)
      const httpClientError = createHandleError('HTTP_CLIENT_INIT_FAILED', 'Failed to initialize HTTP client', error)
      trackError(httpClientError, { initialization_step: 'http_client' })
      return {
        success: false,
        error: httpClientError,
      }
    }
  }

  // Steps 7 + 8: Tray and PostHog initialization (non-critical, independent
  // of each other) — run in parallel; each wrapper swallows its own failure.
  const [tray, posthogClient] = await Promise.all([initializeTraySafely(), initializePostHogSafely(client)])

  // Settle step 0 so its duration lands in the timing payload. fetchConfig
  // never rejects (catch block + 5s timeout) and has typically resolved by now.
  await fetchConfigPromise

  const initTotalMs = Math.round(performance.now() - totalStartedAt)
  console.info(`[init] complete (total ${initTotalMs}ms)`)

  // Report the full startup timeline to PostHog. This must run after step 8 —
  // the PostHog client only exists from there on; if the user opted out of data
  // collection, trackEvent no-ops.
  const initTimingPayload = {
    ...getInitTimingPayload(),
    init_total_ms: initTotalMs,
    initial_sync_outcome: initialSyncOutcome,
    sync_enabled: getLocalSetting('syncEnabled'),
    platform: getPlatform(),
  }
  trackEvent('app_init_timing', initTimingPayload)

  return {
    success: true,
    data: {
      db,
      cloudUrl,
      experimentalFeatureTasks,
      posthogClient,
      httpClient: client,
      ...tray,
    },
  }
}

/**
 * Hook for managing app initialization
 * @param httpClient - Optional HTTP client (primarily for testing)
 */
export const useAppInitialization = (httpClient?: HttpClient) => {
  const [initData, setInitData] = useState<InitData>()
  const [initError, setInitError] = useState<HandleError>()
  const [isInitializing, setIsInitializing] = useState(true)

  const initialize = useCallback(async () => {
    setIsInitializing(true)
    try {
      const result = await executeInitializationSteps(httpClient)

      if (result.success) {
        setInitData(result.data)
        setInitError(undefined)
      } else {
        setInitError(result.error)
      }
    } catch (error) {
      // Any unhandled rejection from an unguarded init step (e.g. PowerSync's
      // deferred storage open) must surface as an error screen rather than
      // leaving the app stuck on the loading spinner forever. Tracked like the
      // per-step failures so an unexpected throw stays observable.
      const unknownError = createHandleError('UNKNOWN_ERROR', 'Failed to initialize app', error)
      trackError(unknownError, { initialization_step: 'uncaught' })
      setInitError(unknownError)
    } finally {
      setIsInitializing(false)
    }
  }, [httpClient])

  const retry = useCallback(async () => {
    await initialize()
  }, [initialize])

  const clearDatabase = useCallback(async () => {
    setIsInitializing(true)
    try {
      await resetAppDir()
      await initialize()
    } finally {
      setIsInitializing(false)
    }
  }, [initialize])

  useEffect(() => {
    initialize()
  }, [initialize])

  return {
    initData,
    initError,
    isInitializing,
    retry,
    clearDatabase,
  }
}
