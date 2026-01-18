import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getSiteId, performInitialSync, serializeChange, type SerializedChange } from '@/sync'
import { initializeCRRs, migrate } from '@/db/migrate'
import { DatabaseSingleton } from '@/db/singleton'
import { isSyncEnabled } from '@/hooks/use-sync-enabled'
import { getAuthToken, loadAuthToken } from '@/lib/auth-token'
import { createHandleError } from '@/lib/error-utils'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { getDatabasePath, getDatabaseType } from '@/lib/platform'
import { initPosthog, trackError } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { parseSideviewParam } from '@/lib/sideview-url'
import { TrayManager } from '@/lib/tray'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import ky from 'ky'
import type { PostHog } from 'posthog-js'
import { useCallback, useEffect, useState } from 'react'

// Default cloud URL - used as fallback when no custom cloud_url is configured in settings
const DEFAULT_CLOUD_URL = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1'

/**
 * ============================================================================
 * CR-SQLITE MIGRATION WORKAROUND: In-Memory Change Preservation
 * ============================================================================
 *
 * PROBLEM:
 * When cr-sqlite's `crsql_begin_alter`/`crsql_commit_alter` functions are called
 * during schema migrations, they reset the internal `crsql_db_version()` and clear
 * pending changes from the `crsql_changes` virtual table. This means:
 *
 *   1. Device makes local changes (stored in crsql_changes with db_version X)
 *   2. Device goes offline or falls behind on migrations
 *   3. Another device pushes changes with a newer migration version
 *   4. Original device can't push (migration version mismatch)
 *   5. Original device runs migrations → db_version resets → local changes LOST
 *
 * WHY THIS HAPPENS:
 * - cr-sqlite uses `{table}__crsql_clock` tables to track changes
 * - `crsql_commit_alter` rebuilds the CRR metadata and clock tables
 * - This rebuild process appears to reset/recalculate the db_version
 * - We observed db_version going from 178 → 176 after migration
 *
 * OUR WORKAROUND:
 * - BEFORE migrations: Capture pending changes to in-memory array
 * - RUN migrations: With crsql_begin_alter/crsql_commit_alter (required for CRR metadata)
 * - AFTER migrations: Push captured changes to server
 *
 * WHY NOT JUST SKIP crsql_begin_alter/crsql_commit_alter?
 * - Without these calls, CRR metadata becomes stale
 * - Queries fail with "expected X values, got Y" errors
 * - The triggers expect the old schema but the table has new columns
 *
 * FUTURE RESEARCH:
 * 1. File a GitHub issue on vlcn-io/cr-sqlite explaining this behavior
 * 2. Investigate if there's a cr-sqlite config to preserve changes during alter
 * 3. Look into manually backing up and restoring clock table data
 * 4. Consider if cr-sqlite's `crsql_fract_as_ordered` or other APIs help
 * 5. Explore if a newer version of cr-sqlite fixes this behavior
 * 6. Consider contributing a fix upstream if this is a bug
 *
 * REFERENCES:
 * - cr-sqlite migrations docs: https://vlcn.io/docs/cr-sqlite/migrations
 * - cr-sqlite GitHub: https://github.com/vlcn-io/cr-sqlite
 * ============================================================================
 */

/**
 * Capture local changes that haven't been synced yet.
 * Returns serialized changes that can be pushed to the server.
 *
 * This MUST be called BEFORE migrations run, because migrations reset
 * cr-sqlite's internal state and the changes would be lost.
 */
async function captureLocalChanges(): Promise<SerializedChange[]> {
  try {
    if (!DatabaseSingleton.instance.supportsSyncing) {
      return []
    }

    const db = DatabaseSingleton.instance.syncableDatabase
    const lastSyncedVersion = localStorage.getItem('thunderbolt_sync_version')
    const sinceVersion = lastSyncedVersion ? BigInt(lastSyncedVersion) : 0n

    const { changes } = await db.getChanges(sinceVersion)

    if (changes.length > 0) {
      console.warn(`[Sync] Captured ${changes.length} local changes before migration`)
      return changes.map(serializeChange)
    }
  } catch {
    // If this fails (e.g., fresh install, no tables yet), just continue
  }
  return []
}

/**
 * Push preserved local changes to the server.
 *
 * This is called AFTER migrations complete to send the changes that were
 * captured before migration. Without this, those changes would be lost
 * due to cr-sqlite's db_version reset during crsql_commit_alter.
 */
async function pushPreservedChanges(
  httpClient: ReturnType<typeof ky.create>,
  changes: SerializedChange[],
): Promise<void> {
  if (changes.length === 0) {
    return
  }

  try {
    const siteId = await getSiteId()
    const migrationVersion = (await import('@/db/migrate')).getLatestMigrationVersion()

    const maxDbVersion = Math.max(...changes.map((c) => parseInt(c.db_version, 10)))

    const response = await httpClient
      .post('sync/push', {
        json: {
          siteId,
          changes,
          dbVersion: maxDbVersion.toString(),
          migrationVersion,
        },
      })
      .json<{ success: boolean; needsUpgrade?: boolean; serverVersion?: string }>()

    if (response.success) {
      console.warn(`[Sync] Successfully pushed ${changes.length} preserved changes`)
      if (response.serverVersion) {
        localStorage.setItem('thunderbolt_server_version', response.serverVersion)
      }
    } else if (response.needsUpgrade) {
      console.warn('[Sync] Cannot push preserved changes - still needs upgrade')
    }
  } catch (error) {
    console.warn('[Sync] Failed to push preserved changes:', error)
  }
}

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

const initializePostHog = async (httpClient?: HttpClient): Promise<PostHog | null> => {
  const result = await initPosthog(httpClient)
  return result.success ? result.data : null
}

const executeInitializationSteps = async (httpClient?: HttpClient): Promise<HandleResult<InitData>> => {
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
  try {
    db = await initializeDatabase(appDirPath)
  } catch (error) {
    console.error('Failed to initialize database:', error)
    const dbError = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database', error)
    trackError(dbError, { initialization_step: 'database_init' })
    return {
      success: false,
      error: dbError,
    }
  }

  // Step 2.5: Capture local changes BEFORE migrations (in memory)
  // ⚠️ CRITICAL: This MUST happen BEFORE migrations run!
  //
  // cr-sqlite's crsql_begin_alter/crsql_commit_alter (used during migration)
  // resets crsql_db_version() and clears pending changes from crsql_changes.
  //
  // If we don't capture changes here, any local modifications made while the
  // device was offline/outdated would be permanently lost after migration.
  //
  // See the detailed comment block above captureLocalChanges() for full context.
  let preservedChanges: SerializedChange[] = []
  if (DatabaseSingleton.instance.supportsSyncing) {
    preservedChanges = await captureLocalChanges()
  }

  // Step 3: Database migrations
  try {
    await runDatabaseMigrations(db)
  } catch (error) {
    console.error('Failed to run database migrations:', error)
    const migrationError = createHandleError('MIGRATION_FAILED', 'Failed to run database migrations', error)
    trackError(migrationError, { initialization_step: 'database_migration' })
    return {
      success: false,
      error: migrationError,
    }
  }

  // Step 3.5: Initialize CRRs for cr-sqlite sync support
  if (DatabaseSingleton.instance.supportsSyncing) {
    try {
      await initializeCRRs(db)
    } catch (error) {
      console.error('Failed to initialize CRRs:', error)
      const crrError = createHandleError('CRR_INIT_FAILED', 'Failed to initialize CRRs for sync', error)
      trackError(crrError, { initialization_step: 'crr_init' })
      return {
        success: false,
        error: crrError,
      }
    }

    // Load auth token from settings database into memory cache
    // This must be done after migrations (so settings table exists) but before
    // any sync or auth client requests that need the token
    try {
      await loadAuthToken()
    } catch (error) {
      console.warn('Failed to load auth token:', error)
    }

    // Step 3.6: Push preserved changes and sync
    // ⚠️ This is the second half of the cr-sqlite migration workaround.
    //
    // The preserved changes were captured in Step 2.5 BEFORE migrations ran.
    // Now that migrations are complete (and CRR metadata is updated), we push
    // those changes to the server so they aren't lost.
    //
    // Flow:
    // 1. Check if sync is enabled (user must be logged in and have sync enabled)
    // 2. Read cloud_url from settings (user may have configured a custom server)
    // 3. Push preserved changes (from Step 2.5) - these would be lost otherwise
    // 4. Push any other local changes (normal sync)
    // 5. Pull remote changes to get data from other devices
    //
    // Note: The backend will reject unauthenticated requests, so even if this
    // runs before auth is fully checked, the server protects against unauthorized sync.
    if (isSyncEnabled()) {
      try {
        // Read cloud_url from settings BEFORE sync - user may have a custom server configured.
        // This must happen after migrations so the settings table schema is up to date.
        // Falls back to DEFAULT_CLOUD_URL if no custom setting exists.
        const { cloudUrl } = await getSettings({ cloud_url: DEFAULT_CLOUD_URL })
        const authToken = getAuthToken()
        const initialHttpClient = ky.create({
          prefixUrl: cloudUrl,
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        })

        // Push preserved changes first (captured before migration in Step 2.5)
        // Without this, local changes made before migration would be permanently lost
        await pushPreservedChanges(initialHttpClient, preservedChanges)

        // Then do normal sync: push any remaining local changes, then pull
        await performInitialSync(initialHttpClient)
      } catch (error) {
        // Non-critical - continue even if initial sync fails (e.g., offline, no server, not authenticated)
        console.warn('Initial sync failed, continuing with defaults:', error)
      }
    }
  }

  // Step 4: Reconcile defaults (skips records that already exist from sync)
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

  // Step 5: HTTP client initialization (use provided client or create one)
  let client: HttpClient
  if (httpClient) {
    client = httpClient
  } else {
    try {
      const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
      client = ky.create({ prefixUrl: cloudUrl })
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

  // Step 6: Tray initialization (non-critical)
  let tray: { tray: TrayIcon | undefined; window: Window | undefined } = { tray: undefined, window: undefined }
  try {
    tray = await initializeTray()
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
  }

  // Step 7: PostHog initialization (non-critical)
  let posthogClient: PostHog | null = null
  try {
    posthogClient = await initializePostHog(client)
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
