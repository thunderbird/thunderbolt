/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/tables'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createSharedWorkspace, getWorkspacesForUserQuery, useWorkspacesQuery } from './workspaces'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from './test-utils'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const seedSharedWorkspace = async (id: string, name: string, ownerUserId: string, members: string[]) => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id,
    name,
    isPersonal: 0,
    ownerUserId,
  })
  for (const userId of members) {
    await db.insert(workspaceMembershipsTable).values({
      id: `${id}-${userId}`,
      workspaceId: id,
      userId,
      role: 'admin',
    })
  }
}

describe('getWorkspacesForUserQuery', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    // Personal workspace seeded by setup, but its membership row is not — seed it.
    const db = getDb()
    await db.insert(workspaceMembershipsTable).values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
  })

  it('returns only workspaces the user is a member of', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('foreign-ws', 'Foreign', 'someone-else', ['someone-else'])

    const rows = await getWorkspacesForUserQuery(getDb(), testUserId).execute()
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(wsId)
    expect(ids).toContain(otherWsId)
    expect(ids).not.toContain('foreign-ws')
  })

  it('sorts personal first, then alpha by name', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('z-team', 'Zebra Team', testUserId, [testUserId])
    await seedSharedWorkspace('b-team', 'Beta Co', testUserId, [testUserId])

    const rows = await getWorkspacesForUserQuery(getDb(), testUserId).execute()
    // Personal first (isPersonal=1 wins over isPersonal=0 due to DESC).
    expect(rows[0].id).toBe(wsId)
    // Then alpha by name across the shared rows.
    const sharedNames = rows.slice(1).map((r) => r.name)
    expect(sharedNames).toEqual(['Acme', 'Beta Co', 'Zebra Team'])
  })
})

describe('useWorkspacesQuery', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
    const db = getDb()
    await db.insert(workspaceMembershipsTable).values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  const Probe = () => {
    const workspaces = useWorkspacesQuery()
    if (workspaces.length === 0) {
      return null
    }
    return (
      <ul>
        {workspaces.map((ws) => (
          <li key={ws.id} data-testid={`ws-row-${ws.id}`}>
            {ws.name}
          </li>
        ))}
      </ul>
    )
  }

  it('returns personal-first ordering, excludes non-member workspaces', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('foreign-ws', 'Foreign', 'someone-else', ['someone-else'])

    renderWithReactivity(<Probe />, {
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByTestId(`ws-row-${otherWsId}`))
    expect(screen.getByTestId(`ws-row-${wsId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`ws-row-${otherWsId}`)).toBeInTheDocument()
    expect(screen.queryByTestId('ws-row-foreign-ws')).not.toBeInTheDocument()
  })
})

describe('createSharedWorkspace', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('creates a workspace + admin membership with no invites', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Engineering',
    })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws).toHaveLength(1)
    expect(ws[0].name).toBe('Engineering')
    expect(ws[0].isPersonal).toBe(0)
    expect(ws[0].ownerUserId).toBeNull()

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].userId).toBe(testUserId)
    expect(memberships[0].role).toBe('admin')

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(0)
  })

  it('trims the workspace name', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: '   Trimmed Team   ',
    })
    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].name).toBe('Trimmed Team')
  })

  it('throws on empty / whitespace-only name', async () => {
    const db = getDb()
    await expect(createSharedWorkspace(db, { creatorUserId: testUserId, name: '   ' })).rejects.toThrow(
      /name is required/i,
    )
  })

  it('writes one pending row per invited email + assigns inviter id', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Acme',
      invitedEmails: ['a@test.com', 'b@test.com'],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(2)
    const emails = pending.map((p) => p.email).sort()
    expect(emails).toEqual(['a@test.com', 'b@test.com'])
    for (const row of pending) {
      expect(row.invitedByUserId).toBe(testUserId)
      expect(row.role).toBe('member')
    }
  })

  it('normalizes (lowercase + trim) and dedupes invited emails', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Norm',
      invitedEmails: [' Alice@test.com', 'alice@TEST.com  ', 'bob@test.com', ''],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    const emails = pending.map((p) => p.email).sort()
    expect(emails).toEqual(['alice@test.com', 'bob@test.com'])
  })

  it('drops the creator email from the invite list', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      creatorEmail: 'creator@test.com',
      name: 'Self-invite test',
      invitedEmails: [' Creator@test.com', 'other@test.com'],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email)).toEqual(['other@test.com'])
  })

  it('honors inviteRole override', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Admins',
      invitedEmails: ['lead@test.com'],
      inviteRole: 'admin',
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending[0].role).toBe('admin')
  })
})
