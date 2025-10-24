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

const init = async (): Promise<InitData> => {
  const appDirPath = await createAppDir()
  const databaseType = await getDatabaseType()
  const dbPath = await getDatabasePath(databaseType, appDirPath)

  const db = await DatabaseSingleton.instance.initialize({
    type: databaseType,
    path: dbPath,
  })

  await migrate(db)
  await reconcileDefaults(db)

  const tray = await TrayManager.initIfSupported()

  const url = new URL(window.location.href)
  const { type: sideviewType, id: sideviewId } = parseSideviewParam(url)

  const posthogClient = await initPosthog()

  return {
    sideviewType,
    sideviewId,
    posthogClient,
    ...tray,
  }
}

export const App = () => {
  const [initData, setInitData] = useState<InitData>()
  const [initError, setInitError] = useState<Error>()
  const [isClearingDatabase, setIsClearingDatabase] = useState(false)

  useEffect(() => {
    init()
      .then(setInitData)
      .catch((error) => {
        console.error('Failed to initialize app:', error)
        setInitError(error)
      })
  }, [])

  const handleClearDatabase = async () => {
    setIsClearingDatabase(true)
    try {
      await resetAppDir()
      const newInitData = await init()
      setInitData(newInitData)
    } finally {
      setIsClearingDatabase(false)
    }
  }

  if (initError) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
        <div className="text-red-500 text-center mb-4">Failed to initialize app</div>
        <div className="text-sm text-gray-500 text-center mb-6">{initError.message}</div>

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
                Unfortuantely, the local database encountered an error while being migrated to the latest version of
                this app. Deleting your local data will resolve the issue but you will lose your settings and chat
                history.
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
