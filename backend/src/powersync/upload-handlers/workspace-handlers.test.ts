/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { bootstrapUserWorkspace } from '@/dal/workspaces'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { applyUploadBatch } from './registry'
import type { UploadCtx, UploadOp } from './types'

describe('workspace upload handlers', () => {
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

  const ctxFor = (userId: string, overrides: Partial<UploadCtx> = {}): UploadCtx => ({
    userId,
    settings: createTestSettings(),
    ...overrides,
  })

  const getPersonalWorkspaceId = async (userId: string) => {
    const rows = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerUserId, userId))
    return rows[0].id
  }

  const expectPermanentReject = (result: Awaited<ReturnType<typeof applyUploadBatch>>, code: string): void => {
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0].code).toBe(code)
    }
  }

  beforeEach(async () => {
    const env = await createTestDb()
    db = env.db
    cleanup = env.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('workspaces', () => {
    it('rejects member-initiated creation when the policy flag is off', async () => {
      await insertUser('member', 'member@test.com')
      // No prior workspace → not admin of any → policy-gated.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Forbidden' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('member'))
      expectPermanentReject(result, 'WORKSPACE_CREATION_DISABLED')

      const present = await db.select().from(workspacesTable).where(eq(workspacesTable.id, op.id))
      expect(present).toHaveLength(0)
    })

    it('allows member-initiated creation when the policy flag is on', async () => {
      await insertUser('member2', 'm2@test.com')
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Shared with everyone' },
      }
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('member2', {
          settings: createTestSettings({ allowWorkspaceCreationByMembers: true }),
        }),
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const inserted = await db.select().from(workspacesTable).where(eq(workspacesTable.id, op.id))
      expect(inserted).toHaveLength(1)
      expect(inserted[0].name).toBe('Shared with everyone')
      expect(inserted[0].isPersonal).toBe(false)
    })

    it('allows an admin of any workspace to create new shared workspaces even with the flag off', async () => {
      await insertUser('admin', 'a@test.com')
      await bootstrapUserWorkspace(db, 'admin', 'a@test.com')
      // Admin of personal workspace counts as admin-of-any.

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Admin-created' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }
    })

    it('rejects attempts to create a personal workspace from the client', async () => {
      await insertUser('member3', 'm3@test.com')
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Sneaky', is_personal: true },
      }
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('member3', {
          settings: createTestSettings({ allowWorkspaceCreationByMembers: true }),
        }),
      )
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_SERVER_MANAGED')
    })

    it('rejects renaming the personal workspace', async () => {
      await insertUser('owner', 'owner@test.com')
      await bootstrapUserWorkspace(db, 'owner', 'owner@test.com')
      const personalId = await getPersonalWorkspaceId('owner')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: personalId,
        data: { name: 'Renamed personal' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('owner'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('rejects updates by non-admins of a shared workspace', async () => {
      await insertUser('a1', 'a1@test.com')
      await insertUser('b1', 'b1@test.com')
      await bootstrapUserWorkspace(db, 'a1', 'a1@test.com')

      // a1 creates a shared workspace.
      const create: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Original' },
      }
      const createResult = await applyUploadBatch(db, [create], ctxFor('a1'))
      expect(createResult.ok).toBe(true)

      // b1 (not a member) tries to rename it.
      const rename: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: create.id,
        data: { name: 'Hijacked' },
      }
      const renameResult = await applyUploadBatch(db, [rename], ctxFor('b1'))
      expectPermanentReject(renameResult, 'NOT_WORKSPACE_ADMIN')

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, create.id))
      expect(stored[0].name).toBe('Original')
    })

    it('rejects DELETE on workspaces (v1 deferred)', async () => {
      await insertUser('owner2', 'owner2@test.com')
      await bootstrapUserWorkspace(db, 'owner2', 'owner2@test.com')
      const personalId = await getPersonalWorkspaceId('owner2')

      const op: UploadOp = { op: 'DELETE', type: 'workspaces', id: personalId }
      const result = await applyUploadBatch(db, [op], ctxFor('owner2'))
      expectPermanentReject(result, 'WORKSPACE_DELETE_DISABLED')
    })
  })

  describe('workspace_memberships', () => {
    it('rejects writes to a workspace the actor is not in', async () => {
      await insertUser('a2', 'a2@test.com')
      await insertUser('b2', 'b2@test.com')
      await bootstrapUserWorkspace(db, 'a2', 'a2@test.com')
      const a2WorkspaceId = await getPersonalWorkspaceId('a2')

      // b2 tries to add themselves to a2's personal workspace.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: {
          workspace_id: a2WorkspaceId,
          user_id: 'b2',
          role: 'admin',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('b2'))
      // Personal-workspace check fires first.
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('rejects modifications to personal-workspace memberships', async () => {
      await insertUser('a3', 'a3@test.com')
      await bootstrapUserWorkspace(db, 'a3', 'a3@test.com')
      const a3WorkspaceId = await getPersonalWorkspaceId('a3')

      const existingMembership = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, a3WorkspaceId))

      const op: UploadOp = {
        op: 'DELETE',
        type: 'workspace_memberships',
        id: existingMembership[0].id,
      }
      const result = await applyUploadBatch(db, [op], ctxFor('a3'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('protects the last admin of a shared workspace from deletion', async () => {
      await insertUser('a4', 'a4@test.com')
      await bootstrapUserWorkspace(db, 'a4', 'a4@test.com')

      // Create a shared workspace via the handler, then directly seed a4 as its
      // sole admin so we can exercise last-admin protection without relying on a
      // creator-side membership flow (that lands in a later commit).
      const sharedId = uuidv7()
      const createWorkspace: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: sharedId,
        data: { name: 'Shared' },
      }
      await applyUploadBatch(db, [createWorkspace], ctxFor('a4'))

      const a4MembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: a4MembershipId,
        workspaceId: sharedId,
        userId: 'a4',
        role: 'admin',
      })

      const op: UploadOp = {
        op: 'DELETE',
        type: 'workspace_memberships',
        id: a4MembershipId,
      }
      const result = await applyUploadBatch(db, [op], ctxFor('a4'))
      expectPermanentReject(result, 'LAST_ADMIN_PROTECTED')

      const stillThere = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.id, a4MembershipId))
      expect(stillThere).toHaveLength(1)
    })
  })

  describe('workspace_pending_memberships', () => {
    it('rejects writes by non-admins of the target workspace', async () => {
      await insertUser('a5', 'a5@test.com')
      await insertUser('b5', 'b5@test.com')
      await bootstrapUserWorkspace(db, 'a5', 'a5@test.com')

      // Seed a shared workspace where a5 is admin.
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({
        id: sharedId,
        name: 'Shared',
        isPersonal: false,
        ownerUserId: null,
      })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'a5',
        role: 'admin',
      })

      // b5 (no membership) tries to invite an email.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'invitee@test.com',
          role: 'member',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('b5'))
      expectPermanentReject(result, 'NOT_WORKSPACE_ADMIN')
    })

    it('normalizes email on insert', async () => {
      await insertUser('admin5', 'admin5@test.com')
      await bootstrapUserWorkspace(db, 'admin5', 'admin5@test.com')

      // Seed a shared workspace where admin5 is admin.
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({
        id: sharedId,
        name: 'Shared',
        isPersonal: false,
        ownerUserId: null,
      })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin5',
        role: 'admin',
      })

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: ' MixedCase@TEST.com ',
          role: 'member',
          invited_by_user_id: 'admin5',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin5'))
      expect(result.ok).toBe(true)

      const stored = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.id, op.id))
      expect(stored[0].email).toBe('mixedcase@test.com')
    })
  })

  describe('batch accumulation', () => {
    it('accumulates multiple permanent rejections in one response', async () => {
      await insertUser('owner3', 'owner3@test.com')
      await bootstrapUserWorkspace(db, 'owner3', 'owner3@test.com')
      const personalId = await getPersonalWorkspaceId('owner3')

      const renamePersonal: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: personalId,
        data: { name: 'Renamed' },
      }
      const sneakyPersonal: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Sneaky', is_personal: true },
      }
      const result = await applyUploadBatch(
        db,
        [renamePersonal, sneakyPersonal],
        ctxFor('owner3', {
          settings: createTestSettings({ allowWorkspaceCreationByMembers: true }),
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(2)
        expect(result.rejected[0].code).toBe('PERSONAL_WORKSPACE_IMMUTABLE')
        expect(result.rejected[0].op.id).toBe(personalId)
        expect(result.rejected[1].code).toBe('PERSONAL_WORKSPACE_SERVER_MANAGED')
        expect(result.rejected[1].op.id).toBe(sneakyPersonal.id)
      }
    })

    it('preserves applied ops alongside permanent rejections', async () => {
      await insertUser('owner4', 'owner4@test.com')
      await bootstrapUserWorkspace(db, 'owner4', 'owner4@test.com')
      const personalId = await getPersonalWorkspaceId('owner4')

      const validCreate: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'New shared' },
      }
      const invalidPatch: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: personalId,
        data: { name: 'Renamed personal' },
      }

      const result = await applyUploadBatch(db, [validCreate, invalidPatch], ctxFor('owner4'))

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(1)
        expect(result.rejected[0].code).toBe('PERSONAL_WORKSPACE_IMMUTABLE')
      }

      // The valid create landed; the invalid patch did not.
      const created = await db.select().from(workspacesTable).where(eq(workspacesTable.id, validCreate.id))
      expect(created).toHaveLength(1)
      expect(created[0].name).toBe('New shared')

      const personal = await db.select().from(workspacesTable).where(eq(workspacesTable.id, personalId))
      expect(personal[0].name).toBe('Personal')
    })
  })
})
