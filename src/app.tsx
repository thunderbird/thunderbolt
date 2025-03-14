import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import ChatLayout from '@/chats/layout'
import AccountsSettingsPage from '@/settings/accounts'
import Settings from '@/settings/index'
import ModelsSettingsPage from '@/settings/models'
import { useEffect, useState } from 'react'
import ChatNewPage from './chats/new'
import { getSettings } from './dal'
import { initializeDrizzleDatabase } from './db/database'
import { migrate } from './db/migrate'
import { DrizzleProvider } from './db/provider'
import DevToolsPage from './devtools'
import ImapClient from './imap/imap'
import { ImapProvider } from './imap/provider'
import Layout from './layout'
import { createAppDataDir } from './lib/fs'
import { useTray } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import { SettingsProvider } from './settings/provider'
import { ImapSyncClient, ImapSyncProvider } from './sync'
import { InitData, Settings as SettingsType } from './types'
import UiKitPage from './ui-kit'

const queryClient = new QueryClient()

const init = async (): Promise<InitData> => {
  createAppDataDir()

  const { db, sqlite } = await initializeDrizzleDatabase()

  await migrate({ sqlite })

  const settings = (await getSettings<SettingsType>(db, 'main')) || {}

  const imap = new ImapClient()
  const imapSync = new ImapSyncClient()

  if (settings.account) {
    await imap.initialize({
      hostname: settings.account.hostname,
      port: settings.account.port,
      username: settings.account.username,
      password: settings.account.password,
    })

    // Initialize the IMAP sync client after the IMAP client
    await imapSync.initialize()
  } else {
    console.warn('No IMAP account settings found')
  }

  return {
    db,
    sqlite,
    settings,
    imap,
    imapSync,
  }
}

export const App = () => {
  useTray()

  const [initData, setInitData] = useState<InitData>()

  useEffect(() => {
    init().then(setInitData)
  }, [])

  if (!initData) {
    return <Loading />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DrizzleProvider context={{ db: initData.db, sqlite: initData.sqlite }}>
        <ImapProvider client={initData.imap}>
          <ImapSyncProvider client={initData.imapSync}>
            <SettingsProvider initialSettings={initData.settings} section="main">
              <BrowserRouter>
                <Routes>
                  <Route path="/" element={<Layout />}>
                    {/* Home routes with HomeLayout */}
                    <Route element={<ChatLayout />}>
                      <Route index element={<ChatNewPage />} />
                      <Route path="chats/:chatThreadId" element={<ChatDetailPage />} />
                    </Route>

                    {/* Settings routes with SettingsLayout */}
                    <Route path="settings" element={<SettingsLayout />}>
                      <Route index element={<Settings />} />
                      <Route path="accounts" element={<AccountsSettingsPage />} />
                      <Route path="models" element={<ModelsSettingsPage />} />
                    </Route>

                    <Route path="ui-kit" element={<UiKitPage />} />
                    <Route path="devtools" element={<DevToolsPage />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </SettingsProvider>
          </ImapSyncProvider>
        </ImapProvider>
      </DrizzleProvider>
    </QueryClientProvider>
  )
}
