import { fetchConfig } from '@/api/config'
import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { getAuthToken } from '@/lib/auth-token'
import { Database, getCurrentDatabase, setDatabase } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { defaultSettingCloudUrl } from '@/defaults/settings'
import { createHandleError } from '@/lib/error-utils'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { createAuthenticatedClient } from '@/lib/http'
import { getDatabasePath, getDatabaseType } from '@/lib/platform'
import { initPosthog, trackError } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { TrayManager } from '@/lib/tray'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { PostHog } from 'posthog-js'
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

const reconcileDefaultSettings = async (db: AnyDrizzleDatabase): Promise<void> => {
  await reconcileDefaults(db)
}

const initializeTray = async (): Promise<{ tray: TrayIcon | undefined; window: Window | undefined }> => {
  return await TrayManager.initIfSupported()
}

const initializePostHog = async (httpClient?: HttpClient): Promise<PostHog | null> => {
  const result = await initPosthog(httpClient)
  return result.success ? result.data : null
}

const executeInitializationSteps = async (httpClient?: HttpClient): Promise<HandleResult<InitData>> => {
  // Step 0: Fetch backend config and hydrate store (only on success).
  // When fetch fails (offline/error), the store retains its persisted localStorage value.
  await fetchConfig(defaultSettingCloudUrl.value!, httpClient)

  // Step 1: App directory creation
  let appDirPath: string
  try {
    appDirPath = await createAppDirectory()
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
    const result = await initializeDatabase(appDirPath)
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

  // Step 3: Wait for PowerSync initial sync before reconciling defaults
  // This ensures synced data from the cloud is available before we check for missing defaults
  try {
    await database.waitForInitialSync()
  } catch (error) {
    // Non-critical - log and continue
    console.warn('Failed to wait for initial sync:', error)
  }

  // Step 4: Reconcile defaults
  try {
    await reconcileDefaultSettings(db)
  } catch (error) {
    console.error('Failed to reconcile default settings:', error)
    const reconcileError = createHandleError('RECONCILE_DEFAULTS_FAILED', 'Failed to reconcile default settings', error)
    trackError(reconcileError, { initialization_step: 'reconcile_defaults' })
    return {
      success: false,
      error: reconcileError,
    }
  }

  // Step 5: Get cloud url and experimental feature tasks
  const { cloudUrl, experimentalFeatureTasks } = await getSettings(db, {
    cloud_url: defaultSettingCloudUrl.value,
    experimental_feature_tasks: false,
  })

  // Step 6: HTTP client initialization (use provided client or create one)
  let client: HttpClient

  if (httpClient) {
    client = httpClient
  } else {
    try {
      client = createAuthenticatedClient(cloudUrl, getAuthToken)
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

  // Step 7: Tray initialization (non-critical)
  let tray: { tray: TrayIcon | undefined; window: Window | undefined } = { tray: undefined, window: undefined }
  try {
    tray = await initializeTray()
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
  }

  // Step 8: PostHog initialization (non-critical)
  let posthogClient: PostHog | null = null
  try {
    posthogClient = await initializePostHog(client)
  } catch (error) {
    console.warn('Unexpected error during PostHog initialization:', error)
  }

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
