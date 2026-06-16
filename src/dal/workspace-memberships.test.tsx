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
import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { eq } from 'drizzle-orm'
import { removeMembership, updateMembershipRole, useWorkspaceMembersQuery } from './workspace-memberships'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from './test-utils'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const seedSharedWorkspace = async (id: string) => {
  const db = getDb()
  await db.insert(workspacesTable).values({ id, name: 'Shared', isPersonal: 0, ownerUserId: null })
}

const seedMembership = async (workspaceId: string, userId: string, name: string, email: string) => {
  const db = getDb()
  await db.insert(workspaceMembershipsTable).values({
    id: `${workspaceId}-${userId}`,
    workspaceId,
    userId,
    role: 'admin',
    userName: name,
    userEmail: email,
  })
}

describe('useWorkspaceMembersQuery', () => {
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

  const Probe = ({ workspaceId }: { workspaceId: string | undefined }) => {
    const members = useWorkspaceMembersQuery(workspaceId)
    if (members.length === 0) {
      return null
    }
    return (
      <ul>
        {members.map((m) => (
          <li key={m.id} data-testid={`m-row-${m.userId}`}>
            {m.userName ?? m.userId}
          </li>
        ))}
      </ul>
    )
  }

  it('returns memberships scoped to the workspace, sorted by userName', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedMembership(otherWsId, 'u-charlie', 'Charlie', 'c@test.com')
    await seedMembership(otherWsId, 'u-alice', 'Alice', 'a@test.com')
    // Cross-workspace row that must be excluded.
    await seedMembership(wsId, 'u-bob', 'Bob', 'b@test.com')

    renderWithReactivity(<Probe workspaceId={otherWsId} />, {
      tables: ['workspace_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByTestId('m-row-u-alice'))
    const rows = screen.getAllByText(/^(Alice|Charlie|Bob)$/)
    expect(rows.map((el) => el.textContent)).toEqual(['Alice', 'Charlie'])
    expect(screen.queryByTestId('m-row-u-bob')).not.toBeInTheDocument()
  })

  it('returns empty array when workspaceId is undefined', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedMembership(otherWsId, 'u-alice', 'Alice', 'a@test.com')

    renderWithReactivity(<Probe workspaceId={undefined} />, {
      tables: ['workspace_memberships'],
      wrapper: DbWrapper,
    })

    // Probe renders nothing when the array is empty.
    expect(screen.queryByTestId('m-row-u-alice')).not.toBeInTheDocument()
  })
})

describe('updateMembershipRole / removeMembership', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('updateMembershipRole flips role on the target row only', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)
    await seedMembership(otherWsId, 'u-alice', 'Alice', 'a@test.com')
    await seedMembership(otherWsId, 'u-bob', 'Bob', 'b@test.com')

    await updateMembershipRole(db, `${otherWsId}-u-alice`, 'member')

    const alice = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.id, `${otherWsId}-u-alice`))
    expect(alice[0].role).toBe('member')

    const bob = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.id, `${otherWsId}-u-bob`))
    // Bob's role is unchanged.
    expect(bob[0].role).toBe('admin')
  })

  it('removeMembership deletes the target row only', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)
    await seedMembership(otherWsId, 'u-alice', 'Alice', 'a@test.com')
    await seedMembership(otherWsId, 'u-bob', 'Bob', 'b@test.com')

    await removeMembership(db, `${otherWsId}-u-alice`)

    const remaining = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, otherWsId))
    expect(remaining.map((r) => r.userId).sort()).toEqual(['u-bob'])
  })
})
