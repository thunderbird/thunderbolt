import { useEffect, useState } from 'react'
import { initPosthog } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { parseSideviewParam } from '@/lib/sideview-url'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { getDatabasePath, getDatabaseType } from '@/lib/platform'
import { TrayManager } from '@/lib/tray'
import { migrate } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import { createHandleError } from '@/lib/error-utils'
import { trackError } from '@/lib/posthog'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { PostHog } from 'posthog-js'

const createAppDirectory = async (): Promise<string> => {
  return await createAppDir()
}

const initializeDatabase = async (appDirPath: string): Promise<AnyDrizzleDatabase> => {
  const databaseType = await getDatabaseType()
  const dbPath = await getDatabasePath(databaseType, appDirPath)

  return await DatabaseSingleton.instance.initialize({
    type: databaseType,
    path: dbPath,
  })
}

const runDatabaseMigrations = async (db: AnyDrizzleDatabase): Promise<void> => {
  await migrate(db)
}

const reconcileDefaultSettings = async (db: AnyDrizzleDatabase): Promise<void> => {
  await reconcileDefaults(db)
}

const initializeTray = async (): Promise<{ tray: TrayIcon | undefined; window: Window | undefined }> => {
  return await TrayManager.initIfSupported()
}

const initializePostHog = async (): Promise<PostHog | null> => {
  const result = await initPosthog()
  return result.success ? result.data : null
}

const executeInitializationSteps = async (): Promise<HandleResult<InitData>> => {
  // Step 1: App directory creation
  let appDirPath: string
  try {
    appDirPath = await createAppDirectory()
  } catch (error) {
    const appDirError = createHandleError('APP_DIR_CREATION_FAILED', 'Failed to create app directory', error)
    trackError(appDirError, { initialization_step: 'app_directory' })
    return {
      success: false,
      error: appDirError,
    }
  }

  // Step 2: Database initialization
  let db: AnyDrizzleDatabase
  try {
    db = await initializeDatabase(appDirPath)
  } catch (error) {
    const dbError = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database', error)
    trackError(dbError, { initialization_step: 'database_init' })
    return {
      success: false,
      error: dbError,
    }
  }

  // Step 3: Database migrations
  try {
    await runDatabaseMigrations(db)
  } catch (error) {
    const migrationError = createHandleError('MIGRATION_FAILED', 'Failed to run database migrations', error)
    trackError(migrationError, { initialization_step: 'database_migration' })
    return {
      success: false,
      error: migrationError,
    }
  }

  // Step 4: Reconcile defaults
  try {
    await reconcileDefaultSettings(db)
  } catch (error) {
    const reconcileError = createHandleError('RECONCILE_DEFAULTS_FAILED', 'Failed to reconcile default settings', error)
    trackError(reconcileError, { initialization_step: 'reconcile_defaults' })
    return {
      success: false,
      error: reconcileError,
    }
  }

  // Step 5: Tray initialization (non-critical)
  let tray: { tray: TrayIcon | undefined; window: Window | undefined } = { tray: undefined, window: undefined }
  try {
    tray = await initializeTray()
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
  }

  // Step 6: PostHog initialization (non-critical)
  let posthogClient: PostHog | null = null
  try {
    posthogClient = await initializePostHog()
  } catch (error) {
    console.warn('Unexpected error during PostHog initialization:', error)
  }

  const url = new URL(window.location.href)
  const { type: sideviewType, id: sideviewId } = parseSideviewParam(url)

  return {
    success: true,
    data: {
      sideviewType,
      sideviewId,
      posthogClient,
      ...tray,
    },
  }
}

export const useAppInitialization = () => {
  const [initData, setInitData] = useState<InitData>()
  const [initError, setInitError] = useState<HandleError>()
  const [isInitializing, setIsInitializing] = useState(true)

  const initialize = async () => {
    setIsInitializing(true)
    try {
      const result = await executeInitializationSteps()
      if (result.success) {
        setInitData(result.data)
        setInitError(undefined)
      } else {
        setInitError(result.error)
      }
    } finally {
      setIsInitializing(false)
    }
  }

  const retry = async () => {
    await initialize()
  }

  const clearDatabase = async () => {
    setIsInitializing(true)
    try {
      await resetAppDir()
      await initialize()
    } finally {
      setIsInitializing(false)
    }
  }

  useEffect(() => {
    initialize()
  }, [])

  return {
    initData,
    initError,
    isInitializing,
    retry,
    clearDatabase,
  }
}
