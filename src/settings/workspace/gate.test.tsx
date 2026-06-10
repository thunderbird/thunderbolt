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
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
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
import { WorkspaceSettingsGate } from './gate'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const GeneralChild = () => <span data-testid="workspace-general">general</span>
const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
}

// `resetTestDatabase` already seeds the canonical personal workspace row
// (`wsId`). Only the admin-membership row is missing — add that.
const seedPersonalMembership = async () => {
  const db = getDb()
  await db.insert(workspaceMembershipsTable).values({
    id: `${wsId}-${testUserId}`,
    workspaceId: wsId,
    userId: testUserId,
    role: 'admin',
  })
}

const seedShared = async (role: 'admin' | 'member') => {
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

describe('WorkspaceSettingsGate', () => {
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

  it('allows access in a Personal Workspace (rendered read-only by the page itself)', async () => {
    await seedPersonalMembership()

    renderWithReactivity(
      <Routes>
        <Route path="settings/workspace" element={<WorkspaceSettingsGate />}>
          <Route path="general" element={<GeneralChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: '/settings/workspace/general',
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('workspace-general'))
    expect(screen.getByTestId('workspace-general')).toBeInTheDocument()
  })

  it('allows access in a shared workspace when the active user is admin', async () => {
    await seedShared('admin')

    renderWithReactivity(
      <Routes>
        <Route path="w/:workspaceId/settings/workspace" element={<WorkspaceSettingsGate />}>
          <Route path="general" element={<GeneralChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/general`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('workspace-general'))
    expect(screen.getByTestId('workspace-general')).toBeInTheDocument()
  })

  it('redirects to settings root in a shared workspace when the active user is a member', async () => {
    await seedShared('member')

    renderWithReactivity(
      <Routes>
        <Route path="w/:workspaceId/settings/workspace" element={<WorkspaceSettingsGate />}>
          <Route path="general" element={<GeneralChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/settings/workspace/general`,
        routePath: '/*',
        tables: ['workspaces', 'workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    // Relative `..` from /w/<id>/settings/workspace/general resolves to /w/<id>/settings/workspace.
    // Relative `..` from a Route at path "workspace" inside "w/:workspaceId/settings/workspace"
    // navigates to the parent path — `/w/<id>/settings`.
    await waitForElement(() => screen.queryByTestId(`at-/w/${otherWsId}/settings`))
    expect(screen.queryByTestId('workspace-general')).not.toBeInTheDocument()
  })
})
