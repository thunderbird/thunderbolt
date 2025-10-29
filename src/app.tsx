import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import OAuthCallback from '@/components/oauth-callback'
import { SidebarProvider } from '@/components/ui/sidebar'
import { usePageTracking } from '@/hooks/use-analytics'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { initPosthog, PostHogProvider } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { parseSideviewParam } from '@/lib/sideview-url'
import { ThemeProvider } from '@/lib/theme-provider'
import DevSettingsPage from '@/settings/dev-settings'
import { default as Settings } from '@/settings/index'
import IntegrationsPage from '@/settings/integrations'
import McpServersPage from '@/settings/mcp-servers'
import ModelsPage from '@/settings/models'
import PreferencesSettingsPage from '@/settings/preferences'
import TasksPage from '@/tasks'
import { useEffect, useState } from 'react'
import AutomationsPage from './automations'
import { useTriggerScheduler } from './automations/use-trigger-scheduler'
import { migrate } from './db/migrate'
import { DatabaseSingleton } from './db/singleton'
import MessageSimulatorPage from './devtools/message-simulator'
import { useSettings } from './hooks/use-settings'
import Layout from './layout'
import { createAppDir, resetAppDir } from './lib/fs'
import { MCPProvider } from './lib/mcp-provider'
import { getDatabasePath, getDatabaseType } from './lib/platform'
import { TrayManager, TrayProvider } from './lib/tray'
import Loading from './loading'
import { ContentViewProvider } from './content-view/context'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'
import type { InitError, InitResult } from './types/init-errors'
import type { AnyDrizzleDatabase } from './db/database-interface'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import type { PostHog } from 'posthog-js'

const queryClient = new QueryClient()

function AppContent({ initData }: { initData: InitData }) {
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()

  return (
    <BrowserRouter>
      <AppRoutes initData={initData} />
    </BrowserRouter>
  )
}

function AppRoutes(_: { initData: InitData }) {
  usePageTracking()

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: Boolean,
  })

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        {/* Home routes with HomeLayout */}
        <Route element={<ChatLayout />}>
          <Route index element={<Navigate to="/chats/new" replace />} />
          <Route path="chats/:chatThreadId" element={<ChatDetailPage />} />
          {experimentalFeatureTasks.value && <Route path="tasks" element={<TasksPage />} />}
          <Route path="automations" element={<AutomationsPage />} />
          <Route path="message-simulator" element={<MessageSimulatorPage />} />
        </Route>

        {/* Settings routes with SettingsLayout */}
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Settings />} />
          <Route path="preferences" element={<PreferencesSettingsPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="mcp-servers" element={<McpServersPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="dev-settings" element={<DevSettingsPage />} />
        </Route>
      </Route>

      {/* OAuth callback route */}
      <Route path="/oauth/callback" element={<OAuthCallback />} />
    </Routes>
  )
}

const init = async (): Promise<InitResult<InitData>> => {
  try {
    // Step 1: App directory creation
    let appDirPath: string
    try {
      appDirPath = await createAppDir()
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      return {
        success: false,
        error: {
          code: 'APP_DIR_CREATION_FAILED',
          message: 'Failed to create app directory',
          originalError: error,
        },
      }
    }

    // Step 2: Database path resolution
    let databaseType: 'sqlocal' | 'libsql-tauri' | 'bun-sqlite'
    let dbPath: string
    try {
      databaseType = await getDatabaseType()
      dbPath = await getDatabasePath(databaseType, appDirPath)
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      return {
        success: false,
        error: {
          code: 'DATABASE_PATH_FAILED',
          message: 'Failed to resolve database path',
          originalError: error,
        },
      }
    }

    // Step 3: Database initialization
    let db: AnyDrizzleDatabase
    try {
      db = await DatabaseSingleton.instance.initialize({
        type: databaseType,
        path: dbPath,
      })
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      return {
        success: false,
        error: {
          code: 'DATABASE_INIT_FAILED',
          message: 'Failed to initialize database',
          originalError: error,
        },
      }
    }

    // Step 4: Database migrations
    try {
      await migrate(db)
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      return {
        success: false,
        error: {
          code: 'MIGRATION_FAILED',
          message: 'Failed to run database migrations',
          originalError: error,
        },
      }
    }

    // Step 5: Reconcile defaults (critical for app functionality)
    try {
      await reconcileDefaults(db)
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      return {
        success: false,
        error: {
          code: 'RECONCILE_DEFAULTS_FAILED',
          message: 'Failed to reconcile default settings',
          originalError: error,
        },
      }
    }

    // Step 6: Tray initialization (non-critical)
    let tray: { tray: TrayIcon | undefined; window: Window | undefined } = { tray: undefined, window: undefined }
    try {
      tray = await TrayManager.initIfSupported()
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      console.warn('Failed to initialize tray, continuing without tray support:', error)
    }

    const url = new URL(window.location.href)
    const { type: sideviewType, id: sideviewId } = parseSideviewParam(url)

    // Step 7: PostHog initialization (non-critical)
    let posthogClient: PostHog | null = null
    try {
      const posthogResult = await initPosthog()
      if (posthogResult.success) {
        posthogClient = posthogResult.client
      } else {
        // TODO: track these errors in some analytics tool.
        console.warn('PostHog initialization failed:', posthogResult.error)
      }
    } catch (error) {
      // TODO: track these errors in some analytics tool.
      console.warn('Unexpected error during PostHog initialization:', error)
    }

    return {
      success: true,
      data: {
        sideviewType,
        sideviewId,
        posthogClient,
        ...tray,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: 'An unexpected error occurred during initialization',
        originalError: error,
      },
    }
  }
}

export const App = () => {
  const [initData, setInitData] = useState<InitData>()
  const [initError, setInitError] = useState<InitError>()
  const [isClearingDatabase, setIsClearingDatabase] = useState(false)

  useEffect(() => {
    init().then((result) => {
      if (result.success) {
        setInitData(result.data)
      } else {
        console.error('Failed to initialize app:', result.error)
        setInitError(result.error)
      }
    })
  }, [])

  const handleClearDatabase = async () => {
    setIsClearingDatabase(true)
    try {
      await resetAppDir()
      const result = await init()
      if (result.success) {
        setInitData(result.data)
        setInitError(undefined)
      } else {
        setInitError(result.error)
      }
    } finally {
      setIsClearingDatabase(false)
    }
  }

  if (initError) {
    const isDatabaseError = initError.code === 'MIGRATION_FAILED' || initError.code === 'DATABASE_INIT_FAILED'

    return (
      <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
        <div className="text-red-500 text-center mb-4">Failed to initialize app</div>
        <div className="text-sm text-gray-500 text-center mb-6">{initError.message}</div>

        <div className="flex flex-col gap-3">
          {isDatabaseError && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={isClearingDatabase}>
                  {isClearingDatabase ? 'Clearing Database...' : 'Clear Local Database'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear Local Database?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Unfortunately, the local database encountered an error while being migrated to the latest version of
                    this app. Deleting your local data will resolve the issue but you will permanently lose your
                    settings and chat history. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleClearDatabase}
                    className="bg-destructive text-white hover:bg-destructive/90"
                  >
                    Clear Database
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          <Button
            variant="outline"
            onClick={() =>
              window.open(
                'mailto:support@thunderbird.net?subject=App Initialization Error&body=Error Code: ' +
                  initError.code +
                  '%0AError Message: ' +
                  encodeURIComponent(initError.message),
              )
            }
          >
            Contact Support
          </Button>
        </div>
      </div>
    )
  }

  if (!initData) {
    return <Loading />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <PostHogProvider client={initData.posthogClient}>
        <ThemeProvider defaultTheme="system" storageKey="ui_theme">
          <TrayProvider tray={initData.tray} window={initData.window}>
            <MCPProvider>
              <SidebarProvider>
                <ContentViewProvider
                  initialSideviewType={initData.sideviewType}
                  initialSideviewId={initData.sideviewId}
                >
                  <AppContent initData={initData} />
                </ContentViewProvider>
              </SidebarProvider>
            </MCPProvider>
          </TrayProvider>
        </ThemeProvider>
      </PostHogProvider>
    </QueryClientProvider>
  )
}
