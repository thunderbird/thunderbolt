import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import OAuthCallback from '@/components/oauth-callback'
import { SidebarProvider } from '@/components/ui/sidebar'
import { usePageTracking } from '@/hooks/use-analytics'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { PostHogProvider } from '@/lib/posthog'
import { ThemeProvider } from '@/lib/theme-provider'
import DevSettingsPage from '@/settings/dev-settings'
import { default as Settings } from '@/settings/index'
import IntegrationsPage from '@/settings/integrations'
import McpServersPage from '@/settings/mcp-servers'
import ModelsPage from '@/settings/models'
import PreferencesSettingsPage from '@/settings/preferences'
import TasksPage from '@/tasks'
import AutomationsPage from './automations'
import { useTriggerScheduler } from './automations/use-trigger-scheduler'
import MessageSimulatorPage from './devtools/message-simulator'
import { useSettings } from './hooks/use-settings'
import { useAppInitialization } from './hooks/use-app-initialization'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import { ContentViewProvider } from './content-view/context'
import SettingsLayout from './settings/layout'
import { AppErrorScreen } from './components/app-error-screen'
import type { InitData } from './types'
import { OnboardingDialog } from './components/onboarding/onboarding-dialog'

const queryClient = new QueryClient()

function AppContent({ initData }: { initData: InitData }) {
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()

  return (
    <BrowserRouter>
      <AppRoutes initData={initData} />
      <OnboardingDialog />
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

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  if (initError) {
    return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
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
