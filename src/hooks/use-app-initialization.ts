/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetchConfig } from '@/api/config'
import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import { getAuthToken } from '@/lib/auth-token'
import { Database, getCurrentDatabase, setDatabase } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { setupDbLifecycleReloadOnRemoteClose } from '@/db/db-lifecycle-broadcast'
import { getActiveCloudUrl, getActiveTrustDomain, useTrustDomainRegistry } from '@/stores/trust-domain-registry'
import { createHandleError } from '@/lib/error-utils'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { isSsoMode } from '@/lib/auth-mode'
import { createAuthenticatedClient } from '@/lib/http'
import { beginInitRun, getInitTimingPayload, recordInitStep } from '@/lib/init-timing'
import { getDatabasePath, getDatabaseType, getPlatform, isIndexedDbAvailable } from '@/lib/platform'
import { initPosthog, trackError, trackEvent } from '@/lib/posthog'
import { resolveBootTrustDomain } from '@/lib/resolve-boot-trust-domain'
import { TrayManager } from '@/lib/tray'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { PostHog } from 'posthog-js'
import { getLocalSetting } from '@/stores/local-settings-store'
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

  // Multi-tab DB lifecycle listener — idempotent, mounted once per page lifetime so the
  // app reloads when another tab wipes the active server's DB (logout / promotion).
  setupDbLifecycleReloadOnRemoteClose()

  // Step 0: Resolve the active trust domain.
  //
  // First boot (server mode) blocks on /v1/config to learn `serverId` — without it we have no
  // namespace for the auth token, device id, DB filename, and encryption keys. Returning boots
  // (registry has an active domain) skip the fetch here and refresh /v1/config in the
  // background below; that keeps standalone offline-boots and offline server-refresh paths
  // working as before. Mode-picker UI ships in PR 5 — until then, the "both flags off" branch
  // surfaces as a fatal error so v1 production deployments fail loudly on misconfiguration.
  //
  // `fetchConfig` writes through to `useConfigStore`, so reactive consumers (e.g. the
  // upgrade-required gate that reads `minAppVersion`) get hydrated as soon as either the
  // first-boot fetch inside the resolver or the returning-boot background refresh resolves.
  const isReturningBoot = !!getActiveTrustDomain()
  const resolution = await time('step0_resolve_trust_domain', () =>
    resolveBootTrustDomain({
      env: {
        standaloneModeEnabled: import.meta.env.VITE_STANDALONE_MODE_ENABLED === 'true',
        defaultServerUrl: import.meta.env.VITE_THUNDERBOLT_CLOUD_URL ?? '',
      },
      fetchConfig: (url) => fetchConfig(url, httpClient),
    }),
  )
  if (resolution.kind === 'no-trust-domain') {
    const error = createHandleError(
      'NO_TRUST_DOMAIN',
      'No trust domain configured (standalone disabled and no default server URL set)',
      undefined,
    )
    trackError(error, { initialization_step: 'trust_domain' })
    return { success: false, error }
  }
  if (resolution.kind === 'fetch-failed') {
    const error = createHandleError(
      'CONFIG_FETCH_FAILED',
      `Failed to fetch /v1/config from ${resolution.cloudUrl}`,
      undefined,
    )
    trackError(error, { initialization_step: 'trust_domain' })
    return { success: false, error }
  }
  // Standalone end-to-end is deferred post-v1 (addendum §1 + §6): the DB lifecycle, the
  // local-user surface, and the first-run workspace creation paths aren't wired yet.
  // The flag and the resolver branch ship now so the mode picker (PR 5) can exercise the
  // plumbing in dev — but we refuse the boot until the downstream wiring lands rather than
  // let it silently degrade into scattered no-auth / no-encryption failures.
  if (resolution.trustDomain.kind === 'standalone') {
    const error = createHandleError(
      'STANDALONE_NOT_SUPPORTED',
      'Standalone mode is not implemented yet — disable VITE_STANDALONE_MODE_ENABLED',
      undefined,
    )
    trackError(error, { initialization_step: 'trust_domain' })
    return { success: false, error }
  }
  // Standalone is short-circuited above; only server-kind resolutions reach this point.
  // The resolver's contract guarantees a `serverEntry` whenever the trust domain is server.
  if (resolution.trustDomain.kind !== 'server' || !resolution.serverEntry) {
    throw new Error('resolveBootTrustDomain returned a server domain without a server entry')
  }
  useTrustDomainRegistry.getState().activateServer(resolution.serverEntry)

  // Background refresh of /v1/config for returning server-mode boots — keeps cached UI flags
  // (e2eeEnabled, allowAnonUsers, minAppVersion, etc.) current. First-boot already fetched
  // inside the resolver, so we skip the duplicate call. Non-blocking by design: offline keeps
  // working because the config store retains its persisted value when fetch fails.
  if (isReturningBoot && resolution.trustDomain.kind === 'server' && resolution.serverEntry) {
    void fetchConfig(resolution.serverEntry.cloudUrl, httpClient)
  }

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
  try {
    const result = await time('step2_initialize_database', () => initializeDatabase(appDirPath))
    db = result.db
  } catch (error) {
    console.error('Failed to initialize database:', error)
    const dbError = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database', error)
    trackError(dbError, { initialization_step: 'database_init' })
    return {
      success: false,
      error: dbError,
    }
  }

  // Sync, personal-workspace resolution, default reconciliation, and data
  // migrations are post-auth concerns — they require either an authenticated
  // session (server modes) or a local user id (standalone, post-v1). Running
  // them here would crash for users sitting at the waitlist / login screen.
  // They live in `runPostAuthBootstrap`, fired from each sign-in entry point
  // and from a session-change observer in `AuthProvider`.

  // Step 5: Resolve runtime cloud URL (from the active server entry, set by Step 0) and
  // pull experimental feature tasks. The trust-domain registry is the source of truth;
  // we throw here if it's somehow not set, since downstream consumers (HTTP client,
  // AuthProvider, AI provider baseURL) all need a non-null URL in server trust domains.
  const cloudUrl = getActiveCloudUrl()
  if (!cloudUrl) {
    const error = createHandleError(
      'NO_TRUST_DOMAIN',
      'Active server has no cloud URL (registry inconsistency after boot)',
      undefined,
    )
    trackError(error, { initialization_step: 'trust_domain' })
    return { success: false, error }
  }
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

  const initTotalMs = Math.round(performance.now() - totalStartedAt)
  console.info(`[init] complete (total ${initTotalMs}ms)`)

  // Report the full startup timeline to PostHog. This must run after step 8 —
  // the PostHog client only exists from there on; if the user opted out of data
  // collection, trackEvent no-ops.
  const initTimingPayload = {
    ...getInitTimingPayload(),
    init_total_ms: initTotalMs,
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
