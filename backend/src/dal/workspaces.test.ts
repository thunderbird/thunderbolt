/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { promotePendingMemberships } from './workspaces'

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
