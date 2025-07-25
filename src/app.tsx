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
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { getOrCreateChatThread } from '@/lib/dal'
import { seedAccounts, seedModels, seedPrompts, seedSettings, seedTasks } from '@/lib/seed'
import { ThemeProvider } from '@/lib/theme-provider'
import AccountsSettingsPage from '@/settings/accounts'
import DevSettingsPage from '@/settings/dev-settings'
import { default as Settings } from '@/settings/index'
import IntegrationsPage from '@/settings/integrations'
import McpServersPage from '@/settings/mcp-servers'
import ModelsPage from '@/settings/models'
import PreferencesSettingsPage from '@/settings/preferences'
import ThunderboltBridgeSettingsPage from '@/settings/thunderbolt-bridge'
import TasksPage from '@/tasks'
import { useEffect, useState } from 'react'
import AutomationsPage from './automations'
import { useTriggerScheduler } from './automations/use-trigger-scheduler'
import { migrate } from './db/migrate'
import { DatabaseSingleton } from './db/singleton'
import { accountsTable } from './db/tables'
import DevToolsPage from './devtools'
import MessageSimulatorPage from './devtools/message-simulator'
import ImapClient from './imap/imap'
import { ImapProvider } from './imap/provider'
import Layout from './layout'
import { createAppDir, resetAppDir } from './lib/fs'
import { MCPProvider } from './lib/mcp-provider'
import { getDatabasePath, getDatabaseType } from './lib/platform'
import { TrayManager, TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import { SideviewProvider } from './sideview/provider'
import { ImapSyncClient, ImapSyncProvider } from './sync'
import { InitData, SideviewType } from './types'
import UiKitPage from './ui-kit'

const queryClient = new QueryClient()

function AppContent({ initData }: { initData: InitData }) {
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {/* Home routes with HomeLayout */}
          <Route element={<ChatLayout />}>
            <Route index element={<Navigate to={`/chats/${initData.initialThreadId}`} replace />} />
            <Route path="chats/:chatThreadId" element={<ChatDetailPage />} />
            <Route path="tasks" element={<TasksPage />} />
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
            <Route path="accounts" element={<AccountsSettingsPage />} />
            <Route path="thunderbolt-bridge" element={<ThunderboltBridgeSettingsPage />} />
            <Route path="dev-settings" element={<DevSettingsPage />} />
          </Route>

          <Route path="ui-kit" element={<UiKitPage />} />
          <Route path="devtools" element={<DevToolsPage />} />
        </Route>

        {/* OAuth callback route */}
        <Route path="/oauth/callback" element={<OAuthCallback />} />
      </Routes>
    </BrowserRouter>
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

  await seedModels()
  await seedSettings()
  await seedAccounts()
  await seedTasks()
  await seedPrompts()

  const imap = new ImapClient()
  const imapSync = new ImapSyncClient()

  const account = await db.select().from(accountsTable).limit(1).get()

  if (account?.imapHostname && account?.imapPort && account?.imapUsername && account?.imapPassword) {
    await imap.initialize({
      hostname: account.imapHostname,
      port: account.imapPort,
      username: account.imapUsername,
      password: account.imapPassword,
    })

    await imapSync.initialize({
      hostname: account.imapHostname,
      port: account.imapPort,
      username: account.imapUsername,
      password: account.imapPassword,
    })
  }

  const tray = await TrayManager.initIfSupported()

  const url = new URL(window.location.href)
  const sideviewParam = url.searchParams.get('sideview')

  let sideviewType: SideviewType | null = null
  let sideviewId: string | null = null

  if (sideviewParam) {
    const [type, id] = sideviewParam.split(':')
    if (type && id) {
      sideviewType = type as SideviewType
      sideviewId = decodeURIComponent(id)
    }
  }

  const initialThreadId = await getOrCreateChatThread()

  return {
    imap,
    imapSync,
    sideviewType,
    sideviewId,
    initialThreadId,
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
      <ThemeProvider defaultTheme="system" storageKey="ui_theme">
        <TrayProvider tray={initData.tray} window={initData.window}>
          <MCPProvider>
            <ImapProvider client={initData.imap}>
              <ImapSyncProvider client={initData.imapSync}>
                <SidebarProvider>
                  <SideviewProvider sideviewType={initData.sideviewType} sideviewId={initData.sideviewId}>
                    <AppContent initData={initData} />
                  </SideviewProvider>
                </SidebarProvider>
              </ImapSyncProvider>
            </ImapProvider>
          </MCPProvider>
        </TrayProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
