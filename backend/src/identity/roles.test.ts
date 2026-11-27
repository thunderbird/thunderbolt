/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import {
  groupRoleMapping,
  identityConnection,
  localGroup,
  localGroupMember,
  memberRoleGrant,
  membershipSource,
  orgMembership,
  user,
} from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { AuthAdapter } from './access'
import { getCurrentOrganizationId } from './current-organization'
import { adminRole, computeRoles, getMemberAuthorization, memberRole } from './roles'

describe('computeRoles', () => {
  it('unions every source and always includes member', () => {
    expect(computeRoles({ grants: [], localGroupRoles: [], scimRoles: [] })).toEqual(new Set([memberRole]))
    expect(computeRoles({ grants: ['admin'], localGroupRoles: ['finance'], scimRoles: ['finance', 'ops'] })).toEqual(
      new Set([memberRole, 'admin', 'finance', 'ops']),
    )
  })
})

describe('getMemberAuthorization', () => {
  const orgId = getCurrentOrganizationId()
  let db: typeof DbType
  let cleanup: () => Promise<void>
  let adapter: AuthAdapter

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
    adapter = (await createAuth(db).$context).adapter
  })

  afterEach(async () => {
    await cleanup()
  })

  const seedMember = async (kind: 'local' | 'bootstrap' = 'local') => {
    const userId = crypto.randomUUID()
    await db.insert(user).values({ id: userId, name: 'Member', email: `${userId}@example.com` })
    const membershipId = crypto.randomUUID()
    await db.insert(orgMembership).values({ id: membershipId, orgId, userId })
    await db.insert(membershipSource).values({ id: crypto.randomUUID(), orgId, membershipId, kind })
    return { userId, membershipId }
  }

  const authorize = (userId: string) => getMemberAuthorization({ adapter, database: db }, userId)

  it('keeps a bootstrap admin while an IdP keeps them active, and drops every role when it deactivates them', async () => {
    const { userId, membershipId } = await seedMember('bootstrap')
    await db.insert(memberRoleGrant).values({
      id: crypto.randomUUID(),
      orgId,
      membershipId,
      role: adminRole,
      source: 'bootstrap',
    })
    await db.insert(identityConnection).values({ id: 'entra', orgId, name: 'Entra', scimConnectionId: 'scim-entra' })
    const scimSourceId = crypto.randomUUID()
    await db.insert(membershipSource).values({
      id: scimSourceId,
      orgId,
      membershipId,
      kind: 'scim',
      identityConnectionId: 'entra',
    })

    const active = await authorize(userId)
    expect(active.access).toEqual({ allowed: true })
    expect(active.roles.has(adminRole)).toBe(true)

    await db.update(membershipSource).set({ status: 'suspended' }).where(eq(membershipSource.id, scimSourceId))
    const suspended = await authorize(userId)
    expect(suspended.access).toEqual({ allowed: false, reason: 'deprovisioned' })
    expect(suspended.roles.size).toBe(0)

    await db.update(membershipSource).set({ status: 'active' }).where(eq(membershipSource.id, scimSourceId))
    expect((await authorize(userId)).roles.has(adminRole)).toBe(true)
  })

  it('gives a member the role mapped to their local group', async () => {
    const { userId, membershipId } = await seedMember()
    const [mapped, unmapped] = [crypto.randomUUID(), crypto.randomUUID()]
    await db.insert(localGroup).values([
      { id: mapped, orgId, name: 'Admins' },
      { id: unmapped, orgId, name: 'Finance' },
    ])
    await db.insert(groupRoleMapping).values({ id: crypto.randomUUID(), orgId, localGroupId: mapped, role: adminRole })

    await db.insert(localGroupMember).values({ id: crypto.randomUUID(), orgId, localGroupId: unmapped, membershipId })
    expect((await authorize(userId)).roles).toEqual(new Set([memberRole]))

    await db.insert(localGroupMember).values({ id: crypto.randomUUID(), orgId, localGroupId: mapped, membershipId })
    expect((await authorize(userId)).roles).toEqual(new Set([memberRole, adminRole]))
  })
})
