/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import {
  otherWsId,
  resetTestDatabase,
  setupTestDatabase,
  teardownTestDatabase,
  testUserId,
  wsId,
} from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacePermissionsTable, workspacesTable } from '@/db/tables'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import { RequireWorkspaceAdmin, RequireWorkspacePermission } from './require-permission'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const MembersChild = () => <span data-testid="workspace-members">members</span>
const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
}

const seedPersonalMembership = async () => {
  await getDb()
    .insert(workspaceMembershipsTable)
    .values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
}

const seedShared = async (role: 'admin' | 'member') => {
  await getDb().insert(workspacesTable).values({ id: otherWsId, name: 'Acme', isPersonal: 0, ownerUserId: null })
  await getDb()
    .insert(workspaceMembershipsTable)
    .values({
      id: `${otherWsId}-${testUserId}`,
      workspaceId: otherWsId,
      userId: testUserId,
      role,
    })
}

const seedSharedWithoutMembership = async () => {
  await getDb().insert(workspacesTable).values({ id: otherWsId, name: 'Acme', isPersonal: 0, ownerUserId: null })
}

const seedManageMembersPermission = async (requiredRole: 'admin' | 'member') => {
  await getDb()
    .insert(workspacePermissionsTable)
    .values({
      id: `${otherWsId}-manage_members`,
      workspaceId: otherWsId,
      permissionKey: 'manage_members',
      requiredRole,
    })
}

describe('RequireWorkspacePermission', () => {
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

  it('redirects out in a Personal Workspace', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <Routes>
        <Route path="settings/workspace" element={<RequireWorkspacePermission permissionKey="manage_members" />}>
          <Route path="members" element={<MembersChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: '/settings/workspace/members',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('at-/settings'))
    expect(screen.queryByTestId('workspace-members')).not.toBeInTheDocument()
  })

  it('allows access in a shared workspace when the active user is admin (default policy)', async () => {
    await seedShared('admin')

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<MembersChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('workspace-members'))
    expect(screen.getByTestId('workspace-members')).toBeInTheDocument()
  })

  it('redirects out in a shared workspace when the active user is a member under default policy', async () => {
    await seedShared('member')

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<MembersChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
    expect(screen.queryByTestId('workspace-members')).not.toBeInTheDocument()
  })

  it('allows a member through when an explicit row sets requiredRole=member', async () => {
    await seedShared('member')
    await seedManageMembersPermission('member')

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<MembersChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('workspace-members'))
    expect(screen.getByTestId('workspace-members')).toBeInTheDocument()
  })

  it('redirects out when e2eeEnabled is true even for a shared-workspace admin (THU-593)', async () => {
    const { useConfigStore } = await import('@/api/config-store')
    const previous = useConfigStore.getState().config
    useConfigStore.getState().updateConfig({ ...previous, e2eeEnabled: true })
    try {
      await seedShared('admin')

      renderWithReactivity(
        <Routes>
          <Route
            path="w/:workspaceId/settings/workspace"
            element={<RequireWorkspacePermission permissionKey="manage_members" />}
          >
            <Route path="members" element={<MembersChild />} />
          </Route>
          <Route path="*" element={<LocationProbe />} />
        </Routes>,
        {
          route: `/w/${otherWsId}/settings/workspace/members`,
          routePath: '/*',
          tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
          wrapper: DbWrapper,
        },
      )

      await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
      expect(screen.queryByTestId('workspace-members')).not.toBeInTheDocument()
    } finally {
      useConfigStore.getState().updateConfig(previous)
    }
  })

  it('renders loading state (no redirect) while membership is still pending', async () => {
    // Workspace exists but no membership row → `isResolved` stays false; guard
    // must not redirect away.
    await seedSharedWithoutMembership()

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<MembersChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    // Neither the child nor the fallback location has rendered.
    expect(screen.queryByTestId('workspace-members')).not.toBeInTheDocument()
    expect(screen.queryByTestId(`at-/w/${otherWsId}/settings`)).not.toBeInTheDocument()
  })
})

const PermissionsChild = () => <span data-testid="workspace-permissions">permissions</span>

describe('RequireWorkspaceAdmin', () => {
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

  it('redirects out in a Personal Workspace (even though the user is an admin there)', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <Routes>
        <Route path="settings/workspace" element={<RequireWorkspaceAdmin />}>
          <Route path="permissions" element={<PermissionsChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: '/settings/workspace/permissions',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('at-/settings'))
    expect(screen.queryByTestId('workspace-permissions')).not.toBeInTheDocument()
  })

  it('allows access in a shared workspace when the active user is admin', async () => {
    await seedShared('admin')

    renderWithReactivity(
      <Routes>
        <Route path="w/:workspaceId/settings/workspace" element={<RequireWorkspaceAdmin />}>
          <Route path="permissions" element={<PermissionsChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/permissions`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('workspace-permissions'))
    expect(screen.getByTestId('workspace-permissions')).toBeInTheDocument()
  })

  it('redirects out in a shared workspace when the active user is a member', async () => {
    await seedShared('member')

    renderWithReactivity(
      <Routes>
        <Route path="w/:workspaceId/settings/workspace" element={<RequireWorkspaceAdmin />}>
          <Route path="permissions" element={<PermissionsChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/permissions`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
    expect(screen.queryByTestId('workspace-permissions')).not.toBeInTheDocument()
  })

  it('redirects out when e2eeEnabled is true even for a shared-workspace admin', async () => {
    const { useConfigStore } = await import('@/api/config-store')
    const previous = useConfigStore.getState().config
    useConfigStore.getState().updateConfig({ ...previous, e2eeEnabled: true })
    try {
      await seedShared('admin')

      renderWithReactivity(
        <Routes>
          <Route path="w/:workspaceId/settings/workspace" element={<RequireWorkspaceAdmin />}>
            <Route path="permissions" element={<PermissionsChild />} />
          </Route>
          <Route path="*" element={<LocationProbe />} />
        </Routes>,
        {
          route: `/w/${otherWsId}/settings/workspace/permissions`,
          routePath: '/*',
          tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
          wrapper: DbWrapper,
        },
      )

      await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
      expect(screen.queryByTestId('workspace-permissions')).not.toBeInTheDocument()
    } finally {
      useConfigStore.getState().updateConfig(previous)
    }
  })

  it('renders loading state (no redirect) while membership is still pending', async () => {
    await seedSharedWithoutMembership()

    renderWithReactivity(
      <Routes>
        <Route path="w/:workspaceId/settings/workspace" element={<RequireWorkspaceAdmin />}>
          <Route path="permissions" element={<PermissionsChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/permissions`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: DbWrapper,
      },
    )

    expect(screen.queryByTestId('workspace-permissions')).not.toBeInTheDocument()
    expect(screen.queryByTestId(`at-/w/${otherWsId}/settings`)).not.toBeInTheDocument()
  })
})
