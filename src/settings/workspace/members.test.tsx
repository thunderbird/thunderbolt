/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
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
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import WorkspaceMembersPage from './members'
import { RequireWorkspacePermission } from './require-permission'

const pageAuthClient = createMockAuthClient({
  session: { user: { id: testUserId, email: 'a@b.com', name: 'Alice', isAnonymous: false } },
})
const pageHttpClient = createMockHttpClient()

const Providers = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={pageHttpClient}>
      <AuthProvider authClient={pageAuthClient}>{children}</AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
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

describe('WorkspaceMembersPage routing', () => {
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

  it('renders the page for an admin in a shared workspace', async () => {
    await seedShared('admin')

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<WorkspaceMembersPage />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: Providers,
      },
    )

    await waitForElement(() => screen.queryByText('Workspace Members'))
    expect(screen.getByText('Workspace Members')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Member' })).toBeDisabled()
  })

  it('redirects a member out under default policy', async () => {
    await seedShared('member')

    renderWithReactivity(
      <Routes>
        <Route
          path="w/:workspaceId/settings/workspace"
          element={<RequireWorkspacePermission permissionKey="manage_members" />}
        >
          <Route path="members" element={<WorkspaceMembersPage />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/members`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: Providers,
      },
    )

    await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
    expect(screen.queryByText('Workspace Members')).not.toBeInTheDocument()
  })

  it('blocks access in a Personal Workspace', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <Routes>
        <Route path="settings/workspace" element={<RequireWorkspacePermission permissionKey="manage_members" />}>
          <Route path="members" element={<WorkspaceMembersPage />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: '/settings/workspace/members',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships', 'workspace_permissions'],
        wrapper: Providers,
      },
    )

    await waitForElement(() => screen.queryByTestId('at-/settings'))
    expect(screen.queryByText('Workspace Members')).not.toBeInTheDocument()
  })
})
