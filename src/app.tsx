import '@/lib/dayjs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router'
import { PowerSyncContext } from '@powersync/react'

import ChatDetailPage from '@/chats/detail'
import MagicLinkVerify from '@/components/magic-link-verify'
import OAuthCallback from '@/components/oauth-callback'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HapticsProvider } from '@/hooks/use-haptics'
import { AuthProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { usePageTracking } from '@/hooks/use-analytics'
import { useDeepLinkListener } from '@/hooks/use-deep-link-listener'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { PostHogProvider } from '@/lib/posthog'
import { ThemeProvider } from '@/lib/theme-provider'
import DevSettingsPage from '@/settings/dev-settings'
import DevicesSettingsPage from '@/settings/devices'
import { default as Settings } from '@/settings/index'
import IntegrationsPage from '@/settings/integrations'
import McpServersPage from '@/settings/mcp-servers'
import ModelsPage from '@/settings/models'
import PreferencesSettingsPage from '@/settings/preferences'
import TasksPage from '@/tasks'
import { WaitlistLayout, WaitlistPage } from '@/waitlist'
import AutomationsPage from './automations'
import { useTriggerScheduler } from './automations/use-trigger-scheduler'
import { AppErrorScreen } from './components/app-error-screen'
import { AuthGate } from './components/auth-gate'
import NotFound from './components/not-found'
import { OnboardingDialog } from './components/onboarding/onboarding-dialog'
import { WelcomeDialog } from './components/welcome-dialog'
import { UpdateNotification } from './components/update-notification'
import { ExternalLinkDialogProvider } from './components/chat/markdown-utils'
import { ContentViewProvider } from './content-view/context'
import MessageSimulatorPage from './devtools/message-simulator'
import { useAppInitialization } from './hooks/use-app-initialization'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'
import { useSettings } from './hooks/use-settings'
import { isPrPreview } from './lib/platform'
import { getPowerSyncInstance } from './db/powersync'
import { type ComponentProps } from 'react'

const queryClient = new QueryClient()

const AppContent = ({ initData }: { initData: InitData }) => {
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()
  useSafeAreaInset()

  return (
    <BrowserRouter>
      <AppRoutes initData={initData} />
      <UpdateNotification />
    </BrowserRouter>
  )
}

const AppRoutes = ({ initData }: { initData: InitData }) => {
  usePageTracking()
  useDeepLinkListener()

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: initData.experimentalFeatureTasks,
  })

  const shouldBypassWaitlist = import.meta.env.VITE_BYPASS_WAITLIST === 'true' || isPrPreview()

  return (
    <Routes>
      {/* Auth flow routes - NO guards (must work during auth) */}
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="/auth/verify" element={<MagicLinkVerify />} />

      {/* Waitlist routes - unauthenticated only (skip when bypass is enabled) */}
      {!shouldBypassWaitlist && (
        <Route element={<AuthGate require="unauthenticated" redirectTo="/" />}>
          <Route path="waitlist" element={<WaitlistLayout />}>
            <Route index element={<WaitlistPage />} />
          </Route>
        </Route>
      )}

      {/* Main app routes - authenticated only (pass-through when bypass enabled) */}
      <Route element={shouldBypassWaitlist ? <Outlet /> : <AuthGate require="authenticated" redirectTo="/waitlist" />}>
        <Route
          path="/"
          element={
            <>
              <Layout />
              <OnboardingDialog />
              <WelcomeDialog />
            </>
          }
        >
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
            <Route path="devices" element={<DevicesSettingsPage />} />
            <Route path="mcp-servers" element={<McpServersPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="dev-settings" element={<DevSettingsPage />} />
          </Route>
        </Route>
      </Route>

      {/* Fallback routes - no guards */}
      <Route path="/not-found" element={<NotFound />} />
      <Route path="*" element={<Navigate to="/not-found" replace />} />
    </Routes>
  )
}

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  const renderAppContent = () => {
    if (initError) {
      return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
    }

    // TODO: PowerSync is our only database provider, so we can safely assert it's not null.
    // We may need to refactor the database classes to make this more robust.
    const powerSyncInstance = getPowerSyncInstance()

    if (!initData || !powerSyncInstance) {
      return <Loading />
    }

    return (
      <PowerSyncContext.Provider
        value={powerSyncInstance as unknown as ComponentProps<typeof PowerSyncContext.Provider>['value']}
      >
        <QueryClientProvider client={queryClient}>
          <HttpClientProvider httpClient={initData.httpClient}>
            <AuthProvider>
              <SignInModalProvider>
                <PostHogProvider client={initData.posthogClient}>
                  <TrayProvider tray={initData.tray} window={initData.window}>
                    <MCPProvider>
                      <HapticsProvider>
                        <SidebarProvider>
                          <ContentViewProvider
                            initialSideviewType={initData.sideviewType}
                            initialSideviewId={initData.sideviewId}
                          >
                            <ExternalLinkDialogProvider>
                              <AppContent initData={initData} />
                            </ExternalLinkDialogProvider>
                          </ContentViewProvider>
                        </SidebarProvider>
                      </HapticsProvider>
                    </MCPProvider>
                  </TrayProvider>
                </PostHogProvider>
              </SignInModalProvider>
            </AuthProvider>
          </HttpClientProvider>
        </QueryClientProvider>
      </PowerSyncContext.Provider>
    )
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="ui_theme">
      {renderAppContent()}
    </ThemeProvider>
  )
}
