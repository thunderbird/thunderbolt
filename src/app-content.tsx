import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { lazy } from 'react'
import OAuthCallback from '@/components/oauth-callback'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HttpClientProvider } from '@/contexts'
import { usePageTracking } from '@/hooks/use-analytics'
import { useDeepLinkListener } from '@/hooks/use-deep-link-listener'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import ChatLayout from '@/layout/main-layout'
import { PostHogProvider } from '@/lib/posthog'
import { ThemeProvider } from '@/lib/theme-provider'
import { useTriggerScheduler } from './automations/use-trigger-scheduler'
import { OnboardingDialog } from './components/onboarding/onboarding-dialog'
import { ContentViewProvider } from './content-view/context'
import { useSafeAreaInset } from './hooks/use-safe-area-inset'
import { useSettings } from './hooks/use-settings'
import Layout from './layout'
import { MCPProvider } from './lib/mcp-provider'
import { TrayProvider } from './lib/tray'
import SettingsLayout from './settings/layout'
import type { InitData } from './types'

const ChatDetailPage = lazy(() => import('@/chats/detail'))
const TasksPage = lazy(() => import('@/tasks'))
const AutomationsPage = lazy(() => import('@/automations'))
const MessageSimulatorPage = lazy(() => import('@/devtools/message-simulator'))
const Settings = lazy(() => import('@/settings'))
const PreferencesSettingsPage = lazy(() => import('@/settings/preferences'))
const ModelsPage = lazy(() => import('@/settings/models'))
const McpServersPage = lazy(() => import('@/settings/mcp-servers'))
const IntegrationsPage = lazy(() => import('@/settings/integrations'))
const DevSettingsPage = lazy(() => import('@/settings/dev-settings'))

const queryClient = new QueryClient()

export default function AppContent({ initData }: { initData: InitData }) {
  return (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider httpClient={initData.httpClient}>
        <PostHogProvider client={initData.posthogClient}>
          <ThemeProvider defaultTheme="system" storageKey="ui_theme">
            <TrayProvider tray={initData.tray} window={initData.window}>
              <MCPProvider>
                <SidebarProvider>
                  <ContentViewProvider
                    initialSideviewType={initData.sideviewType}
                    initialSideviewId={initData.sideviewId}
                  >
                    <BrowserRouter>
                      <AppRoutes />
                    </BrowserRouter>
                  </ContentViewProvider>
                </SidebarProvider>
              </MCPProvider>
            </TrayProvider>
          </ThemeProvider>
        </PostHogProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  )
}

function AppRoutes() {
  usePageTracking()
  useDeepLinkListener()
  useMcpSync()
  useTriggerScheduler()
  useKeyboardInset()
  useSafeAreaInset()

  const { experimentalFeatureTasks } = useSettings({
    experimental_feature_tasks: Boolean,
  })

  return (
    <>
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
      <OnboardingDialog />
    </>
  )
}
