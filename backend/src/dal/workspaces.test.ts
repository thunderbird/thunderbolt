/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { promotePendingMemberships, syncMembershipDisplayInfo } from './workspaces'

describe('promotePendingMemberships', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const insertUser = async (id: string, email: string) => {
    const now = new Date()
    await db.insert(user).values({
      id,
      name: 'Test User',
      email,
      emailVerified: true,
      isNew: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  const insertSharedWorkspace = async (id: string): Promise<void> => {
    await db.insert(workspacesTable).values({
      id,
      name: 'Shared',
      isPersonal: false,
      ownerUserId: null,
    })
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('is a no-op for users with no matching pending memberships', async () => {
    await insertUser('u1', 'u1@test.com')
    await promotePendingMemberships(db, 'u1', 'u1@test.com', 'Test User')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'u1'))
    expect(memberships).toHaveLength(0)
  })

  it('promotes pending memberships matching the user email into membership rows', async () => {
    await insertUser('admin1', 'admin1@test.com')
    const sharedWorkspaceId = uuidv7()
    await insertSharedWorkspace(sharedWorkspaceId)

    await db.insert(workspacePendingMembershipsTable).values({
      id: uuidv7(),
      workspaceId: sharedWorkspaceId,
      email: 'newcomer@test.com',
      role: 'member',
      invitedByUserId: 'admin1',
    })

    await insertUser('newcomer', 'newcomer@test.com')
    await promotePendingMemberships(db, 'newcomer', 'newcomer@test.com', 'Test User')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'newcomer'))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].workspaceId).toBe(sharedWorkspaceId)
    expect(memberships[0].role).toBe('member')

    const remainingPending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, 'newcomer@test.com'))
    expect(remainingPending).toHaveLength(0)
  })

  it('normalizes the email before matching pending memberships', async () => {
    await insertUser('admin2', 'admin2@test.com')
    const sharedWorkspaceId = uuidv7()
    await insertSharedWorkspace(sharedWorkspaceId)

    await db.insert(workspacePendingMembershipsTable).values({
      id: uuidv7(),
      workspaceId: sharedWorkspaceId,
      email: 'mixedcase@test.com',
      role: 'admin',
      invitedByUserId: 'admin2',
    })

    await insertUser('mixed', 'mixedcase@test.com')
    // Mixed-case input — `promotePendingMemberships` normalizes before matching.
    await promotePendingMemberships(db, 'mixed', 'MixedCase@TEST.com', 'Test User')

    const promoted = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(
        and(
          eq(workspaceMembershipsTable.userId, 'mixed'),
          eq(workspaceMembershipsTable.workspaceId, sharedWorkspaceId),
        ),
      )
    expect(promoted).toHaveLength(1)
    expect(promoted[0].role).toBe('admin')
  })

  it('promotes multiple pending invites for the same email atomically', async () => {
    await insertUser('admin3', 'admin3@test.com')
    const ws1 = uuidv7()
    const ws2 = uuidv7()
    await insertSharedWorkspace(ws1)
    await insertSharedWorkspace(ws2)

    await db.insert(workspacePendingMembershipsTable).values([
      {
        id: uuidv7(),
        workspaceId: ws1,
        email: 'multi@test.com',
        role: 'member',
        invitedByUserId: 'admin3',
      },
      {
        id: uuidv7(),
        workspaceId: ws2,
        email: 'multi@test.com',
        role: 'admin',
        invitedByUserId: 'admin3',
      },
    ])

    await insertUser('multi', 'multi@test.com')
    await promotePendingMemberships(db, 'multi', 'multi@test.com', 'Test User')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'multi'))
    expect(memberships).toHaveLength(2)

    const remainingPending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, 'multi@test.com'))
    expect(remainingPending).toHaveLength(0)
  })
})

describe('syncMembershipDisplayInfo', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const insertUser = async (id: string, email: string, name = 'Original Name') => {
    const now = new Date()
    await db.insert(user).values({
      id,
      name,
      email,
      emailVerified: true,
      isNew: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  const insertSharedWorkspace = async (id: string): Promise<void> => {
    await db.insert(workspacesTable).values({ id, name: 'Shared', isPersonal: false, ownerUserId: null })
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('updates user_name and user_email on every membership row for the user', async () => {
    await insertUser('alice', 'old@test.com', 'Old Name')
    const ws1 = uuidv7()
    const ws2 = uuidv7()
    await insertSharedWorkspace(ws1)
    await insertSharedWorkspace(ws2)

    await db.insert(workspaceMembershipsTable).values([
      {
        id: uuidv7(),
        workspaceId: ws1,
        userId: 'alice',
        role: 'admin',
        userName: 'Old Name',
        userEmail: 'old@test.com',
      },
      {
        id: uuidv7(),
        workspaceId: ws2,
        userId: 'alice',
        role: 'member',
        userName: 'Old Name',
        userEmail: 'old@test.com',
      },
    ])

    await syncMembershipDisplayInfo(db, 'alice', 'New Name', 'new@test.com')

    const rows = await db.select().from(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.userId, 'alice'))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.userName).toBe('New Name')
      expect(row.userEmail).toBe('new@test.com')
    }
  })

  it('leaves rows for other users untouched', async () => {
    await insertUser('alice', 'alice@test.com', 'Alice')
    await insertUser('bob', 'bob@test.com', 'Bob')
    const ws = uuidv7()
    await insertSharedWorkspace(ws)

    await db.insert(workspaceMembershipsTable).values([
      { id: uuidv7(), workspaceId: ws, userId: 'alice', role: 'admin', userName: 'Alice', userEmail: 'alice@test.com' },
      { id: uuidv7(), workspaceId: ws, userId: 'bob', role: 'member', userName: 'Bob', userEmail: 'bob@test.com' },
    ])

    await syncMembershipDisplayInfo(db, 'alice', 'Alice Updated', 'alice-new@test.com')

    const bobRow = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(and(eq(workspaceMembershipsTable.workspaceId, ws), eq(workspaceMembershipsTable.userId, 'bob')))
    expect(bobRow[0].userName).toBe('Bob')
    expect(bobRow[0].userEmail).toBe('bob@test.com')
  })

  it('is a no-op when the user has no memberships', async () => {
    await insertUser('lonely', 'lonely@test.com', 'Lonely')

    await syncMembershipDisplayInfo(db, 'lonely', 'New', 'new@test.com')

    const rows = await db.select().from(workspaceMembershipsTable).where(eq(workspaceMembershipsTable.userId, 'lonely'))
    expect(rows).toHaveLength(0)
  })
})
