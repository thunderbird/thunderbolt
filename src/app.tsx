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
import { useCredentialEvents } from './hooks/use-credential-events'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'
import { useSettings } from './hooks/use-settings'
import ky from 'ky'
import { isOidcMode } from './lib/auth-mode'
import { isPrPreview, isTauri } from './lib/platform'
import { getPowerSyncInstance } from './db/powersync'
import { type ComponentProps, useEffect } from 'react'

const queryClient = new QueryClient()

/**
 * In OIDC mode, redirects unauthenticated users to the backend's OIDC sign-in endpoint,
 * which in turn redirects to the OIDC provider. The user never sees a login page on our app.
 */
const OidcRedirect = () => {
  const { cloudUrl } = useSettings({ cloud_url: String })

  useEffect(() => {
    if (cloudUrl.isLoading || !cloudUrl.value) {
      return
    }

    const abortController = new AbortController()
    const baseUrl = cloudUrl.value.replace(/\/v1$/, '')

    // Use credentials: 'include' so the browser stores Better Auth's OAuth state cookie.
    // Without it, the state cookie is lost and the callback fails with state_mismatch.
    const redirectToOidc = async () => {
      try {
        const data = await ky
          .post(`${baseUrl}/v1/api/auth/sign-in/oauth2`, {
            json: { providerId: 'oidc', callbackURL: window.location.origin + '/' },
            credentials: 'include',
            signal: abortController.signal,
          })
          .json<{ url: string }>()

        window.location.href = data.url
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }
        console.error('OIDC redirect failed:', err)
      }
    }

    redirectToOidc()

    return () => abortController.abort()
  }, [cloudUrl.isLoading, cloudUrl.value])

  return <Loading />
}

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

  const oidcMode = isOidcMode()
  const shouldBypassWaitlist = import.meta.env.VITE_BYPASS_WAITLIST === 'true' || isPrPreview()

  return (
    <Routes>
      {/* Auth flow routes - NO guards (must work during auth) */}
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="/auth/verify" element={<MagicLinkVerify />} />

      {/* OIDC redirect route — no guard, only in OIDC mode */}
      {oidcMode && <Route path="/oidc-redirect" element={<OidcRedirect />} />}

      {/* Waitlist routes - unauthenticated only (skip when bypass or OIDC mode) */}
      {!oidcMode && !shouldBypassWaitlist && (
        <Route element={<AuthGate require="unauthenticated" redirectTo="/" />}>
          <Route path="waitlist" element={<WaitlistLayout />}>
            <Route index element={<WaitlistPage />} />
          </Route>
        </Route>
      )}

      {/* Main app routes - authenticated only (pass-through when bypass enabled) */}
      <Route
        element={
          shouldBypassWaitlist ? (
            <Outlet />
          ) : (
            <AuthGate require="authenticated" redirectTo={oidcMode ? '/oidc-redirect' : '/waitlist'} />
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
          </DatabaseProvider>
        </QueryClientProvider>
      </PowerSyncContext.Provider>
    )
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="ui_theme">
      {renderAppContent()}
      <RevokedDeviceModal open={revokedDeviceOpen} />
    </ThemeProvider>
  )
}
