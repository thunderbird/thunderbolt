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
import { getDatabasePath, getDatabaseType } from '@/lib/platform'
import { initPosthog, trackError } from '@/lib/posthog'
import { resolveBootTrustDomain } from '@/lib/resolve-boot-trust-domain'
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

const initializeTray = async (): Promise<{ tray: TrayIcon | undefined; window: Window | undefined }> => {
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
    console.info(`[init] ${label}: ${Math.round(performance.now() - startedAt)}ms`)
  }
}

const executeInitializationSteps = async (httpClient?: HttpClient): Promise<HandleResult<InitData>> => {
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
  const isReturningBoot = !!getActiveTrustDomain()
  const resolution = await time('step0_resolveBootTrustDomain', () =>
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
  // (e2eeEnabled, allowAnonUsers, etc.) current. First-boot already fetched inside the
  // resolver, so we skip the duplicate call. Non-blocking by design: offline keeps working
  // because the config store retains its persisted value when fetch fails.
  if (isReturningBoot && resolution.trustDomain.kind === 'server' && resolution.serverEntry) {
    void fetchConfig(resolution.serverEntry.cloudUrl, httpClient)
  }

  // Step 1: App directory creation
  let appDirPath: string
  try {
    appDirPath = await time('step1_createAppDir', () => createAppDirectory())
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
    const result = await time('step2_initializeDatabase', () => initializeDatabase(appDirPath))
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
  const { experimentalFeatureTasks } = await time('step5_getSettings', () =>
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
      client = createAuthenticatedClient(cloudUrl, getAuthToken, {
        credentials: isSsoMode() ? 'include' : undefined,
      })
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
    tray = await time('step7_initializeTray', () => initializeTray())
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
  }

  // Step 8: PostHog initialization (non-critical)
  let posthogClient: PostHog | null = null
  try {
    posthogClient = await time('step8_initializePostHog', () => initializePostHog(client))
  } catch (error) {
    console.warn('Unexpected error during PostHog initialization:', error)
  }

  console.info(`[init] complete (total ${Math.round(performance.now() - totalStartedAt)}ms)`)

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
