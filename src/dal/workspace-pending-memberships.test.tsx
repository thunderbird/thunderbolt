/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspacePendingMembershipsTable, workspacesTable } from '@/db/tables'
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
import {
  addPendingMembership,
  removePendingMembership,
  updatePendingMembershipRole,
  useWorkspacePendingMembershipsQuery,
} from './workspace-pending-memberships'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from './test-utils'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const seedSharedWorkspace = async (id: string) => {
  const db = getDb()
  await db.insert(workspacesTable).values({ id, name: 'Shared', isPersonal: 0, ownerUserId: null })
}

const seedPending = async (workspaceId: string, email: string) => {
  const db = getDb()
  await db.insert(workspacePendingMembershipsTable).values({
    id: `${workspaceId}-${email}`,
    workspaceId,
    email,
    role: 'member',
    invitedByUserId: testUserId,
  })
}

describe('useWorkspacePendingMembershipsQuery', () => {
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
    const pending = useWorkspacePendingMembershipsQuery(workspaceId)
    if (pending.length === 0) {
      return null
    }
    return (
      <ul>
        {pending.map((p) => (
          <li key={p.id} data-testid={`p-row-${p.email}`}>
            {p.email}
          </li>
        ))}
      </ul>
    )
  }

  it('returns pending rows scoped to the workspace, sorted by email', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'charlie@test.com')
    await seedPending(otherWsId, 'alice@test.com')
    // Cross-workspace pending row that must be excluded.
    await seedPending(wsId, 'bob@test.com')

    renderWithReactivity(<Probe workspaceId={otherWsId} />, {
      tables: ['workspace_pending_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByTestId('p-row-alice@test.com'))
    const rows = screen.getAllByText(/^(alice|charlie|bob)@test\.com$/)
    expect(rows.map((el) => el.textContent)).toEqual(['alice@test.com', 'charlie@test.com'])
    expect(screen.queryByTestId('p-row-bob@test.com')).not.toBeInTheDocument()
  })

  it('returns empty array when workspaceId is undefined', async () => {
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'alice@test.com')

    renderWithReactivity(<Probe workspaceId={undefined} />, {
      tables: ['workspace_pending_memberships'],
      wrapper: DbWrapper,
    })

    expect(screen.queryByTestId('p-row-alice@test.com')).not.toBeInTheDocument()
  })
})

describe('addPendingMembership / removePendingMembership', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('addPendingMembership inserts a row with normalized email + default member role', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)

    const id = await addPendingMembership(db, {
      workspaceId: otherWsId,
      email: '  Alice@TEST.com ',
      invitedByUserId: testUserId,
    })

    const rows = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.id, id))
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('alice@test.com')
    expect(rows[0].role).toBe('member')
    expect(rows[0].invitedByUserId).toBe(testUserId)
  })

  it('addPendingMembership honours an explicit admin role', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)

    const id = await addPendingMembership(db, {
      workspaceId: otherWsId,
      email: 'admin@test.com',
      invitedByUserId: testUserId,
      role: 'admin',
    })

    const rows = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.id, id))
    expect(rows[0].role).toBe('admin')
  })

  it('addPendingMembership throws on empty / whitespace email', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)

    await expect(
      addPendingMembership(db, { workspaceId: otherWsId, email: '   ', invitedByUserId: testUserId }),
    ).rejects.toThrow('Email is required')
  })

  it('updatePendingMembershipRole flips role on the target row only', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'alice@test.com')
    await seedPending(otherWsId, 'bob@test.com')

    await updatePendingMembershipRole(db, `${otherWsId}-alice@test.com`, 'admin')

    const alice = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.id, `${otherWsId}-alice@test.com`))
    expect(alice[0].role).toBe('admin')

    const bob = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.id, `${otherWsId}-bob@test.com`))
    expect(bob[0].role).toBe('member')
  })

  it('removePendingMembership deletes the target row only', async () => {
    const db = getDb()
    await seedSharedWorkspace(otherWsId)
    await seedPending(otherWsId, 'alice@test.com')
    await seedPending(otherWsId, 'bob@test.com')

    await removePendingMembership(db, `${otherWsId}-alice@test.com`)

    const remaining = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, otherWsId))
    expect(remaining.map((r) => r.email).sort()).toEqual(['bob@test.com'])
  })
})
