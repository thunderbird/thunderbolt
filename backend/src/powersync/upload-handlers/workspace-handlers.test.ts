/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { workspaceMembershipsTable, workspacePendingMembershipsTable, workspacesTable } from '@/db/powersync-schema'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { computePersonalAdminMembershipId, computePersonalWorkspaceId } from '@shared/workspaces'
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

  /**
   * Drives a personal-workspace bootstrap through the real upload handler — the
   * same code path the FE exercises on first sign-in. Verifies the canonical
   * acceptance path and gives later tests a personal-workspace fixture to
   * exercise the immutability rules against.
   */
  const bootstrapPersonalViaUpload = async (userId: string): Promise<string> => {
    const workspaceId = computePersonalWorkspaceId(userId)
    const membershipId = computePersonalAdminMembershipId(userId)
    const ops: UploadOp[] = [
      {
        op: 'PUT',
        type: 'workspaces',
        id: workspaceId,
        data: { is_personal: true, owner_user_id: userId, name: 'Personal' },
      },
      {
        op: 'PUT',
        type: 'workspace_memberships',
        id: membershipId,
        data: { workspace_id: workspaceId, user_id: userId, role: 'admin' },
      },
    ]
    const result = await applyUploadBatch(db, ops, ctxFor(userId))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rejected).toHaveLength(0)
    }
    return workspaceId
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

  describe('workspaces — personal', () => {
    it('accepts a personal workspace PUT with canonical id and matching owner', async () => {
      await insertUser('owner1', 'owner1@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner1')

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored).toHaveLength(1)
      expect(stored[0].isPersonal).toBe(true)
      expect(stored[0].ownerUserId).toBe('owner1')
      expect(stored[0].name).toBe('Personal')
    })

    it('rejects a personal workspace PUT with non-canonical id', async () => {
      await insertUser('owner2', 'owner2@test.com')
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { is_personal: true, owner_user_id: 'owner2', name: 'Personal' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('owner2'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
    })

    it('rejects a personal workspace PUT claiming someone else as owner', async () => {
      await insertUser('attacker', 'attacker@test.com')
      // Attacker tries to upload a personal workspace under victim's canonical id.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: computePersonalWorkspaceId('victim'),
        data: { is_personal: true, owner_user_id: 'victim', name: 'Personal' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('attacker'))
      // Canonical-id check fires first since the attacker's userId doesn't hash
      // to the same workspace id; the owner-mismatch branch covers the case
      // where someone supplies a matching id but a different owner field.
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
    })

    it('is idempotent on re-upload — multiple devices uploading the same row', async () => {
      await insertUser('mdev', 'mdev@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('mdev')

      // Simulate device B uploading the same canonical row.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: workspaceId,
        data: { is_personal: true, owner_user_id: 'mdev', name: 'Personal' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('mdev'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored).toHaveLength(1)
    })

    it('rejects PATCH on a personal workspace (immutable)', async () => {
      await insertUser('owner3', 'owner3@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner3')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { name: 'Renamed' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('owner3'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('rejects DELETE on workspaces (v1 deferred)', async () => {
      await insertUser('owner4', 'owner4@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner4')

      const op: UploadOp = { op: 'DELETE', type: 'workspaces', id: workspaceId }
      const result = await applyUploadBatch(db, [op], ctxFor('owner4'))
      expectPermanentReject(result, 'WORKSPACE_DELETE_DISABLED')
    })
  })

  describe('workspaces — shared', () => {
    it('rejects member-initiated creation when the policy flag is off', async () => {
      await insertUser('member', 'member@test.com')
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Forbidden' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('member'))
      expectPermanentReject(result, 'WORKSPACE_CREATION_DISABLED')
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

      const inserted = await db.select().from(workspacesTable).where(eq(workspacesTable.id, op.id))
      expect(inserted).toHaveLength(1)
      expect(inserted[0].name).toBe('Shared with everyone')
      expect(inserted[0].isPersonal).toBe(false)
    })

    it('lets a user who admins their own personal workspace create shared workspaces with the flag off', async () => {
      await insertUser('admin', 'a@test.com')
      await bootstrapPersonalViaUpload('admin')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Admin-created' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin'))
      expect(result.ok).toBe(true)
    })

    it('rejects updates by non-admins of a shared workspace', async () => {
      await insertUser('a1', 'a1@test.com')
      await insertUser('b1', 'b1@test.com')
      await bootstrapPersonalViaUpload('a1')

      const create: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { name: 'Original' },
      }
      const createResult = await applyUploadBatch(db, [create], ctxFor('a1'))
      expect(createResult.ok).toBe(true)

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
  })

  describe('workspace_memberships', () => {
    it('accepts the bootstrap admin membership for own personal workspace', async () => {
      await insertUser('owner5', 'owner5@test.com')
      // The bootstrapPersonalViaUpload helper exercises this in one batch; here
      // we split it into two batches to verify the membership exception fires
      // even when uploaded separately.
      const workspaceId = computePersonalWorkspaceId('owner5')
      const wsOp: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: workspaceId,
        data: { is_personal: true, owner_user_id: 'owner5', name: 'Personal' },
      }
      const wsResult = await applyUploadBatch(db, [wsOp], ctxFor('owner5'))
      expect(wsResult.ok).toBe(true)

      const memOp: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: computePersonalAdminMembershipId('owner5'),
        data: { workspace_id: workspaceId, user_id: 'owner5', role: 'admin' },
      }
      const memResult = await applyUploadBatch(db, [memOp], ctxFor('owner5'))
      expect(memResult.ok).toBe(true)

      const stored = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
      expect(stored).toHaveLength(1)
      expect(stored[0].role).toBe('admin')
    })

    it('rejects a second membership write to a personal workspace (immutable)', async () => {
      await insertUser('owner6', 'owner6@test.com')
      await insertUser('victim', 'victim@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner6')

      // owner6 tries to add another member to their personal workspace.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: workspaceId, user_id: 'victim', role: 'member' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('owner6'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('rejects bootstrap admin membership for another user', async () => {
      await insertUser('badguy', 'badguy@test.com')
      await insertUser('target', 'target@test.com')
      const targetWorkspaceId = await bootstrapPersonalViaUpload('target')

      // badguy tries to claim admin in target's personal workspace.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: targetWorkspaceId, user_id: 'badguy', role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('badguy'))
      // Personal-workspace immutability kicks in.
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_IMMUTABLE')
    })

    it('protects the last admin of a shared workspace from deletion', async () => {
      await insertUser('a4', 'a4@test.com')
      await bootstrapPersonalViaUpload('a4')

      const sharedId = uuidv7()
      await applyUploadBatch(
        db,
        [{ op: 'PUT', type: 'workspaces', id: sharedId, data: { name: 'Shared' } }],
        ctxFor('a4'),
      )

      // Seed an admin membership directly so we can exercise last-admin protection;
      // the creator-admin flow lands later when shared-workspace creation also
      // creates the admin membership.
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
    const seedSharedAsAdmin = async (adminUserId: string): Promise<string> => {
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
        userId: adminUserId,
        role: 'admin',
      })
      return sharedId
    }

    it('rejects writes by non-admins of the target workspace', async () => {
      await insertUser('a5', 'a5@test.com')
      await insertUser('b5', 'b5@test.com')
      await bootstrapPersonalViaUpload('a5')
      const sharedId = await seedSharedAsAdmin('a5')

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
      await bootstrapPersonalViaUpload('admin5')
      const sharedId = await seedSharedAsAdmin('admin5')

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

    it('promotes to membership + deletes pending row when invited email matches an existing user', async () => {
      await insertUser('admin6', 'admin6@test.com')
      await insertUser('invitee1', 'invitee1@test.com')
      await bootstrapPersonalViaUpload('admin6')
      const sharedId = await seedSharedAsAdmin('admin6')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'invitee1@test.com',
          role: 'member',
          invited_by_user_id: 'admin6',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin6'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const pending = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.id, op.id))
      expect(pending).toHaveLength(0)

      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, sharedId))
      // admin6 (from seedSharedAsAdmin) + invitee1 (promoted)
      expect(memberships).toHaveLength(2)
      const invitee = memberships.find((m) => m.userId === 'invitee1')
      expect(invitee).toBeDefined()
      expect(invitee?.role).toBe('member')
    })

    it('promotes via normalized email match (case + whitespace)', async () => {
      await insertUser('admin7', 'admin7@test.com')
      await insertUser('invitee2', 'invitee2@test.com')
      await bootstrapPersonalViaUpload('admin7')
      const sharedId = await seedSharedAsAdmin('admin7')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: ' Invitee2@TEST.com ',
          role: 'admin',
          invited_by_user_id: 'admin7',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin7'))
      expect(result.ok).toBe(true)

      const pending = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.id, op.id))
      expect(pending).toHaveLength(0)

      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, sharedId))
      const invitee = memberships.find((m) => m.userId === 'invitee2')
      expect(invitee?.role).toBe('admin')
    })

    it('keeps pending row when invited email does not match any user', async () => {
      await insertUser('admin8', 'admin8@test.com')
      await bootstrapPersonalViaUpload('admin8')
      const sharedId = await seedSharedAsAdmin('admin8')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'nobody@test.com',
          role: 'member',
          invited_by_user_id: 'admin8',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin8'))
      expect(result.ok).toBe(true)

      const pending = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.id, op.id))
      expect(pending).toHaveLength(1)
      expect(pending[0].email).toBe('nobody@test.com')

      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, sharedId))
      // only the seed admin — no promotion
      expect(memberships).toHaveLength(1)
    })
  })

  describe('batch accumulation', () => {
    it('accepts a workspace + admin-membership batch atomically (FE first sign-in)', async () => {
      await insertUser('combo', 'combo@test.com')
      const workspaceId = computePersonalWorkspaceId('combo')
      const membershipId = computePersonalAdminMembershipId('combo')
      const ops: UploadOp[] = [
        {
          op: 'PUT',
          type: 'workspaces',
          id: workspaceId,
          data: { is_personal: true, owner_user_id: 'combo', name: 'Personal' },
        },
        {
          op: 'PUT',
          type: 'workspace_memberships',
          id: membershipId,
          data: { workspace_id: workspaceId, user_id: 'combo', role: 'admin' },
        },
      ]
      const result = await applyUploadBatch(db, ops, ctxFor('combo'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
      expect(ws).toHaveLength(1)
      expect(memberships).toHaveLength(1)
    })

    it('accumulates multiple permanent rejections in one response', async () => {
      await insertUser('owner7', 'owner7@test.com')
      const personalId = await bootstrapPersonalViaUpload('owner7')

      const renamePersonal: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: personalId,
        data: { name: 'Renamed' },
      }
      const wrongIdPersonal: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { is_personal: true, owner_user_id: 'owner7', name: 'Sneaky' },
      }
      const result = await applyUploadBatch(
        db,
        [renamePersonal, wrongIdPersonal],
        ctxFor('owner7', {
          settings: createTestSettings({ allowWorkspaceCreationByMembers: true }),
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(2)
        expect(result.rejected[0].code).toBe('PERSONAL_WORKSPACE_IMMUTABLE')
        expect(result.rejected[1].code).toBe('PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
      }
    })
  })
})
