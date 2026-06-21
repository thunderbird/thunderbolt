/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { AuthProvider, DatabaseProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { SidebarProvider } from '@/components/ui/sidebar'
import {
  otherWsId,
  resetTestDatabase,
  setupTestDatabase,
  teardownTestDatabase,
  testUserId,
  wsId,
} from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { SettingsSidebarContent } from './settings-sidebar'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderSidebar = (authClient: AuthClient, isStandalone: () => boolean) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <SidebarProvider>{children}</SidebarProvider>
        </MemoryRouter>
      </SignInModalProvider>
    </TestProvider>
  )
  return render(
    <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={isStandalone} />,
    { wrapper: Wrapper },
  )
}

const onTauri = () => true
const offTauri = () => false

describe('SettingsSidebarContent — Agents entry visibility', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('hides the Agents entry for anonymous users when the proxy is effectively on (web)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, offTauri)

    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('hides the Agents entry for anonymous users on Tauri Connected (proxy_enabled=true)', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, onTauri)

    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('shows the Agents entry for anonymous users on Tauri Standalone (proxy off)', () => {
    // localStorage has no `proxy_enabled` — defaults to false on Tauri.
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, onTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('shows the Agents entry for authenticated users behind the proxy (web)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderSidebar(authClient, offTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('shows the Agents entry for authenticated users on Tauri Standalone (proxy off)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderSidebar(authClient, onTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })
})

const reactiveSidebarAuthClient = createMockAuthClient({ session: authedSession })
const reactiveSidebarHttpClient = createMockHttpClient()

const ReactiveSidebarWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={reactiveSidebarHttpClient}>
      <AuthProvider authClient={reactiveSidebarAuthClient}>
        <SignInModalProvider>
          <SidebarProvider>{children}</SidebarProvider>
        </SignInModalProvider>
      </AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

const seedSharedWorkspaceWithMembership = async (role: 'admin' | 'member') => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id: otherWsId,
    name: 'Acme',
    isPersonal: 0,
    ownerUserId: null,
  })
  await db.insert(workspaceMembershipsTable).values({
    id: `${otherWsId}-${testUserId}`,
    workspaceId: otherWsId,
    userId: testUserId,
    role,
  })
}

const seedPersonalMembership = async () => {
  const db = getDb()
  await db.insert(workspaceMembershipsTable).values({
    id: `${wsId}-${testUserId}`,
    workspaceId: wsId,
    userId: testUserId,
    role: 'admin',
  })
}

describe('SettingsSidebarContent — Workspace > General entry visibility', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('shows the General entry for an admin of a shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('admin')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('General'))
    expect(screen.getByText('General')).toBeInTheDocument()
  })

  it('shows the General entry for a member of a shared workspace (read-only on the page)', async () => {
    await seedSharedWorkspaceWithMembership('member')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('General'))
    expect(screen.getByText('General')).toBeInTheDocument()
  })

  it('shows the General entry in a Personal Workspace (rendered read-only by the page)', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: '/settings',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('General'))
    expect(screen.getByText('General')).toBeInTheDocument()
  })
})

describe('SettingsSidebarContent — Workspace > Members entry visibility', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('shows the Members entry for an admin of a shared workspace (default policy)', async () => {
    await seedSharedWorkspaceWithMembership('admin')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('Members'))
    expect(screen.getByText('Members')).toBeInTheDocument()
  })

  it('shows the Members entry for a member of a shared workspace (read-friendly, per-action gates apply within)', async () => {
    // Decision: Members is visible to every member of a shared workspace. The
    // page is read-friendly without action permissions; individual actions
    // (invite / change role / remove) gate themselves on the granular
    // permission keys (invite_users / change_roles / remove_users).
    await seedSharedWorkspaceWithMembership('member')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('Members'))
    expect(screen.getByText('Members')).toBeInTheDocument()
  })

  it('hides the Members entry in a Personal Workspace (Decision 25)', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: '/settings',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    // Wait for the workspace to resolve as personal. Before resolution,
    // `activeWorkspace?.isPersonal !== 1` is undefined-coerced to true, so
    // Members briefly renders; the General item now renders unconditionally
    // so it can't be used as a "workspace loaded" sentinel.
    await waitForElement(() => (screen.queryByText('Members') ? null : screen.queryByText('General')))
    expect(screen.queryByText('Members')).not.toBeInTheDocument()
  })

  it('hides the Members entry when e2eeEnabled is true (THU-593)', async () => {
    const { useConfigStore } = await import('@/api/config-store')
    const previous = useConfigStore.getState().config
    useConfigStore.getState().updateConfig({ ...previous, e2eeEnabled: true })
    try {
      await seedSharedWorkspaceWithMembership('admin')

      renderWithReactivity(
        <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
        {
          route: `/w/${otherWsId}/settings`,
          routePath: '/*',
          tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
          wrapper: ReactiveSidebarWrapper,
        },
      )

      // Wait for an unrelated Workspace-group item so the active workspace has resolved.
      await waitForElement(() => screen.queryByText('Models'))
      expect(screen.queryByText('Members')).not.toBeInTheDocument()
    } finally {
      useConfigStore.getState().updateConfig(previous)
    }
  })
})

describe('SettingsSidebarContent — Workspace > Permissions entry visibility', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('shows the Permissions entry for an admin of a shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('admin')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('Permissions'))
    expect(screen.getByText('Permissions')).toBeInTheDocument()
  })

  it('hides the Permissions entry for a member of a shared workspace', async () => {
    await seedSharedWorkspaceWithMembership('member')

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: `/w/${otherWsId}/settings`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('Models'))
    expect(screen.queryByText('Permissions')).not.toBeInTheDocument()
  })

  it('hides the Permissions entry in a Personal Workspace (Decision 25)', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
      {
        route: '/settings',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: ReactiveSidebarWrapper,
      },
    )

    await waitForElement(() => screen.queryByText('General'))
    expect(screen.queryByText('Permissions')).not.toBeInTheDocument()
  })

  it('hides the Permissions entry when e2eeEnabled is true (THU-593)', async () => {
    const { useConfigStore } = await import('@/api/config-store')
    const previous = useConfigStore.getState().config
    useConfigStore.getState().updateConfig({ ...previous, e2eeEnabled: true })
    try {
      await seedSharedWorkspaceWithMembership('admin')

      renderWithReactivity(
        <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={onTauri} />,
        {
          route: `/w/${otherWsId}/settings`,
          routePath: '/*',
          tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
          wrapper: ReactiveSidebarWrapper,
        },
      )

      await waitForElement(() => screen.queryByText('Models'))
      expect(screen.queryByText('Permissions')).not.toBeInTheDocument()
    } finally {
      useConfigStore.getState().updateConfig(previous)
    }
  })
})
