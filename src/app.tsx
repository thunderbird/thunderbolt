import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import ChatDetailPage from '@/chats/detail'
import MagicLinkVerify from '@/components/magic-link-verify'
import OAuthCallback from '@/components/oauth-callback'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AuthProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { usePageTracking } from '@/hooks/use-analytics'
import { useDeepLinkListener } from '@/hooks/use-deep-link-listener'
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
import { AppErrorScreen } from './components/app-error-screen'
import { OnboardingDialog } from './components/onboarding/onboarding-dialog'
import { ContentViewProvider } from './content-view/context'
import MessageSimulatorPage from './devtools/message-simulator'
import { useAppInitialization } from './hooks/use-app-initialization'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import { useSettings } from './hooks/use-settings'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'

const queryClient = new QueryClient()

function AppContent({ initData }: { initData: InitData }) {
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()
  useSafeAreaInset()

  return (
    <BrowserRouter>
      <AppRoutes initData={initData} />
      <OnboardingDialog />
    </BrowserRouter>
  )
}

function AppRoutes(_: { initData: InitData }) {
  usePageTracking()
  useDeepLinkListener()

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

        {/* Magic link verification - shows modal over app */}
        <Route path="auth/verify" element={<MagicLinkVerify />} />
      </Route>

      {/* OAuth callback route */}
      <Route path="/oauth/callback" element={<OAuthCallback />} />
    </Routes>
  )
}

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  const renderAppContent = () => {
    if (initError) {
      return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
    }

    if (!initData) {
      return <Loading />
    }

    return (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider httpClient={initData.httpClient}>
          <AuthProvider>
            <SignInModalProvider>
              <PostHogProvider client={initData.posthogClient}>
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
              </PostHogProvider>
            </SignInModalProvider>
          </AuthProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    )
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="ui_theme">
      {renderAppContent()}
    </ThemeProvider>
  )
}
