/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import {
  agentsTable,
  mcpServersTable,
  modelsTable,
  modesTable,
  skillsTable,
  tasksTable,
  workspaceMembershipsTable,
  workspacePendingMembershipsTable,
  workspacePermissionsTable,
  workspacesTable,
} from '@/db/powersync-schema'
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

    it('allows PATCH-rename on a personal workspace by its owner-admin', async () => {
      await insertUser('owner3', 'owner3@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner3')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { name: 'Home base' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('owner3'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].name).toBe('Home base')
    })

    it('rejects PATCH on a personal workspace from a non-owner', async () => {
      await insertUser('owner3b', 'owner3b@test.com')
      await insertUser('attacker3', 'attacker3@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('owner3b')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { name: 'Hijacked' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('attacker3'))
      expectPermanentReject(result, 'NOT_WORKSPACE_ADMIN')

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].name).toBe('Personal')
    })

    it('preserves a prior rename when a second device re-uploads the bootstrap PUT', async () => {
      await insertUser('mdev2', 'mdev2@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('mdev2')

      // User renames on device A.
      const renameOp: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { name: 'Renamed' },
      }
      const renameResult = await applyUploadBatch(db, [renameOp], ctxFor('mdev2'))
      expect(renameResult.ok).toBe(true)

      // Device B's idempotent bootstrap re-uploads the canonical PUT with the
      // default name — must not clobber the rename.
      const reBootstrap: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: workspaceId,
        data: { is_personal: true, owner_user_id: 'mdev2', name: 'Default' },
      }
      const reResult = await applyUploadBatch(db, [reBootstrap], ctxFor('mdev2'))
      expect(reResult.ok).toBe(true)

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].name).toBe('Renamed')
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

  describe('workspaces — slug + icon', () => {
    const createSharedAs = async (userId: string, name = 'Acme'): Promise<string> => {
      const id = uuidv7()
      await applyUploadBatch(
        db,
        [{ op: 'PUT', type: 'workspaces', id, data: { name } }],
        ctxFor(userId, { settings: createTestSettings({ allowWorkspaceCreationByMembers: true }) }),
      )
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId: id, userId, role: 'admin' })
      return id
    }

    it('PATCH applies slug + icon on a shared workspace by its admin', async () => {
      await insertUser('slugadmin', 'slugadmin@test.com')
      const workspaceId = await createSharedAs('slugadmin', 'Original')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { slug: 'engineering', icon: '🛠️' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('slugadmin'))
      expect(result.ok).toBe(true)

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].slug).toBe('engineering')
      expect(stored[0].icon).toBe('🛠️')
    })

    it('PATCH rejects slug on a personal workspace', async () => {
      await insertUser('personal_slug', 'personal_slug@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('personal_slug')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { slug: 'nope' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('personal_slug'))
      expectPermanentReject(result, 'PERSONAL_WORKSPACE_SLUG_FORBIDDEN')

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].slug).toBeNull()
    })

    it('PATCH allows icon-only update on a personal workspace', async () => {
      await insertUser('personal_icon', 'personal_icon@test.com')
      const workspaceId = await bootstrapPersonalViaUpload('personal_icon')

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspaces',
        id: workspaceId,
        data: { icon: '🏠' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('personal_icon'))
      expect(result.ok).toBe(true)

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].icon).toBe('🏠')
      expect(stored[0].slug).toBeNull()
    })

    it('PUT does not clear server-side slug/icon when payload omits them', async () => {
      await insertUser('keepfields', 'keepfields@test.com')
      const workspaceId = await createSharedAs('keepfields', 'Initial')

      // Set slug + icon via PATCH.
      const patchResult = await applyUploadBatch(
        db,
        [{ op: 'PATCH', type: 'workspaces', id: workspaceId, data: { slug: 'kept-slug', icon: '🎯' } }],
        ctxFor('keepfields'),
      )
      expect(patchResult.ok).toBe(true)

      // Now PUT with only `name` — slug + icon must survive.
      const putResult = await applyUploadBatch(
        db,
        [{ op: 'PUT', type: 'workspaces', id: workspaceId, data: { name: 'Renamed' } }],
        ctxFor('keepfields'),
      )
      expect(putResult.ok).toBe(true)

      const stored = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      expect(stored[0].name).toBe('Renamed')
      expect(stored[0].slug).toBe('kept-slug')
      expect(stored[0].icon).toBe('🎯')
    })

    it('PUT rejects shared workspace with a slug already taken', async () => {
      await insertUser('first', 'first@test.com')
      await insertUser('second', 'second@test.com')
      await bootstrapPersonalViaUpload('first')
      await bootstrapPersonalViaUpload('second')

      const firstId = uuidv7()
      const firstResult = await applyUploadBatch(
        db,
        [{ op: 'PUT', type: 'workspaces', id: firstId, data: { name: 'First', slug: 'shared-slug' } }],
        ctxFor('first'),
      )
      expect(firstResult.ok).toBe(true)

      const secondId = uuidv7()
      const secondResult = await applyUploadBatch(
        db,
        [{ op: 'PUT', type: 'workspaces', id: secondId, data: { name: 'Second', slug: 'shared-slug' } }],
        ctxFor('second'),
      )
      expectPermanentReject(secondResult, 'WORKSPACE_SLUG_TAKEN')
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
      // Display info is denormalized from auth.user by the upload handler so the
      // FE Members page can render without a synced users projection.
      expect(stored[0].userName).toBe('Test User')
      expect(stored[0].userEmail).toBe('owner5@test.com')
    })

    it('rejects an admin-role membership PUT from invite_users-only caller (escalation guard)', async () => {
      // Direct `workspace_memberships` PUT with `role: 'admin'` must require
      // `change_roles` in addition to `invite_users` — same shape as the
      // pending-membership escalation guard.
      await insertUser('admin-ws', 'admin-ws@test.com')
      await bootstrapPersonalViaUpload('admin-ws')
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
        userId: 'admin-ws',
        role: 'admin',
      })
      const memberId = 'ws-member-invite-only'
      await insertUser(memberId, 'ws-member-invite-only@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })
      const newUserId = 'new-admin-target'
      await insertUser(newUserId, 'new-admin-target@test.com')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, user_id: newUserId, role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('rejects PUT that demotes an existing admin without change_roles', async () => {
      // `upsertMembership` does ON CONFLICT DO UPDATE SET role on
      // `(workspace_id, user_id)`. A caller with `invite_users` alone could
      // otherwise PUT `role: 'member'` at an existing admin's pair and
      // demote them without `change_roles` — same effective action as a
      // PATCH demote, which DOES require `change_roles`.
      await insertUser('demote-admin', 'demote-admin@test.com')
      await bootstrapPersonalViaUpload('demote-admin')
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
        userId: 'demote-admin',
        role: 'admin',
      })
      const targetAdminId = 'demote-target-admin'
      await insertUser(targetAdminId, 'demote-target-admin@test.com')
      const targetMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: targetMembershipId,
        workspaceId: sharedId,
        userId: targetAdminId,
        role: 'admin',
      })
      const memberId = 'demote-actor-invite-only'
      await insertUser(memberId, 'demote-actor-invite-only@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })

      // PUT with a fresh op.id (so the lookup must hit by `(workspace_id, user_id)`)
      // and the demoted role on the existing admin's pair.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, user_id: targetAdminId, role: 'member' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')

      // Existing admin row is untouched.
      const stored = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.id, targetMembershipId))
      expect(stored[0].role).toBe('admin')
    })

    it('rejects PUT that would demote the last admin (last-admin protection)', async () => {
      // PUT's apply path upserts via `ON CONFLICT DO UPDATE SET role`. Without
      // a last-admin guard in apply, a caller satisfying `change_roles` could
      // demote the workspace's only admin to member by PUT — leaving zero
      // admins, while PATCH/DELETE would reject with LAST_ADMIN_PROTECTED.
      await insertUser('lone-admin', 'lone-admin@test.com')
      await bootstrapPersonalViaUpload('lone-admin')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({
        id: sharedId,
        name: 'Shared',
        isPersonal: false,
        ownerUserId: null,
      })
      const adminMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: adminMembershipId,
        workspaceId: sharedId,
        userId: 'lone-admin',
        role: 'admin',
      })
      const memberId = 'member-with-cr-demote'
      await insertUser(memberId, 'member-with-cr-demote@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      // Grant both keys so PUT validate passes — the test exercises the apply
      // layer's last-admin guard.
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'change_roles',
        requiredRole: 'member',
      })

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, user_id: 'lone-admin', role: 'member' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'LAST_ADMIN_PROTECTED')

      // The admin row is unchanged.
      const stored = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.id, adminMembershipId))
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

    it('PATCH role: allowed when caller has change_roles=member', async () => {
      await insertUser('admin-cr-ok', 'admin-cr-ok@test.com')
      await insertUser('target-cr-ok', 'target-cr-ok@test.com')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({ id: sharedId, name: 'Shared', isPersonal: false })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin-cr-ok',
        role: 'admin',
      })
      const memberId = 'member-with-cr'
      await insertUser(memberId, 'member-with-cr@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      const targetMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: targetMembershipId,
        workspaceId: sharedId,
        userId: 'target-cr-ok',
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'change_roles',
        requiredRole: 'member',
      })

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspace_memberships',
        id: targetMembershipId,
        data: { role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expect(result.ok).toBe(true)
    })

    it('PATCH role: rejected when caller lacks change_roles', async () => {
      await insertUser('admin-cr-no', 'admin-cr-no@test.com')
      await insertUser('target-cr-no', 'target-cr-no@test.com')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({ id: sharedId, name: 'Shared', isPersonal: false })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin-cr-no',
        role: 'admin',
      })
      const memberId = 'member-no-cr'
      await insertUser(memberId, 'member-no-cr@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      const targetMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: targetMembershipId,
        workspaceId: sharedId,
        userId: 'target-cr-no',
        role: 'member',
      })
      // No workspace_permissions row → change_roles defaults to admin.

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspace_memberships',
        id: targetMembershipId,
        data: { role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('DELETE: allowed when caller has remove_users=member', async () => {
      await insertUser('admin-ru-ok', 'admin-ru-ok@test.com')
      await insertUser('target-ru-ok', 'target-ru-ok@test.com')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({ id: sharedId, name: 'Shared', isPersonal: false })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin-ru-ok',
        role: 'admin',
      })
      const memberId = 'member-with-ru'
      await insertUser(memberId, 'member-with-ru@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      const targetMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: targetMembershipId,
        workspaceId: sharedId,
        userId: 'target-ru-ok',
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'remove_users',
        requiredRole: 'member',
      })

      const op: UploadOp = {
        op: 'DELETE',
        type: 'workspace_memberships',
        id: targetMembershipId,
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expect(result.ok).toBe(true)
    })

    it('DELETE: rejected when caller lacks remove_users', async () => {
      await insertUser('admin-ru-no', 'admin-ru-no@test.com')
      await insertUser('target-ru-no', 'target-ru-no@test.com')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({ id: sharedId, name: 'Shared', isPersonal: false })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin-ru-no',
        role: 'admin',
      })
      const memberId = 'member-no-ru'
      await insertUser(memberId, 'member-no-ru@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      const targetMembershipId = uuidv7()
      await db.insert(workspaceMembershipsTable).values({
        id: targetMembershipId,
        workspaceId: sharedId,
        userId: 'target-ru-no',
        role: 'member',
      })

      const op: UploadOp = {
        op: 'DELETE',
        type: 'workspace_memberships',
        id: targetMembershipId,
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('rejects a PUT adding another user when e2eeEnabled is true (THU-593)', async () => {
      await insertUser('admin-e1', 'admin-e1@test.com')
      await insertUser('invitee-e1', 'invitee-e1@test.com')
      const sharedId = uuidv7()
      await db.insert(workspacesTable).values({ id: sharedId, name: 'E2EE shared', isPersonal: false })
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'admin-e1',
        role: 'admin',
      })

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, user_id: 'invitee-e1', role: 'member' },
      }
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('admin-e1', { settings: createTestSettings({ e2eeEnabled: true }) }),
      )
      expectPermanentReject(result, 'E2EE_MEMBERSHIPS_DISABLED')
    })

    it('still allows the self-bootstrap PUT when e2eeEnabled is true', async () => {
      await insertUser('owner-e1', 'owner-e1@test.com')
      const workspaceId = computePersonalWorkspaceId('owner-e1')
      const ops: UploadOp[] = [
        {
          op: 'PUT',
          type: 'workspaces',
          id: workspaceId,
          data: { is_personal: true, owner_user_id: 'owner-e1', name: 'Personal' },
        },
        {
          op: 'PUT',
          type: 'workspace_memberships',
          id: computePersonalAdminMembershipId('owner-e1'),
          data: { workspace_id: workspaceId, user_id: 'owner-e1', role: 'admin' },
        },
      ]
      const result = await applyUploadBatch(
        db,
        ops,
        ctxFor('owner-e1', { settings: createTestSettings({ e2eeEnabled: true }) }),
      )
      expect(result.ok).toBe(true)
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

    it('allows a member to invite when invite_users is granted to member role', async () => {
      await insertUser('a-perm', 'a-perm@test.com')
      await insertUser('b-perm', 'b-perm@test.com')
      await bootstrapPersonalViaUpload('a-perm')
      const sharedId = await seedSharedAsAdmin('a-perm')

      // b-perm becomes a member of the shared workspace.
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'b-perm',
        role: 'member',
      })

      // Workspace grants `invite_users` to the `member` role.
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })

      // b-perm (member) sends a pending invite — should succeed.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'newcomer@test.com',
          role: 'member',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('b-perm'))
      expect(result.ok).toBe(true)
    })

    it('rejects an admin-role pending invite from invite_users-only caller (escalation guard)', async () => {
      // `invite_users` alone must not be enough to invite `role: 'admin'` —
      // otherwise the signup-promote path would mint a new admin and bypass
      // the `change_roles` gate that protects existing-member promotions.
      await insertUser('inviter-only', 'inviter-only@test.com')
      await bootstrapPersonalViaUpload('inviter-only')
      const sharedId = await seedSharedAsAdmin('inviter-only')
      const memberId = 'member-with-invite-only'
      await insertUser(memberId, 'member-with-invite-only@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, email: 'pending-admin@test.com', role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('rejects PATCH that promotes a pending invite to admin without change_roles', async () => {
      // PATCH-to-admin must hit the same escalation guard as PUT-to-admin —
      // otherwise an inviter could quietly elevate a pending invite they
      // shouldn't be able to promote.
      await insertUser('patch-inviter', 'patch-inviter@test.com')
      await bootstrapPersonalViaUpload('patch-inviter')
      const sharedId = await seedSharedAsAdmin('patch-inviter')
      const memberId = 'patch-member-invite-only'
      await insertUser(memberId, 'patch-member-invite-only@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })

      // Seed a pending invite at role=member, then try to PATCH to admin.
      const pendingId = uuidv7()
      await db.insert(workspacePendingMembershipsTable).values({
        id: pendingId,
        workspaceId: sharedId,
        email: 'pending-target@test.com',
        role: 'member',
        invitedByUserId: 'patch-inviter',
      })

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspace_pending_memberships',
        id: pendingId,
        data: { role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('allows PATCH demoting a pending admin invite to member from invite_users-only caller', async () => {
      // The escalation guard is intentionally one-way: promotions to admin
      // require `change_roles`, but demotions stay gated on `invite_users`
      // alone. Demoting a pending admin invite is tampering, not escalation,
      // and matching the broader "any role change" rule from the memberships
      // handler would cost an extra DB read for a non-security concern.
      await insertUser('demote-inviter', 'demote-inviter@test.com')
      await bootstrapPersonalViaUpload('demote-inviter')
      const sharedId = await seedSharedAsAdmin('demote-inviter')
      const memberId = 'demote-member-invite-only'
      await insertUser(memberId, 'demote-member-invite-only@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      await db.insert(workspacePermissionsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        permissionKey: 'invite_users',
        requiredRole: 'member',
      })

      const pendingId = uuidv7()
      await db.insert(workspacePendingMembershipsTable).values({
        id: pendingId,
        workspaceId: sharedId,
        email: 'pending-admin-to-demote@test.com',
        role: 'admin',
        invitedByUserId: 'demote-inviter',
      })

      const op: UploadOp = {
        op: 'PATCH',
        type: 'workspace_pending_memberships',
        id: pendingId,
        data: { role: 'member' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expect(result.ok).toBe(true)
    })

    it('allows an admin-role pending invite when caller has BOTH invite_users and change_roles', async () => {
      await insertUser('inviter-both', 'inviter-both@test.com')
      await bootstrapPersonalViaUpload('inviter-both')
      const sharedId = await seedSharedAsAdmin('inviter-both')
      const memberId = 'member-with-both'
      await insertUser(memberId, 'member-with-both@test.com')
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: memberId,
        role: 'member',
      })
      for (const key of ['invite_users', 'change_roles'] as const) {
        await db.insert(workspacePermissionsTable).values({
          id: uuidv7(),
          workspaceId: sharedId,
          permissionKey: key,
          requiredRole: 'member',
        })
      }

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, email: 'pending-admin-allowed@test.com', role: 'admin' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor(memberId))
      expect(result.ok).toBe(true)
    })

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
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
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
      // Promotion carries the matched user's display info onto the membership row.
      expect(invitee?.userName).toBe('Test User')
      expect(invitee?.userEmail).toBe('invitee1@test.com')
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

    it('deletes the actual pending row on promote-on-insert even after unique-key conflict', async () => {
      await insertUser('admin10', 'admin10@test.com')
      await insertUser('invitee3', 'invitee3@test.com')
      await bootstrapPersonalViaUpload('admin10')
      const sharedId = await seedSharedAsAdmin('admin10')

      // Seed an existing pending row with id=X.
      const originalPendingId = uuidv7()
      await db.insert(workspacePendingMembershipsTable).values({
        id: originalPendingId,
        workspaceId: sharedId,
        email: 'invitee3@test.com',
        role: 'admin',
        invitedByUserId: 'admin10',
      })

      // Now upload a NEW pending op (id=Y) for the same workspace+email.
      const newOpId = uuidv7()
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: newOpId,
        data: {
          workspace_id: sharedId,
          email: 'invitee3@test.com',
          role: 'member',
          invited_by_user_id: 'admin10',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin10'))
      expect(result.ok).toBe(true)

      // Both the id=X row (the actual one in DB) and the id=Y delete target
      // must result in zero pending rows for (workspace_id, email).
      const pending = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.workspaceId, sharedId))
      expect(pending).toHaveLength(0)
    })

    it('preserves an existing membership role on promote-on-insert (no downgrade)', async () => {
      await insertUser('admin9', 'admin9@test.com')
      await insertUser('coadmin', 'coadmin@test.com')
      await bootstrapPersonalViaUpload('admin9')
      const sharedId = await seedSharedAsAdmin('admin9')

      // Make coadmin an admin of the same workspace directly.
      await db.insert(workspaceMembershipsTable).values({
        id: uuidv7(),
        workspaceId: sharedId,
        userId: 'coadmin',
        role: 'admin',
        userName: 'Test User',
        userEmail: 'coadmin@test.com',
      })

      // Invite coadmin's email with role='member' — should NOT downgrade.
      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'coadmin@test.com',
          role: 'member',
          invited_by_user_id: 'admin9',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin9'))
      expect(result.ok).toBe(true)

      const memberships = await db
        .select()
        .from(workspaceMembershipsTable)
        .where(eq(workspaceMembershipsTable.workspaceId, sharedId))
      const coadminRow = memberships.find((m) => m.userId === 'coadmin')
      expect(coadminRow?.role).toBe('admin')
    })

    it('rejects malformed email on pending PUT with INVALID_EMAIL', async () => {
      await insertUser('admin-email', 'admin-email@test.com')
      await bootstrapPersonalViaUpload('admin-email')
      const sharedId = await seedSharedAsAdmin('admin-email')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: { workspace_id: sharedId, email: 'not-an-email', role: 'member' },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('admin-email'))
      expectPermanentReject(result, 'INVALID_EMAIL')
    })

    it('overrides client-supplied invited_by_user_id with ctx.userId', async () => {
      await insertUser('inviter', 'inviter@test.com')
      await bootstrapPersonalViaUpload('inviter')
      const sharedId = await seedSharedAsAdmin('inviter')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'pending@test.com',
          role: 'member',
          // Attempt to attribute the invite to someone else.
          invited_by_user_id: 'someone-else',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('inviter'))
      expect(result.ok).toBe(true)

      const stored = await db
        .select()
        .from(workspacePendingMembershipsTable)
        .where(eq(workspacePendingMembershipsTable.id, op.id))
      expect(stored[0]?.invitedByUserId).toBe('inviter')
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

    it('rejects a pending PUT when e2eeEnabled is true (THU-593)', async () => {
      await insertUser('admin-e2', 'admin-e2@test.com')
      const sharedId = await seedSharedAsAdmin('admin-e2')

      const op: UploadOp = {
        op: 'PUT',
        type: 'workspace_pending_memberships',
        id: uuidv7(),
        data: {
          workspace_id: sharedId,
          email: 'invitee@test.com',
          role: 'member',
          invited_by_user_id: 'admin-e2',
        },
      }
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('admin-e2', { settings: createTestSettings({ e2eeEnabled: true }) }),
      )
      expectPermanentReject(result, 'E2EE_MEMBERSHIPS_DISABLED')
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

      const ownerMismatch: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: personalId,
        data: { is_personal: true, owner_user_id: 'somebody-else', name: 'Sneaky' },
      }
      const wrongIdPersonal: UploadOp = {
        op: 'PUT',
        type: 'workspaces',
        id: uuidv7(),
        data: { is_personal: true, owner_user_id: 'owner7', name: 'Sneaky' },
      }
      const result = await applyUploadBatch(
        db,
        [ownerMismatch, wrongIdPersonal],
        ctxFor('owner7', {
          settings: createTestSettings({ allowWorkspaceCreationByMembers: true }),
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(2)
        expect(result.rejected[0].code).toBe('PERSONAL_WORKSPACE_OWNER_MISMATCH')
        expect(result.rejected[1].code).toBe('PERSONAL_WORKSPACE_ID_NOT_CANONICAL')
      }
    })
  })

  describe('agents — workspace permission gating (add_agents / remove_agents)', () => {
    /**
     * Sets up a shared workspace with `adminId` as admin and `memberId` as member.
     * Both users must have already been inserted via `insertUser`. Returns the
     * workspace id so the test can target it.
     */
    const seedSharedWithAdminAndMember = async (adminId: string, memberId: string): Promise<string> => {
      const workspaceId = uuidv7()
      await db.insert(workspacesTable).values({ id: workspaceId, isPersonal: false, name: 'Acme' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: adminId, role: 'admin' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: memberId, role: 'member' })
      return workspaceId
    }

    const setRequiredRole = async (
      workspaceId: string,
      key: 'add_agents' | 'remove_agents',
      requiredRole: 'admin' | 'member',
    ): Promise<void> => {
      await db.insert(workspacePermissionsTable).values({ id: uuidv7(), workspaceId, permissionKey: key, requiredRole })
    }

    const agentPut = (workspaceId: string, id = uuidv7()): UploadOp => ({
      op: 'PUT',
      type: 'agents',
      id,
      data: {
        workspace_id: workspaceId,
        name: 'Test agent',
        type: 'remote-acp',
        transport: 'websocket',
        url: 'wss://example.invalid/acp',
      },
    })

    it('PUT agent: admin always succeeds (default required_role = admin)', async () => {
      await insertUser('agAdmin1', 'agadmin1@test.com')
      await insertUser('agMember1', 'agmember1@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin1', 'agMember1')

      const op = agentPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('agAdmin1'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, op.id))
      expect(stored).toHaveLength(1)
    })

    it('PUT agent: member rejected when add_agents required_role = admin (default)', async () => {
      await insertUser('agAdmin2', 'agadmin2@test.com')
      await insertUser('agMember2', 'agmember2@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin2', 'agMember2')

      const op = agentPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('agMember2'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, op.id))
      expect(stored).toHaveLength(0)
    })

    it('PUT agent: member allowed when add_agents required_role = member', async () => {
      await insertUser('agAdmin3', 'agadmin3@test.com')
      await insertUser('agMember3', 'agmember3@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin3', 'agMember3')
      await setRequiredRole(workspaceId, 'add_agents', 'member')

      const op = agentPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('agMember3'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, op.id))
      expect(stored).toHaveLength(1)
    })

    it('DELETE agent: member rejected when remove_agents required_role = admin (default)', async () => {
      await insertUser('agAdmin4', 'agadmin4@test.com')
      await insertUser('agMember4', 'agmember4@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin4', 'agMember4')
      // Admin seeds the agent so the row exists.
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin4'))
      expect(putResult.ok).toBe(true)

      const deleteOp: UploadOp = { op: 'DELETE', type: 'agents', id: putOp.id }
      const result = await applyUploadBatch(db, [deleteOp], ctxFor('agMember4'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, putOp.id))
      expect(stored).toHaveLength(1)
    })

    it('DELETE agent: member allowed when remove_agents required_role = member', async () => {
      await insertUser('agAdmin5', 'agadmin5@test.com')
      await insertUser('agMember5', 'agmember5@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin5', 'agMember5')
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin5'))
      expect(putResult.ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_agents', 'member')

      const deleteOp: UploadOp = { op: 'DELETE', type: 'agents', id: putOp.id }
      const result = await applyUploadBatch(db, [deleteOp], ctxFor('agMember5'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, putOp.id))
      expect(stored).toHaveLength(0)
    })

    it('add_agents = member does not unlock DELETE (remove_agents still defaults to admin)', async () => {
      await insertUser('agAdmin6', 'agadmin6@test.com')
      await insertUser('agMember6', 'agmember6@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin6', 'agMember6')
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin6'))
      expect(putResult.ok).toBe(true)
      // Member can add but the remove permission is still admin.
      await setRequiredRole(workspaceId, 'add_agents', 'member')

      const deleteOp: UploadOp = { op: 'DELETE', type: 'agents', id: putOp.id }
      const result = await applyUploadBatch(db, [deleteOp], ctxFor('agMember6'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    // FE DAL soft-deletes via PATCH(deleted_at = now), not DELETE. The handler
    // classifies that PATCH as a remove and gates it on `remove_agents`.
    it('soft-delete via PATCH(deleted_at) gates on remove_agents, not add_agents', async () => {
      await insertUser('agAdmin7', 'agadmin7@test.com')
      await insertUser('agMember7', 'agmember7@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin7', 'agMember7')
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin7'))
      expect(putResult.ok).toBe(true)
      // Member can edit (add) but not soft-delete (remove).
      await setRequiredRole(workspaceId, 'add_agents', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'agents',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('agMember7'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('soft-delete via PATCH(deleted_at) is allowed when remove_agents = member', async () => {
      await insertUser('agAdmin8', 'agadmin8@test.com')
      await insertUser('agMember8', 'agmember8@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin8', 'agMember8')
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin8'))
      expect(putResult.ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_agents', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'agents',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('agMember8'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, putOp.id))
      expect(stored[0].deletedAt).not.toBeNull()
    })

    // Edit PATCH (no deleted_at) still gates on add_agents, not remove_agents.
    it('non-delete PATCH gates on add_agents even when remove_agents = member', async () => {
      await insertUser('agAdmin9', 'agadmin9@test.com')
      await insertUser('agMember9', 'agmember9@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('agAdmin9', 'agMember9')
      const putOp = agentPut(workspaceId)
      const putResult = await applyUploadBatch(db, [putOp], ctxFor('agAdmin9'))
      expect(putResult.ok).toBe(true)
      // Member has remove but not add; an edit (no deleted_at) should still reject.
      await setRequiredRole(workspaceId, 'remove_agents', 'member')

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'agents',
        id: putOp.id,
        data: { name: 'Renamed by member' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('agMember9'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })
  })

  describe('skills — workspace permission gating (add_skills / remove_skills)', () => {
    const seedSharedWithAdminAndMember = async (adminId: string, memberId: string): Promise<string> => {
      const workspaceId = uuidv7()
      await db.insert(workspacesTable).values({ id: workspaceId, isPersonal: false, name: 'Acme' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: adminId, role: 'admin' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: memberId, role: 'member' })
      return workspaceId
    }

    const setRequiredRole = async (
      workspaceId: string,
      key: 'add_skills' | 'remove_skills',
      requiredRole: 'admin' | 'member',
    ): Promise<void> => {
      await db.insert(workspacePermissionsTable).values({ id: uuidv7(), workspaceId, permissionKey: key, requiredRole })
    }

    const skillPut = (workspaceId: string, id = uuidv7()): UploadOp => ({
      op: 'PUT',
      type: 'skills',
      id,
      data: {
        workspace_id: workspaceId,
        name: 'Test skill',
        description: 'Test',
        instruction: 'Do the thing',
        enabled: 1,
      },
    })

    it('PUT skill: member rejected when add_skills required_role = admin (default)', async () => {
      await insertUser('skAdmin1', 'skadmin1@test.com')
      await insertUser('skMember1', 'skmember1@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('skAdmin1', 'skMember1')

      const op = skillPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('skMember1'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('PUT skill: member allowed when add_skills required_role = member', async () => {
      await insertUser('skAdmin2', 'skadmin2@test.com')
      await insertUser('skMember2', 'skmember2@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('skAdmin2', 'skMember2')
      await setRequiredRole(workspaceId, 'add_skills', 'member')

      const op = skillPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('skMember2'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, op.id))
      expect(stored).toHaveLength(1)
    })

    it('soft-delete via PATCH(deleted_at) gates on remove_skills, not add_skills', async () => {
      await insertUser('skAdmin3', 'skadmin3@test.com')
      await insertUser('skMember3', 'skmember3@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('skAdmin3', 'skMember3')
      const putOp = skillPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('skAdmin3'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'add_skills', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('skMember3'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('soft-delete via PATCH(deleted_at) is allowed when remove_skills = member', async () => {
      await insertUser('skAdmin4', 'skadmin4@test.com')
      await insertUser('skMember4', 'skmember4@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('skAdmin4', 'skMember4')
      const putOp = skillPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('skAdmin4'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_skills', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('skMember4'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].deletedAt).not.toBeNull()
    })

    it('edit PATCH (no deleted_at) gates on add_skills, not remove_skills', async () => {
      await insertUser('skAdmin5', 'skadmin5@test.com')
      await insertUser('skMember5', 'skmember5@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('skAdmin5', 'skMember5')
      const putOp = skillPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('skAdmin5'))).ok).toBe(true)
      // Member has remove but not add — toggling `enabled` is an edit and must reject.
      await setRequiredRole(workspaceId, 'remove_skills', 'member')

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { enabled: 0 },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('skMember5'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })
  })

  describe('models — workspace permission gating (add_models / remove_models)', () => {
    const seedSharedWithAdminAndMember = async (adminId: string, memberId: string): Promise<string> => {
      const workspaceId = uuidv7()
      await db.insert(workspacesTable).values({ id: workspaceId, isPersonal: false, name: 'Acme' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: adminId, role: 'admin' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: memberId, role: 'member' })
      return workspaceId
    }

    const setRequiredRole = async (
      workspaceId: string,
      key: 'add_models' | 'remove_models',
      requiredRole: 'admin' | 'member',
    ): Promise<void> => {
      await db.insert(workspacePermissionsTable).values({ id: uuidv7(), workspaceId, permissionKey: key, requiredRole })
    }

    const modelPut = (workspaceId: string, id = uuidv7()): UploadOp => ({
      op: 'PUT',
      type: 'models',
      id,
      data: {
        workspace_id: workspaceId,
        provider: 'openai',
        name: 'Test model',
        model: 'gpt-test',
        enabled: 1,
      },
    })

    it('PUT model: member rejected when add_models required_role = admin (default)', async () => {
      await insertUser('mdAdmin1', 'mdadmin1@test.com')
      await insertUser('mdMember1', 'mdmember1@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mdAdmin1', 'mdMember1')

      const op = modelPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('mdMember1'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('PUT model: member allowed when add_models required_role = member', async () => {
      await insertUser('mdAdmin2', 'mdadmin2@test.com')
      await insertUser('mdMember2', 'mdmember2@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mdAdmin2', 'mdMember2')
      await setRequiredRole(workspaceId, 'add_models', 'member')

      const op = modelPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('mdMember2'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(modelsTable).where(eq(modelsTable.id, op.id))
      expect(stored).toHaveLength(1)
    })

    it('soft-delete via PATCH(deleted_at) gates on remove_models, not add_models', async () => {
      await insertUser('mdAdmin3', 'mdadmin3@test.com')
      await insertUser('mdMember3', 'mdmember3@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mdAdmin3', 'mdMember3')
      const putOp = modelPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mdAdmin3'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'add_models', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'models',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('mdMember3'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('soft-delete via PATCH(deleted_at) is allowed when remove_models = member', async () => {
      await insertUser('mdAdmin4', 'mdadmin4@test.com')
      await insertUser('mdMember4', 'mdmember4@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mdAdmin4', 'mdMember4')
      const putOp = modelPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mdAdmin4'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_models', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'models',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('mdMember4'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(modelsTable).where(eq(modelsTable.id, putOp.id))
      expect(stored[0].deletedAt).not.toBeNull()
    })

    it('edit PATCH (toggle enabled) gates on add_models, not remove_models', async () => {
      await insertUser('mdAdmin5', 'mdadmin5@test.com')
      await insertUser('mdMember5', 'mdmember5@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mdAdmin5', 'mdMember5')
      const putOp = modelPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mdAdmin5'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_models', 'member')

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'models',
        id: putOp.id,
        data: { enabled: 0 },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('mdMember5'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })
  })

  describe('mcp_servers — workspace permission gating (add_mcp_servers / remove_mcp_servers)', () => {
    const seedSharedWithAdminAndMember = async (adminId: string, memberId: string): Promise<string> => {
      const workspaceId = uuidv7()
      await db.insert(workspacesTable).values({ id: workspaceId, isPersonal: false, name: 'Acme' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: adminId, role: 'admin' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: memberId, role: 'member' })
      return workspaceId
    }

    const setRequiredRole = async (
      workspaceId: string,
      key: 'add_mcp_servers' | 'remove_mcp_servers',
      requiredRole: 'admin' | 'member',
    ): Promise<void> => {
      await db.insert(workspacePermissionsTable).values({ id: uuidv7(), workspaceId, permissionKey: key, requiredRole })
    }

    const mcpPut = (workspaceId: string, id = uuidv7()): UploadOp => ({
      op: 'PUT',
      type: 'mcp_servers',
      id,
      data: {
        workspace_id: workspaceId,
        name: 'Test MCP',
        type: 'http',
        url: 'https://example.invalid/mcp',
        enabled: 1,
      },
    })

    it('PUT mcp_server: member rejected when add_mcp_servers required_role = admin (default)', async () => {
      await insertUser('mcpAdmin1', 'mcpadmin1@test.com')
      await insertUser('mcpMember1', 'mcpmember1@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mcpAdmin1', 'mcpMember1')

      const op = mcpPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('mcpMember1'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('PUT mcp_server: member allowed when add_mcp_servers required_role = member', async () => {
      await insertUser('mcpAdmin2', 'mcpadmin2@test.com')
      await insertUser('mcpMember2', 'mcpmember2@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mcpAdmin2', 'mcpMember2')
      await setRequiredRole(workspaceId, 'add_mcp_servers', 'member')

      const op = mcpPut(workspaceId)
      const result = await applyUploadBatch(db, [op], ctxFor('mcpMember2'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, op.id))
      expect(stored).toHaveLength(1)
    })

    it('soft-delete via PATCH(deleted_at) gates on remove_mcp_servers, not add_mcp_servers', async () => {
      await insertUser('mcpAdmin3', 'mcpadmin3@test.com')
      await insertUser('mcpMember3', 'mcpmember3@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mcpAdmin3', 'mcpMember3')
      const putOp = mcpPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mcpAdmin3'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'add_mcp_servers', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'mcp_servers',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('mcpMember3'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })

    it('soft-delete via PATCH(deleted_at) is allowed when remove_mcp_servers = member', async () => {
      await insertUser('mcpAdmin4', 'mcpadmin4@test.com')
      await insertUser('mcpMember4', 'mcpmember4@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mcpAdmin4', 'mcpMember4')
      const putOp = mcpPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mcpAdmin4'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_mcp_servers', 'member')

      const softDeleteOp: UploadOp = {
        op: 'PATCH',
        type: 'mcp_servers',
        id: putOp.id,
        data: { deleted_at: new Date().toISOString() },
      }
      const result = await applyUploadBatch(db, [softDeleteOp], ctxFor('mcpMember4'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, putOp.id))
      expect(stored[0].deletedAt).not.toBeNull()
    })

    it('edit PATCH (toggle enabled) gates on add_mcp_servers, not remove_mcp_servers', async () => {
      await insertUser('mcpAdmin5', 'mcpadmin5@test.com')
      await insertUser('mcpMember5', 'mcpmember5@test.com')
      const workspaceId = await seedSharedWithAdminAndMember('mcpAdmin5', 'mcpMember5')
      const putOp = mcpPut(workspaceId)
      expect((await applyUploadBatch(db, [putOp], ctxFor('mcpAdmin5'))).ok).toBe(true)
      await setRequiredRole(workspaceId, 'remove_mcp_servers', 'member')

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'mcp_servers',
        id: putOp.id,
        data: { enabled: 0 },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('mcpMember5'))
      expectPermanentReject(result, 'INSUFFICIENT_PERMISSION')
    })
  })

  describe('scope-aware resources (THU-603)', () => {
    const seedShared = async (adminId: string, memberId: string): Promise<string> => {
      const workspaceId = uuidv7()
      await db.insert(workspacesTable).values({ id: workspaceId, isPersonal: false, name: 'Acme' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: adminId, role: 'admin' })
      await db.insert(workspaceMembershipsTable).values({ id: uuidv7(), workspaceId, userId: memberId, role: 'member' })
      return workspaceId
    }

    const skillPut = (workspaceId: string, scope: 'workspace' | 'user' | undefined, id = uuidv7()): UploadOp => ({
      op: 'PUT',
      type: 'skills',
      id,
      data: {
        workspace_id: workspaceId,
        name: 'Test skill',
        description: 'Test',
        instruction: 'Do the thing',
        enabled: 1,
        ...(scope !== undefined ? { scope } : {}),
      },
    })

    it('PUT defaults scope to workspace when payload omits it', async () => {
      await insertUser('scOwner1', 'scowner1@test.com')
      await insertUser('scOther1', 'scother1@test.com')
      const workspaceId = await seedShared('scOwner1', 'scOther1')

      const op = skillPut(workspaceId, undefined)
      const result = await applyUploadBatch(db, [op], ctxFor('scOwner1'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, op.id))
      expect(stored[0].scope).toBe('workspace')
    })

    it('PUT accepts scope=user from the row owner', async () => {
      await insertUser('scOwner2', 'scowner2@test.com')
      await insertUser('scOther2', 'scother2@test.com')
      const workspaceId = await seedShared('scOwner2', 'scOther2')

      const op = skillPut(workspaceId, 'user')
      const result = await applyUploadBatch(db, [op], ctxFor('scOwner2'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, op.id))
      expect(stored[0].scope).toBe('user')
      expect(stored[0].userId).toBe('scOwner2')
    })

    it('PUT scope=user is rejected when allowUserScopedResources is false', async () => {
      await insertUser('scOwner3', 'scowner3@test.com')
      await insertUser('scOther3', 'scother3@test.com')
      const workspaceId = await seedShared('scOwner3', 'scOther3')

      const op = skillPut(workspaceId, 'user')
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('scOwner3', { settings: createTestSettings({ allowUserScopedResources: false }) }),
      )
      expectPermanentReject(result, 'USER_SCOPE_DISABLED')
    })

    it('PUT scope=workspace is allowed even when allowUserScopedResources is false', async () => {
      await insertUser('scOwner4', 'scowner4@test.com')
      await insertUser('scOther4', 'scother4@test.com')
      const workspaceId = await seedShared('scOwner4', 'scOther4')

      const op = skillPut(workspaceId, 'workspace')
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('scOwner4', { settings: createTestSettings({ allowUserScopedResources: false }) }),
      )
      expect(result.ok).toBe(true)
    })

    it('PATCH on a scope=user row by a non-owner is rejected with NOT_ROW_OWNER', async () => {
      await insertUser('scOwner5', 'scowner5@test.com')
      await insertUser('scOther5', 'scother5@test.com')
      const workspaceId = await seedShared('scOwner5', 'scOther5')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwner5'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { description: 'Stolen' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOther5'))
      expectPermanentReject(result, 'NOT_ROW_OWNER')
    })

    it('DELETE on a scope=user row by a non-owner is rejected with NOT_ROW_OWNER', async () => {
      await insertUser('scOwner6', 'scowner6@test.com')
      await insertUser('scOther6', 'scother6@test.com')
      const workspaceId = await seedShared('scOwner6', 'scOther6')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwner6'))).ok).toBe(true)

      const deleteOp: UploadOp = { op: 'DELETE', type: 'skills', id: putOp.id }
      const result = await applyUploadBatch(db, [deleteOp], ctxFor('scOther6'))
      expectPermanentReject(result, 'NOT_ROW_OWNER')
    })

    it('PATCH on a scope=user row by the owner is allowed', async () => {
      await insertUser('scOwner7', 'scowner7@test.com')
      await insertUser('scOther7', 'scother7@test.com')
      const workspaceId = await seedShared('scOwner7', 'scOther7')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwner7'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { description: 'Updated by owner' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOwner7'))
      expect(result.ok).toBe(true)
    })

    it("PATCH lets the row owner flip scope from 'workspace' to 'user'", async () => {
      await insertUser('scOwner8', 'scowner8@test.com')
      await insertUser('scOther8', 'scother8@test.com')
      const workspaceId = await seedShared('scOwner8', 'scOther8')
      const putOp = skillPut(workspaceId, 'workspace')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwner8'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { scope: 'user', description: 'now private' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOwner8'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('user')
      expect(stored[0].description).toBe('now private')
    })

    it("PATCH lets the row owner flip scope from 'user' to 'workspace'", async () => {
      await insertUser('scOwnerB', 'scownerB@test.com')
      await insertUser('scOtherB', 'scotherB@test.com')
      const workspaceId = await seedShared('scOwnerB', 'scOtherB')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwnerB'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { scope: 'workspace' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOwnerB'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('workspace')
    })

    it('PATCH scope by a non-owner is silently dropped (other fields still apply)', async () => {
      await insertUser('scOwnerC', 'scownerC@test.com')
      await insertUser('scOtherC', 'scotherC@test.com')
      const workspaceId = await seedShared('scOwnerC', 'scOtherC')
      // Grant the non-owner add_skills so PATCH reaches the apply path; without
      // it the op would be rejected on permission grounds and we'd never see
      // the silent-drop behaviour.
      await db
        .insert(workspacePermissionsTable)
        .values({ id: uuidv7(), workspaceId, permissionKey: 'add_skills', requiredRole: 'member' })
      const putOp = skillPut(workspaceId, 'workspace')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwnerC'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { scope: 'user', description: 'snuck through' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOtherC'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('workspace')
      expect(stored[0].description).toBe('snuck through')
    })

    it('PATCH rejects an obviously-malformed scope value with INVALID_SCOPE', async () => {
      await insertUser('scOwnerD', 'scownerD@test.com')
      await insertUser('scOtherD', 'scotherD@test.com')
      const workspaceId = await seedShared('scOwnerD', 'scOtherD')
      const putOp = skillPut(workspaceId, 'workspace')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwnerD'))).ok).toBe(true)

      const editOp: UploadOp = {
        op: 'PATCH',
        type: 'skills',
        id: putOp.id,
        data: { scope: 'global' },
      }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scOwnerD'))
      expectPermanentReject(result, 'INVALID_SCOPE')
    })

    it('PUT upsert by the owner preserves existing scope (cannot promote/demote)', async () => {
      await insertUser('scOwner9', 'scowner9@test.com')
      await insertUser('scOther9', 'scother9@test.com')
      const workspaceId = await seedShared('scOwner9', 'scOther9')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwner9'))).ok).toBe(true)

      const upsert: UploadOp = {
        op: 'PUT',
        type: 'skills',
        id: putOp.id,
        data: {
          workspace_id: workspaceId,
          scope: 'workspace',
          name: 'Renamed',
          description: 'Test',
          instruction: 'Do the thing',
          enabled: 1,
        },
      }
      const result = await applyUploadBatch(db, [upsert], ctxFor('scOwner9'))
      expect(result.ok).toBe(true)
      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('user')
      expect(stored[0].name).toBe('Renamed')
    })

    it('PUT upsert against an existing scope=user row by a non-owner is rejected', async () => {
      await insertUser('scOwnerA', 'scownerA@test.com')
      await insertUser('scOtherA', 'scotherA@test.com')
      const workspaceId = await seedShared('scOwnerA', 'scOtherA')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scOwnerA'))).ok).toBe(true)

      const upsert: UploadOp = {
        op: 'PUT',
        type: 'skills',
        id: putOp.id,
        data: {
          workspace_id: workspaceId,
          scope: 'workspace',
          name: 'Hijacked',
          description: 'Test',
          instruction: 'Do the thing',
          enabled: 1,
        },
      }
      const result = await applyUploadBatch(db, [upsert], ctxFor('scOtherA'))
      expectPermanentReject(result, 'NOT_ROW_OWNER')
    })

    it('PUT scope=user on agents is rejected when settings flag is off', async () => {
      await insertUser('scAgentOwner', 'scagentowner@test.com')
      await insertUser('scAgentOther', 'scagentother@test.com')
      const workspaceId = await seedShared('scAgentOwner', 'scAgentOther')

      const op: UploadOp = {
        op: 'PUT',
        type: 'agents',
        id: uuidv7(),
        data: {
          workspace_id: workspaceId,
          name: 'My private agent',
          type: 'remote-acp',
          transport: 'websocket',
          url: 'wss://example.com/agent',
          enabled: 1,
          scope: 'user',
        },
      }
      const result = await applyUploadBatch(
        db,
        [op],
        ctxFor('scAgentOwner', { settings: createTestSettings({ allowUserScopedResources: false }) }),
      )
      expectPermanentReject(result, 'USER_SCOPE_DISABLED')
    })

    it('scope=user agents accept PATCH/DELETE only from the owner', async () => {
      await insertUser('scAgentOwner2', 'scagentowner2@test.com')
      await insertUser('scAgentOther2', 'scagentother2@test.com')
      const workspaceId = await seedShared('scAgentOwner2', 'scAgentOther2')
      const agentId = uuidv7()

      const putOp: UploadOp = {
        op: 'PUT',
        type: 'agents',
        id: agentId,
        data: {
          workspace_id: workspaceId,
          name: 'Private',
          type: 'remote-acp',
          transport: 'websocket',
          url: 'wss://example.com/a',
          enabled: 1,
          scope: 'user',
        },
      }
      expect((await applyUploadBatch(db, [putOp], ctxFor('scAgentOwner2'))).ok).toBe(true)

      const editByOther: UploadOp = { op: 'PATCH', type: 'agents', id: agentId, data: { name: 'Stolen' } }
      expectPermanentReject(await applyUploadBatch(db, [editByOther], ctxFor('scAgentOther2')), 'NOT_ROW_OWNER')

      const stored = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId))
      expect(stored[0].name).toBe('Private')
    })

    it('PUT with a malformed scope is rejected with INVALID_SCOPE', async () => {
      await insertUser('scInvalid1', 'scinvalid1@test.com')
      await insertUser('scInvalid1Member', 'scinvalid1m@test.com')
      const workspaceId = await seedShared('scInvalid1', 'scInvalid1Member')

      // `skillPut` only emits valid scopes — hand-roll the op with a bogus value.
      const op: UploadOp = {
        op: 'PUT',
        type: 'skills',
        id: uuidv7(),
        data: {
          workspace_id: workspaceId,
          name: 'Bogus',
          description: 'Bogus',
          instruction: 'Do the thing',
          enabled: 1,
          scope: 'totally-not-a-real-scope',
        },
      }
      const result = await applyUploadBatch(db, [op], ctxFor('scInvalid1'))
      expectPermanentReject(result, 'INVALID_SCOPE')
    })

    it('PATCH flipping scope to user is rejected when allowUserScopedResources is false', async () => {
      await insertUser('scFlip1', 'scflip1@test.com')
      await insertUser('scFlip1Member', 'scflip1m@test.com')
      const workspaceId = await seedShared('scFlip1', 'scFlip1Member')
      // Seed a workspace-scoped row with the flag on so the create itself isn't blocked.
      const putOp = skillPut(workspaceId, 'workspace')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scFlip1'))).ok).toBe(true)

      const flipOp: UploadOp = { op: 'PATCH', type: 'skills', id: putOp.id, data: { scope: 'user' } }
      const result = await applyUploadBatch(
        db,
        [flipOp],
        ctxFor('scFlip1', { settings: createTestSettings({ allowUserScopedResources: false }) }),
      )
      expectPermanentReject(result, 'USER_SCOPE_DISABLED')

      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('workspace')
    })

    it('PATCH flipping scope back to workspace is allowed even when allowUserScopedResources is false', async () => {
      await insertUser('scFlip2', 'scflip2@test.com')
      await insertUser('scFlip2Member', 'scflip2m@test.com')
      const workspaceId = await seedShared('scFlip2', 'scFlip2Member')
      const putOp = skillPut(workspaceId, 'user')
      expect((await applyUploadBatch(db, [putOp], ctxFor('scFlip2'))).ok).toBe(true)

      // The flag is a kill switch for *new* user-scoping. Unwinding an existing
      // user-scoped row back to workspace stays allowed so deployments that
      // toggle the flag off don't strand rows in the private bucket.
      const flipOp: UploadOp = { op: 'PATCH', type: 'skills', id: putOp.id, data: { scope: 'workspace' } }
      const result = await applyUploadBatch(
        db,
        [flipOp],
        ctxFor('scFlip2', { settings: createTestSettings({ allowUserScopedResources: false }) }),
      )
      expect(result.ok).toBe(true)

      const stored = await db.select().from(skillsTable).where(eq(skillsTable.id, putOp.id))
      expect(stored[0].scope).toBe('workspace')
    })

    it('PATCH on a workspace-scoped row by a co-member updates non-scope fields', async () => {
      // Uses `modes` rather than `skills` because skills carries an
      // `add_skills` permission gate (defaults to admin-only) — we want to
      // exercise the post-fix `fetchRowScope({ userId })` resolution under a
      // co-member PATCH, not the permission denial path that comes before it.
      await insertUser('scShare1', 'scshare1@test.com')
      await insertUser('scShare1Co', 'scshare1co@test.com')
      const workspaceId = await seedShared('scShare1', 'scShare1Co')
      const modeId = uuidv7()
      const putOp: UploadOp = {
        op: 'PUT',
        type: 'modes',
        id: modeId,
        data: { workspace_id: workspaceId, name: 'chat', label: 'Chat', scope: 'workspace' },
      }
      expect((await applyUploadBatch(db, [putOp], ctxFor('scShare1'))).ok).toBe(true)

      const editOp: UploadOp = { op: 'PATCH', type: 'modes', id: modeId, data: { label: 'Co-member edit' } }
      const result = await applyUploadBatch(db, [editOp], ctxFor('scShare1Co'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.rejected).toHaveLength(0)
      }

      const stored = await db.select().from(modesTable).where(eq(modesTable.id, modeId))
      expect(stored[0].label).toBe('Co-member edit')
      // Authorship is preserved on a co-member edit — the row's `user_id`
      // stays as the original author, not the patcher.
      expect(stored[0].userId).toBe('scShare1')
    })
  })

  describe('default-data id collisions across personal workspaces', () => {
    // `defaults/tasks` (and other default tables) ship with fixed UUIDs that
    // `reconcileDefaults` re-inserts into every user's personal workspace. The
    // composite PK `(id, workspace_id)` permits the row to repeat per workspace
    // — fetchRowScope must honor that, or the second user to sync sees their
    // PUT mis-routed to the first user's row (NOT_ROW_OWNER / NOT_WORKSPACE_MEMBER).
    const sharedTaskId = '0198ecc5-cc2b-735b-b478-93f8db7202ce'

    it('accepts the same task id from two users (one per personal workspace)', async () => {
      await insertUser('collideA', 'a@test.com')
      await insertUser('collideB', 'b@test.com')
      const wsA = await bootstrapPersonalViaUpload('collideA')
      const wsB = await bootstrapPersonalViaUpload('collideB')

      const putFor = (workspaceId: string): UploadOp => ({
        op: 'PUT',
        type: 'tasks',
        id: sharedTaskId,
        data: { workspace_id: workspaceId, item: 'Connect your email', order: 100, is_complete: 0 },
      })

      expect((await applyUploadBatch(db, [putFor(wsA)], ctxFor('collideA'))).ok).toBe(true)
      expect((await applyUploadBatch(db, [putFor(wsB)], ctxFor('collideB'))).ok).toBe(true)

      const rows = await db.select().from(tasksTable).where(eq(tasksTable.id, sharedTaskId))
      expect(rows).toHaveLength(2)
      const byWorkspace = Object.fromEntries(rows.map((r) => [r.workspaceId, r.userId]))
      expect(byWorkspace[wsA]).toBe('collideA')
      expect(byWorkspace[wsB]).toBe('collideB')
    })

    it('PATCH on a shared-id task resolves to the caller-owned row', async () => {
      await insertUser('patchA', 'pa@test.com')
      await insertUser('patchB', 'pb@test.com')
      const wsA = await bootstrapPersonalViaUpload('patchA')
      const wsB = await bootstrapPersonalViaUpload('patchB')

      await applyUploadBatch(
        db,
        [
          {
            op: 'PUT',
            type: 'tasks',
            id: sharedTaskId,
            data: { workspace_id: wsA, item: 'A original', order: 100, is_complete: 0 },
          },
        ],
        ctxFor('patchA'),
      )
      await applyUploadBatch(
        db,
        [
          {
            op: 'PUT',
            type: 'tasks',
            id: sharedTaskId,
            data: { workspace_id: wsB, item: 'B original', order: 100, is_complete: 0 },
          },
        ],
        ctxFor('patchB'),
      )

      // Patch from B should land on B's row, not A's. With the pre-fix bare-id
      // lookup, validate() would resolve to A's row and reject as NOT_ROW_OWNER.
      const patchResult = await applyUploadBatch(
        db,
        [{ op: 'PATCH', type: 'tasks', id: sharedTaskId, data: { item: 'B edited' } }],
        ctxFor('patchB'),
      )
      expect(patchResult.ok).toBe(true)
      if (patchResult.ok) {
        expect(patchResult.rejected).toHaveLength(0)
      }

      const aRow = (await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, wsA)))[0]
      const bRow = (await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, wsB)))[0]
      expect(aRow.item).toBe('A original')
      expect(bRow.item).toBe('B edited')
    })

    // Same collision shape on a non-userPrivate, scopeAware table. PUT didn't
    // fail loud pre-fix (the NOT_ROW_OWNER branch only fires for userPrivate or
    // scope='user' rows), but PATCH/DELETE on a personal-workspace default
    // would resolve to the other user's row and reject as NOT_WORKSPACE_MEMBER.
    const sharedModelId = 'd045a4c0-3f93-4f30-a608-24e07856e11d'

    it('accepts the same model id from two users (one per personal workspace)', async () => {
      await insertUser('mdlA', 'mdla@test.com')
      await insertUser('mdlB', 'mdlb@test.com')
      const wsA = await bootstrapPersonalViaUpload('mdlA')
      const wsB = await bootstrapPersonalViaUpload('mdlB')

      const putFor = (workspaceId: string): UploadOp => ({
        op: 'PUT',
        type: 'models',
        id: sharedModelId,
        data: {
          workspace_id: workspaceId,
          provider: 'openai',
          name: 'Default model',
          model: 'gpt-test',
          enabled: 1,
          scope: 'workspace',
        },
      })

      expect((await applyUploadBatch(db, [putFor(wsA)], ctxFor('mdlA'))).ok).toBe(true)
      expect((await applyUploadBatch(db, [putFor(wsB)], ctxFor('mdlB'))).ok).toBe(true)

      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, sharedModelId))
      expect(rows).toHaveLength(2)
      const byWorkspace = Object.fromEntries(rows.map((r) => [r.workspaceId, r.userId]))
      expect(byWorkspace[wsA]).toBe('mdlA')
      expect(byWorkspace[wsB]).toBe('mdlB')
    })

    it('PATCH on a shared-id model resolves to the caller-owned row', async () => {
      await insertUser('mdlPA', 'mdlpa@test.com')
      await insertUser('mdlPB', 'mdlpb@test.com')
      const wsA = await bootstrapPersonalViaUpload('mdlPA')
      const wsB = await bootstrapPersonalViaUpload('mdlPB')

      const seed = (workspaceId: string, name: string): UploadOp => ({
        op: 'PUT',
        type: 'models',
        id: sharedModelId,
        data: {
          workspace_id: workspaceId,
          provider: 'openai',
          name,
          model: 'gpt-test',
          enabled: 1,
          scope: 'workspace',
        },
      })
      await applyUploadBatch(db, [seed(wsA, 'A original')], ctxFor('mdlPA'))
      await applyUploadBatch(db, [seed(wsB, 'B original')], ctxFor('mdlPB'))

      const patchResult = await applyUploadBatch(
        db,
        [{ op: 'PATCH', type: 'models', id: sharedModelId, data: { name: 'B edited' } }],
        ctxFor('mdlPB'),
      )
      expect(patchResult.ok).toBe(true)
      if (patchResult.ok) {
        expect(patchResult.rejected).toHaveLength(0)
      }

      const aRow = (await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, wsA)))[0]
      const bRow = (await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, wsB)))[0]
      expect(aRow.name).toBe('A original')
      expect(bRow.name).toBe('B edited')
    })
  })
})
