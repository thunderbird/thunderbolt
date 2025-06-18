import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import ChatLayout from '@/chats/layout2'
import { SidebarProvider } from '@/components/ui/sidebar'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import { ThemeProvider } from '@/lib/theme-provider'
import AccountsSettingsPage from '@/settings/accounts'
import DevSettingsPage from '@/settings/dev-settings'
import { default as Settings } from '@/settings/index'
import McpServersPage from '@/settings/mcp-servers'
import ModelsPage from '@/settings/models'
import PreferencesSettingsPage from '@/settings/preferences'
import ThunderboltBridgeSettingsPage from '@/settings/thunderbolt-bridge'
import { useEffect, useState } from 'react'
import { getOrCreateChatThread, seedAccounts, seedMcpServers, seedModels, seedSettings } from './dal'
import { migrate } from './db/migrate'
import { DatabaseSingleton } from './db/singleton'
import { accountsTable } from './db/tables'
import DevToolsPage from './devtools'
import ImapClient from './imap/imap'
import { ImapProvider } from './imap/provider'
import Layout from './layout'
import { createAppDataDir } from './lib/fs'
import { MCPProvider } from './lib/mcp-provider'
import { isTauri } from './lib/platform'
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

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {/* Home routes with HomeLayout */}
          <Route element={<ChatLayout />}>
            <Route index element={<Navigate to={`/chats/${initData.initialThreadId}`} replace />} />
            <Route path="chats/:chatThreadId" element={<ChatDetailPage />} />
          </Route>

          {/* Settings routes with SettingsLayout */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="preferences" element={<PreferencesSettingsPage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="mcp-servers" element={<McpServersPage />} />
            <Route path="accounts" element={<AccountsSettingsPage />} />
            <Route path="thunderbolt-bridge" element={<ThunderboltBridgeSettingsPage />} />
            <Route path="dev-settings" element={<DevSettingsPage />} />
          </Route>

          <Route path="ui-kit" element={<UiKitPage />} />
          <Route path="devtools" element={<DevToolsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

const init = async (): Promise<InitData> => {
  const appDataDirPath = await createAppDataDir()

  const databaseType = isTauri() ? 'libsql-tauri' : 'sqlocal'
  const db = await DatabaseSingleton.instance.initialize({
    type: databaseType,
    path: `${appDataDirPath}/thunderbolt.db`,
  })

  await migrate(db)

  await seedAccounts()
  await seedModels()
  await seedSettings()
  await seedMcpServers()

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

  useEffect(() => {
    init()
      .then(setInitData)
      .catch((error) => {
        console.error('Failed to initialize app:', error)
        setInitError(error)
      })
  }, [])

  if (initError) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
        <div className="text-red-500 text-center mb-4">Failed to initialize app</div>
        <div className="text-sm text-gray-500 text-center">{initError.message}</div>
      </div>
    )
  }

  if (!initData) {
    return <Loading />
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="thunderbolt-ui-theme">
      <TrayProvider tray={initData.tray} window={initData.window}>
        <QueryClientProvider client={queryClient}>
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
        </QueryClientProvider>
      </TrayProvider>
    </ThemeProvider>
  )
}
