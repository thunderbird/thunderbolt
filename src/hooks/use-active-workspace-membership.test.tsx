/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId } from '@/dal/test-utils'
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
import { useActiveWorkspaceMembership } from './use-active-workspace-membership'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const Probe = () => {
  const { membership, isAdmin } = useActiveWorkspaceMembership()
  return (
    <div>
      <span data-testid="role">{membership?.role ?? 'none'}</span>
      <span data-testid="is-admin">{String(isAdmin)}</span>
    </div>
  )
}

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

const seedSharedWorkspaceWithoutMembership = async () => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id: otherWsId,
    name: 'Acme',
    isPersonal: 0,
    ownerUserId: null,
  })
}

describe('useActiveWorkspaceMembership', () => {
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

  it('returns isAdmin=true when the active user is admin of the active workspace', async () => {
    await seedSharedWorkspaceWithMembership('admin')

    renderWithReactivity(<Probe />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspace_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => (screen.getByTestId('role').textContent === 'admin' ? screen.getByTestId('role') : null))
    expect(screen.getByTestId('is-admin').textContent).toBe('true')
  })

  it('returns isAdmin=false when the active user is a member', async () => {
    await seedSharedWorkspaceWithMembership('member')

    renderWithReactivity(<Probe />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspace_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() =>
      screen.getByTestId('role').textContent === 'member' ? screen.getByTestId('role') : null,
    )
    expect(screen.getByTestId('is-admin').textContent).toBe('false')
  })

  it('returns membership=null + isAdmin=false when no membership row exists', async () => {
    await seedSharedWorkspaceWithoutMembership()

    renderWithReactivity(<Probe />, {
      route: `/w/${otherWsId}/settings/workspace/general`,
      routePath: '/*',
      tables: ['workspace_memberships'],
      wrapper: DbWrapper,
    })

    // No row → live query resolves to []; role probe stays at 'none'.
    await waitForElement(() =>
      screen.getByTestId('is-admin').textContent === 'false' ? screen.getByTestId('is-admin') : null,
    )
    expect(screen.getByTestId('role').textContent).toBe('none')
  })
})
