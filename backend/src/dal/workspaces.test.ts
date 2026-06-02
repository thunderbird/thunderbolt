/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { bootstrapUserWorkspace } from './workspaces'

describe('bootstrapUserWorkspace', () => {
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

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('creates a personal workspace and an admin membership', async () => {
    await insertUser('u1', 'u1@test.com')

    await bootstrapUserWorkspace(db, 'u1', 'u1@test.com')

    const workspaces = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerUserId, 'u1'))
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].isPersonal).toBe(true)
    expect(workspaces[0].name).toBe('Personal')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'u1'))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].workspaceId).toBe(workspaces[0].id)
    expect(memberships[0].role).toBe('admin')
  })

  it('is idempotent on re-run for the same user', async () => {
    await insertUser('u2', 'u2@test.com')

    await bootstrapUserWorkspace(db, 'u2', 'u2@test.com')
    await bootstrapUserWorkspace(db, 'u2', 'u2@test.com')

    const workspaces = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerUserId, 'u2'))
    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'u2'))
    expect(workspaces).toHaveLength(1)
    expect(memberships).toHaveLength(1)
  })

  it('promotes pending memberships matching the user email', async () => {
    await insertUser('admin1', 'admin1@test.com')
    await bootstrapUserWorkspace(db, 'admin1', 'admin1@test.com')

    const adminWorkspaces = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerUserId, 'admin1'))
    const sharedWorkspaceId = adminWorkspaces[0].id

    await db.insert(workspacePendingMembershipsTable).values({
      id: uuidv7(),
      workspaceId: sharedWorkspaceId,
      email: 'newcomer@test.com',
      role: 'member',
      invitedByUserId: 'admin1',
    })

    await insertUser('newcomer', 'newcomer@test.com')
    await bootstrapUserWorkspace(db, 'newcomer', 'newcomer@test.com')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'newcomer'))
    // One for the newcomer's own personal workspace + one promoted from pending
    expect(memberships).toHaveLength(2)
    const shared = memberships.find((m) => m.workspaceId === sharedWorkspaceId)
    expect(shared).toBeDefined()
    expect(shared?.role).toBe('member')

    const remainingPending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.email, 'newcomer@test.com'))
    expect(remainingPending).toHaveLength(0)
  })

  it('normalizes the email before matching pending memberships', async () => {
    await insertUser('admin2', 'admin2@test.com')
    await bootstrapUserWorkspace(db, 'admin2', 'admin2@test.com')

    const adminWorkspaces = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerUserId, 'admin2'))
    const sharedWorkspaceId = adminWorkspaces[0].id

    // Pending row stored with lowercase email (admin invite path normalizes too).
    await db.insert(workspacePendingMembershipsTable).values({
      id: uuidv7(),
      workspaceId: sharedWorkspaceId,
      email: 'mixedcase@test.com',
      role: 'admin',
      invitedByUserId: 'admin2',
    })

    // User signs up with mixed-case email — Better Auth's `before` hook normalizes
    // user.email, so the bootstrap call receives lowercased input. Verify both halves
    // of that contract by passing a mixed-case string here.
    await insertUser('mixed', 'mixedcase@test.com')
    await bootstrapUserWorkspace(db, 'mixed', 'MixedCase@TEST.com')

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

  it('handles a user with no matching pending memberships', async () => {
    await insertUser('u3', 'u3@test.com')
    await bootstrapUserWorkspace(db, 'u3', 'u3@test.com')

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.userId, 'u3'))
    expect(memberships).toHaveLength(1)
  })
})
