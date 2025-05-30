import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import ChatLayout from '@/chats/layout2'
import { SidebarProvider } from '@/components/ui/sidebar'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import AccountsSettingsPage from '@/settings/accounts'
import { default as Settings } from '@/settings/index'
import McpServersPage from '@/settings/mcp-servers'
import ModelDetailPage from '@/settings/models/detail'
import ModelsLayout from '@/settings/models/layout'
import NewModelPage from '@/settings/models/new'
import PreferencesSettingsPage from '@/settings/preferences'
import { useEffect, useState } from 'react'
import { seedAccounts, seedMcpServers, seedModels, seedSettings } from './dal'
import { initializeDrizzleDatabase } from './db/database'
import { migrate } from './db/migrate'
import { DrizzleProvider } from './db/provider'
import { accountsTable } from './db/tables'
import DevToolsPage from './devtools'
import ImapClient from './imap/imap'
import { ImapProvider } from './imap/provider'
import Layout from './layout'
import { createAppDataDir } from './lib/fs'
import { MCPProvider } from './lib/mcp-provider'
import { TrayManager, TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import { SideviewProvider } from './sideview/provider'
import { ImapSyncClient, ImapSyncProvider } from './sync'
import { InitData, SideviewType } from './types'
import UiKitPage from './ui-kit'
import WelcomePage from './welcome'

const queryClient = new QueryClient()

// Component that initializes MCP sync
function AppContent({ initData }: { initData: InitData }) {
  // Initialize MCP sync
  useMcpSync()

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {/* Home routes with HomeLayout */}
          <Route element={<ChatLayout />}>
            {/* <Route index element={<ChatNewPage />} /> */}
            <Route index element={<WelcomePage />} />
            <Route path="chats/:chatThreadId" element={<ChatDetailPage />} />
          </Route>

          {/* Settings routes with SettingsLayout */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="preferences" element={<PreferencesSettingsPage />} />
            <Route path="models" element={<ModelsLayout />}>
              <Route index element={<Navigate to="/settings/models/new" replace />} />
              <Route path="new" element={<NewModelPage />} />
              <Route path=":modelId" element={<ModelDetailPage />} />
            </Route>
            <Route path="mcp-servers" element={<McpServersPage />} />
            <Route path="accounts" element={<AccountsSettingsPage />} />
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

  const { db, sqlite } = await initializeDrizzleDatabase(`${appDataDirPath}/local.db`)

  await migrate({ sqlite })

  await seedAccounts(db)
  await seedModels(db)
  await seedSettings(db)
  await seedMcpServers(db)

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

    // Initialize the IMAP sync client after the IMAP client
    await imapSync.initialize({
      hostname: account.imapHostname,
      port: account.imapPort,
      username: account.imapUsername,
      password: account.imapPassword,
    })
  }

  const tray = await TrayManager.init()

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

  return {
    db,
    sqlite,
    imap,
    imapSync,
    sideviewType,
    sideviewId,
    ...tray,
  }
}

export const App = () => {
  const [initData, setInitData] = useState<InitData>()

  useEffect(() => {
    init().then(setInitData)
  }, [])

  if (!initData) {
    return <Loading />
  }

  return (
    <TrayProvider tray={initData.tray} window={initData.window}>
      <QueryClientProvider client={queryClient}>
        <DrizzleProvider context={{ db: initData.db, sqlite: initData.sqlite }}>
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
        </DrizzleProvider>
      </QueryClientProvider>
    </TrayProvider>
  )
}
