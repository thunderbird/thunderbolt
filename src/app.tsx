/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/lib/dayjs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { PowerSyncContext } from '@powersync/react'

import ChatDetailPage from '@/chats/detail'
import MagicLinkVerify from '@/components/magic-link-verify'
import OAuthCallback from '@/components/oauth-callback'
import { AccountDeleted } from '@/components/account-deleted'
import { SignedOut } from '@/components/signed-out'
import { StorageUnavailableScreen } from '@/components/storage-unavailable-screen'
import NotFound from '@/components/not-found'
import { RevokedDeviceModal } from '@/components/revoked-device-modal'
import ChatLayout from '@/layout/main-layout'
import SettingsLayout from '@/settings/layout'
import WaitlistLayout from '@/waitlist/layout'
import WaitlistPage from '@/waitlist/waitlist-page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HapticsProvider } from '@/hooks/use-haptics'
import {
  AuthProvider,
  DatabaseProvider,
  HttpClientProvider,
  SignInModalProvider,
  useAuth,
  useDatabase,
  useHttpClient,
} from '@/contexts'
import { usePageTracking } from '@/hooks/use-analytics'
import { useDeepLinkListener } from '@/hooks/use-deep-link-listener'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useViewportLock } from '@/hooks/use-viewport-lock'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import { PostHogProvider } from '@/lib/posthog'
import { ThemeProvider } from '@/lib/theme-provider'
import { AppErrorScreen } from './components/app-error-screen'
import { UpgradeRequired } from './components/upgrade-required'
import { useConfigStore } from '@/api/config-store'
import { compareSemver } from '@/lib/compare-semver'
import { AuthGate } from './components/auth-gate'
import { OnboardingDialog } from './components/onboarding/onboarding-dialog'
import { WelcomeDialog } from './components/welcome-dialog'
import { PendingDeviceModal } from './components/pending-device-modal'
import { UpdateNotification } from './components/update-notification'
import { WindowChrome } from '@/components/window-chrome'
import { ExternalLinkDialogProvider } from './components/chat/markdown-utils'
import { ContentViewProvider } from './content-view/context'
import { useAppInitialization } from './hooks/use-app-initialization'
import { useCredentialEvents } from './hooks/use-credential-events'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { ProxyFetchProvider } from './lib/proxy-fetch-context'
import { TrayProvider } from './lib/tray'
import Loading from './loading'
import type { InitData } from './types'
import { useSettings } from './hooks/use-settings'
import { isSsoMode, isWaitlistBypassed } from './lib/auth-mode'
import { isTauri } from './lib/platform'
import { getPowerSyncInstance } from './db/powersync/sync-state'
import { refreshSystemAgents } from '@/db/seeding/seed-agents'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useChatStore } from '@/chats/chat-store'
import { type ComponentProps, Suspense, lazy, useEffect, useState } from 'react'
import { markAppMounted } from '@/lib/init-timing'
import { LazyMotion } from 'framer-motion'

// Loaded after first paint so framer-motion feature code lives in an
// async chunk instead of the entry bundle.
const loadMotionFeatures = () => import('@/lib/motion-features').then((mod) => mod.default)

// Pages below ship in their own async chunk; the layouts that host them are
// static so route navigation only swaps the inner content. ChatLayout and
// ChatDetailPage stay in the entry bundle so the landing page is instant.
const TasksPage = lazy(() => import('@/tasks'))
const Settings = lazy(() => import('@/settings/index'))
const PreferencesSettingsPage = lazy(() => import('@/settings/preferences'))
const ModelsPage = lazy(() => import('@/settings/models'))
const DevicesSettingsPage = lazy(() => import('@/settings/devices'))
const McpServersPage = lazy(() => import('@/settings/mcp-servers'))
const SkillsPage = lazy(() => import('@/settings/skills'))
const AgentsSettingsPage = lazy(() => import('@/routes/settings/agents'))
const IntegrationsPage = lazy(() => import('@/settings/integrations'))

// Lazily import SSO components so non-enterprise deployments don't pay
// for the extra bundle size and attack surface.
const SsoRedirect = lazy(() => import('@/components/sso-redirect'))

// Dev-only routes: guarded by import.meta.env.DEV so Vite eliminates
// both the lazy() call and the dynamic import() from production builds.
const DevSettingsPage = import.meta.env.DEV ? lazy(() => import('@/settings/dev-settings')) : () => null
const MessageSimulatorPage = import.meta.env.DEV ? lazy(() => import('./devtools/message-simulator')) : () => null

const queryClient = new QueryClient()

/**
 * Hydrate the local-only `agents_system` table from the backend's `/agents`
 * discovery endpoint when the user has a real (non-anonymous) session.
 *
 * Legitimate `useEffect` per CLAUDE.md guidance: synchronizing app state with
 * an external system (the backend) on auth/cloud-URL transitions. There is no
 * render-time computation that could replace this — the fetch must run as a
 * side effect when the gating conditions flip, and PowerSync's reactive query
 * picks up the resulting rows automatically.
 */
const useBootstrapSystemAgents = () => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)

  const isRealUser = !!session?.user && session.user.isAnonymous !== true

  useEffect(() => {
    if (!isRealUser || !cloudUrl) {
      return
    }
    void (async () => {
      const result = await refreshSystemAgents(db, cloudUrl, httpClient)
      if (!result.refreshed) {
        return
      }
      for (const agent of result.wireIdentityChangedAgents) {
        useChatStore.getState().applyAgentWireIdentityChange(agent)
      }
    })()
  }, [isRealUser, cloudUrl, db, httpClient])
}

const AppContent = ({ initData }: { initData: InitData }) => {
  useMcpSync()
  useBootstrapSystemAgents()
  useKeyboardInset()
  useViewportLock()
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

  const ssoMode = isSsoMode()
  const shouldBypassWaitlist = isWaitlistBypassed()

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        {/* Auth flow routes - NO guards (must work during auth) */}
        <Route path="/oauth/callback" element={<OAuthCallback />} />
        <Route path="/auth/verify" element={<MagicLinkVerify />} />

        {/* SSO redirect route — no guard, only in OIDC/SAML mode */}
        {ssoMode && <Route path="/sso-redirect" element={<SsoRedirect />} />}

        {/* Waitlist routes - unauthenticated only (skip when bypass or SSO mode) */}
        {!ssoMode && !shouldBypassWaitlist && (
          <Route element={<AuthGate require="unauthenticated" />}>
            <Route path="waitlist" element={<WaitlistLayout />}>
              <Route index element={<WaitlistPage />} />
            </Route>
          </Route>
        )}

        {/* Main app routes - authenticated only. The gate decides redirect
            targets internally from VITE_AUTH_MODE + VITE_AUTH_ENABLE_ANONYMOUS. */}
        <Route element={<AuthGate require="authenticated" />}>
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
              {import.meta.env.DEV && <Route path="message-simulator" element={<MessageSimulatorPage />} />}
            </Route>

            {/* Settings routes with SettingsLayout */}
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Settings />} />
              <Route path="preferences" element={<PreferencesSettingsPage />} />
              <Route path="models" element={<ModelsPage />} />
              <Route path="devices" element={<DevicesSettingsPage />} />
              <Route path="mcp-servers" element={<McpServersPage />} />
              <Route path="skills" element={<SkillsPage />} />
              <Route path="agents" element={<AgentsSettingsPage />} />
              <Route path="integrations" element={<IntegrationsPage />} />
              {import.meta.env.DEV && <Route path="dev-settings" element={<DevSettingsPage />} />}
            </Route>
          </Route>
        </Route>

        {/* Fallback routes - no guards */}
        <Route path="/signed-out" element={<SignedOut />} />
        <Route path="/account-deleted" element={<AccountDeleted />} />
        <Route path="/not-found" element={<NotFound />} />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Routes>
    </Suspense>
  )
}

export const App = () => {
  // Lazy initializer = runs exactly once on first render; records the
  // "React mounted" mark for startup telemetry.
  useState(markAppMounted)
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

  // Reactive gate: re-evaluates whenever the config store updates, so the
  // upgrade screen tracks the current server-enforced minimum.
  const minAppVersion = useConfigStore((s) => s.config.minAppVersion)
  const appVersion = import.meta.env.VITE_APP_VERSION
  const upgradeRequired = !!minAppVersion && !!appVersion && compareSemver(appVersion, minAppVersion) < 0

  const renderAppContent = () => {
    if (upgradeRequired) {
      return <UpgradeRequired currentVersion={appVersion ?? 'unknown'} minVersion={minAppVersion ?? 'unknown'} />
    }
    if (initError) {
      if (initError.code === 'STORAGE_UNAVAILABLE') {
        return <StorageUnavailableScreen />
      }
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
                      <ProxyFetchProvider>
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
                      </ProxyFetchProvider>
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
    <ThemeProvider>
      <LazyMotion features={loadMotionFeatures} strict>
        <WindowChrome>{renderAppContent()}</WindowChrome>
        <RevokedDeviceModal open={revokedDeviceOpen} />
      </LazyMotion>
    </ThemeProvider>
  )
}
