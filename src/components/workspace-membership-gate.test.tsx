/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacesTable } from '@/db/tables'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId } from '@/dal/test-utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import { WorkspaceMembershipGate } from './workspace-membership-gate'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

/** Renders the current pathname so a test can assert what we redirected to. */
const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid={`at-${location.pathname}`}>{location.pathname}</span>
}

/** Member-branch child rendered inside the gate's `<Outlet />`. */
const MemberChild = () => <span data-testid="member-content">member</span>

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

const seedSharedWorkspace = async (members: string[]) => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id: otherWsId,
    name: 'Acme',
    isPersonal: 0,
    ownerUserId: testUserId,
  })
  for (const userId of members) {
    await db.insert(workspaceMembershipsTable).values({
      id: `${otherWsId}-${userId}`,
      workspaceId: otherWsId,
      userId,
      role: 'admin',
    })
  }
}

describe('WorkspaceMembershipGate', () => {
  it('renders the Outlet for a member', async () => {
    await seedSharedWorkspace([testUserId])

    renderWithReactivity(
      <Routes>
        <Route path="/w/:workspaceId" element={<WorkspaceMembershipGate />}>
          <Route index element={<MemberChild />} />
        </Route>
      </Routes>,
      {
        route: `/w/${otherWsId}`,
        routePath: '/*',
        tables: ['workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    await waitForElement(() => screen.queryByTestId('member-content'))
    expect(screen.getByTestId('member-content')).toBeInTheDocument()
  })

  it('redirects a non-member to the personal workspace (unprefixed) after the grace window', async () => {
    // Workspace exists, but the test user has no membership row.
    await seedSharedWorkspace(['someone-else'])

    renderWithReactivity(
      <Routes>
        <Route path="/w/:workspaceId" element={<WorkspaceMembershipGate />}>
          <Route index element={<MemberChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/chats/abc`,
        routePath: '/*',
        tables: ['workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    // Tick past the 1s grace window.
    await act(async () => {
      await getClock().tickAsync(1100)
      await getClock().runAllAsync()
    })

    await waitForElement(() => screen.queryByTestId('at-/chats/abc'))
    expect(screen.queryByTestId('member-content')).not.toBeInTheDocument()
  })

  it('stays on the loading state during the grace window', async () => {
    await seedSharedWorkspace(['someone-else'])

    renderWithReactivity(
      <Routes>
        <Route path="/w/:workspaceId" element={<WorkspaceMembershipGate />}>
          <Route index element={<MemberChild />} />
        </Route>
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      {
        route: `/w/${otherWsId}/chats/abc`,
        routePath: '/*',
        tables: ['workspace_memberships'],
        wrapper: DbWrapper,
      },
    )

    // Mid-grace: live query has resolved (empty), but the grace timer hasn't
    // fired. Neither the member content nor the redirect should be visible —
    // the gate is sitting on the loading state.
    await act(async () => {
      await getClock().tickAsync(300)
      await getClock().runAllAsync()
    })

    expect(screen.queryByTestId('member-content')).not.toBeInTheDocument()
    expect(screen.queryByTestId('at-/chats/abc')).not.toBeInTheDocument()
  })
})
