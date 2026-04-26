import '@/lib/dayjs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router'
import { PowerSyncContext } from '@powersync/react'

import ChatDetailPage from '@/chats/detail'
import MagicLinkVerify from '@/components/magic-link-verify'
import OAuthCallback from '@/components/oauth-callback'
import { AccountDeleted } from '@/components/account-deleted'
import { RevokedDeviceModal } from '@/components/revoked-device-modal'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HapticsProvider } from '@/hooks/use-haptics'
import { AuthProvider, DatabaseProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { usePageTracking } from '@/hooks/use-analytics'
import { useDeepLinkListener } from '@/hooks/use-deep-link-listener'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { PostHogProvider } from '@/lib/posthog'
import { ThemeProvider } from '@/lib/theme-provider'
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
import { PendingDeviceModal } from './components/pending-device-modal'
import { UpdateNotification } from './components/update-notification'
import { ExternalLinkDialogProvider } from './components/chat/markdown-utils'
import { ContentViewProvider } from './content-view/context'
import { useAppInitialization } from './hooks/use-app-initialization'
import { useCredentialEvents } from './hooks/use-credential-events'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'
import { useSettings } from './hooks/use-settings'
import { isOidcMode } from './lib/auth-mode'
import { isPrPreview, isTauri } from './lib/platform'
import { getPowerSyncInstance } from './db/powersync'
import { type ComponentProps, Suspense, lazy, useEffect } from 'react'

// Lazily import OIDC components so non-enterprise deployments don't pay
// for the extra bundle size and attack surface.
const OidcRedirect = lazy(() => import('@/components/oidc-redirect'))

// Dev-only routes: guarded by import.meta.env.DEV so Vite eliminates
// both the lazy() call and the dynamic import() from production builds.
const DevSettingsPage = import.meta.env.DEV ? lazy(() => import('@/settings/dev-settings')) : () => null
const MessageSimulatorPage = import.meta.env.DEV ? lazy(() => import('./devtools/message-simulator')) : () => null

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
      <PendingDeviceModal />
    </BrowserRouter>
  )
}

const AppRoutes = ({ initData }: { initData: InitData }) => {
  usePageTracking()
  useDeepLinkListener()

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: initData.experimentalFeatureTasks,
  })

  const oidcMode = isOidcMode()
  const waitlistEnabled = import.meta.env.VITE_ENABLE_WAITLIST === 'true' && !isPrPreview()

  return (
    <Routes>
      {/* Auth flow routes - NO guards (must work during auth) */}
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="/auth/verify" element={<MagicLinkVerify />} />

      {/* OIDC redirect route — no guard, only in OIDC mode */}
      {oidcMode && (
        <Route
          path="/oidc-redirect"
          element={
            <Suspense fallback={<Loading />}>
              <OidcRedirect />
            </Suspense>
          }
        />
      )}

      {/* Waitlist routes - unauthenticated only (only when enabled and not OIDC mode) */}
      {!oidcMode && waitlistEnabled && (
        <Route element={<AuthGate require="unauthenticated" redirectTo="/" />}>
          <Route path="waitlist" element={<WaitlistLayout />}>
            <Route index element={<WaitlistPage />} />
          </Route>
        </Route>
      )}

      {/* Main app routes - authenticated only (pass-through when waitlist and OIDC both disabled) */}
      <Route
        element={
          oidcMode || waitlistEnabled ? (
            <AuthGate require="authenticated" redirectTo={oidcMode ? '/oidc-redirect' : '/waitlist'} />
          ) : (
            <Outlet />
          )
        }
      >
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
            {import.meta.env.DEV && (
              <Route
                path="message-simulator"
                element={
                  <Suspense>
                    <MessageSimulatorPage />
                  </Suspense>
                }
              />
            )}
          </Route>

          {/* Settings routes with SettingsLayout */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="preferences" element={<PreferencesSettingsPage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="devices" element={<DevicesSettingsPage />} />
            <Route path="mcp-servers" element={<McpServersPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            {import.meta.env.DEV && (
              <Route
                path="dev-settings"
                element={
                  <Suspense>
                    <DevSettingsPage />
                  </Suspense>
                }
              />
            )}
          </Route>
        </Route>
      </Route>

      {/* Fallback routes - no guards */}
      <Route path="/account-deleted" element={<AccountDeleted />} />
      <Route path="/not-found" element={<NotFound />} />
      <Route path="*" element={<Navigate to="/not-found" replace />} />
    </Routes>
  )
}

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()
  const { revokedDeviceOpen } = useCredentialEvents()

  // Show the Tauri window after React mounts and CSS is applied.
  // The window starts hidden (tauri.conf.json visible: false) to prevent
  // the WebView's default white background from flashing before the theme loads.
  useEffect(() => {
    if (isTauri()) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().show()).catch(console.error)
    }
  }, [])

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
          <DatabaseProvider db={initData.db}>
            <HttpClientProvider httpClient={initData.httpClient}>
              <AuthProvider cloudUrl={initData.cloudUrl}>
                <SignInModalProvider>
                  <PostHogProvider client={initData.posthogClient}>
                    <TrayProvider tray={initData.tray} window={initData.window}>
                      <MCPProvider>
                        <HapticsProvider>
                          <SidebarProvider>
                            <ContentViewProvider>
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
          </DatabaseProvider>
        </QueryClientProvider>
      </PowerSyncContext.Provider>
    )
  }

  return (
    <ThemeProvider defaultTheme="system">
      {renderAppContent()}
      <RevokedDeviceModal open={revokedDeviceOpen} />
    </ThemeProvider>
  )
}
