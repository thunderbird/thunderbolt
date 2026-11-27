/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import {
  groupRoleMapping,
  identityConnection,
  localGroup,
  localGroupMember,
  orgMembership,
  scimGroup,
  scimGroupMember,
  user,
} from '@/db/schema'
import { APIError } from 'better-auth'
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import { insertAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'
import type { assignableRoles } from '../roles'
import { type Page, toPage } from './pagination'

/*
 * Local groups, their members and their role mappings. All hard deletes: these are configuration
 * rows with no `deleted_at`, and each change's audit event keeps the history. Roles are computed on
 * every request, so a change here applies at once without a replay.
 */

type AssignableRole = (typeof assignableRoles)[number]

export type LocalGroupView = {
  id: string
  name: string
  description: string | null
  memberCount: number
  roles: string[]
  createdAt: Date
}

const groupNotFound = () => new APIError('NOT_FOUND', { message: 'Group not found', code: 'GROUP_NOT_FOUND' })

const findGroup = async (database: QueryableDatabase, groupId: string) => {
  const [row] = await database
    .select()
    .from(localGroup)
    .where(and(eq(localGroup.id, groupId), eq(localGroup.orgId, getCurrentOrganizationId())))
  if (!row) {
    throw groupNotFound()
  }
  return row
}

const findMembershipId = async (database: QueryableDatabase, userId: string) => {
  const [row] = await database
    .select({ id: orgMembership.id })
    .from(orgMembership)
    .where(and(eq(orgMembership.userId, userId), eq(orgMembership.orgId, getCurrentOrganizationId())))
  if (!row) {
    throw new APIError('NOT_FOUND', { message: 'Member not found', code: 'MEMBER_NOT_FOUND' })
  }
  return row.id
}

/** The roles each group maps to, and how many members each has. */
const withCountsAndRoles = async (
  database: QueryableDatabase,
  groups: (typeof localGroup.$inferSelect)[],
): Promise<LocalGroupView[]> => {
  if (groups.length === 0) {
    return []
  }
  const ids = groups.map((group) => group.id)
  const [counts, mappings] = await Promise.all([
    database
      .select({ groupId: localGroupMember.localGroupId, members: count() })
      .from(localGroupMember)
      .where(inArray(localGroupMember.localGroupId, ids))
      .groupBy(localGroupMember.localGroupId),
    database
      .select({ groupId: groupRoleMapping.localGroupId, role: groupRoleMapping.role })
      .from(groupRoleMapping)
      .where(inArray(groupRoleMapping.localGroupId, ids)),
  ])
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    createdAt: group.createdAt,
    memberCount: counts.find((row) => row.groupId === group.id)?.members ?? 0,
    roles: mappings.filter((mapping) => mapping.groupId === group.id).map((mapping) => mapping.role),
  }))
}

/** The org's local groups by name, one page at a time. */
export const listLocalGroups = async (
  database: QueryableDatabase,
  { after, limit }: { after?: [string, string]; limit: number },
): Promise<Page<LocalGroupView>> => {
  const rows = await database
    .select()
    .from(localGroup)
    .where(
      and(
        eq(localGroup.orgId, getCurrentOrganizationId()),
        after
          ? or(gt(localGroup.name, after[0]), and(eq(localGroup.name, after[0]), gt(localGroup.id, after[1])))
          : undefined,
      ),
    )
    .orderBy(asc(localGroup.name), asc(localGroup.id))
    .limit(limit + 1)
  const page = toPage(rows, limit, (row) => [row.name, row.id])
  return { items: await withCountsAndRoles(database, page.items), nextCursor: page.nextCursor }
}

export const getLocalGroup = async (database: QueryableDatabase, groupId: string) => {
  const [view] = await withCountsAndRoles(database, [await findGroup(database, groupId)])
  return view
}

/** Create a local group. Names are unique per org, ignoring case. */
export const createLocalGroup = async (
  database: typeof DbType,
  { name, description, actorId }: { name: string; description?: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    const [created] = await tx
      .insert(localGroup)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        name,
        description: description ?? null,
        createdBy: actorId,
      })
      .returning()
    await insertAuditEvent(tx, {
      action: 'local_group.created',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'local_group', id: created.id },
      metadata: { name },
    })
    return created
  })

/** Rename a local group or change its description. */
export const updateLocalGroup = async (
  database: typeof DbType,
  { groupId, name, description, actorId }: { groupId: string; name?: string; description?: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    const current = await findGroup(tx, groupId)
    const changes = {
      ...(name !== undefined && name !== current.name ? { name: { from: current.name, to: name } } : {}),
      ...(description !== undefined && description !== current.description
        ? { description: { from: current.description, to: description } }
        : {}),
    }
    if (Object.keys(changes).length === 0) {
      return current
    }
    const [updated] = await tx
      .update(localGroup)
      .set({ name: name ?? current.name, description: description ?? current.description })
      .where(eq(localGroup.id, groupId))
      .returning()
    await insertAuditEvent(tx, {
      action: 'local_group.updated',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'local_group', id: groupId },
      changes,
    })
    return updated
  })

/**
 * Delete a local group; its members and role mappings go with it. Each mapping the cascade removes
 * gets its own `group_role_mapping.deleted`, so the log shows the roles its members lost.
 */
export const deleteLocalGroup = async (
  database: typeof DbType,
  { groupId, actorId }: { groupId: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    const [group] = await withCountsAndRoles(tx, [await findGroup(tx, groupId)])
    const mappings = await tx.select().from(groupRoleMapping).where(eq(groupRoleMapping.localGroupId, groupId))
    await tx.delete(localGroup).where(eq(localGroup.id, groupId))
    const actor = { type: 'user', id: actorId } as const
    for (const mapping of mappings) {
      await insertAuditEvent(tx, {
        action: 'group_role_mapping.deleted',
        outcome: 'success',
        actor,
        target: { type: 'group_role_mapping', id: mapping.id },
        metadata: { localGroupId: groupId, role: mapping.role, reason: 'local_group_deleted' },
      })
    }
    await insertAuditEvent(tx, {
      action: 'local_group.deleted',
      outcome: 'success',
      actor,
      target: { type: 'local_group', id: groupId },
      metadata: { name: group.name, memberCount: group.memberCount, roles: group.roles },
    })
  })

export type LocalGroupMemberView = { userId: string; email: string; name: string; addedAt: Date }

/** A local group's members by email, one page at a time. */
export const listLocalGroupMembers = async (
  database: QueryableDatabase,
  { groupId, after, limit }: { groupId: string; after?: string; limit: number },
): Promise<Page<LocalGroupMemberView>> => {
  await findGroup(database, groupId)
  const rows = await database
    .select({ userId: user.id, email: user.email, name: user.name, addedAt: localGroupMember.createdAt })
    .from(localGroupMember)
    .innerJoin(orgMembership, eq(orgMembership.id, localGroupMember.membershipId))
    .innerJoin(user, eq(user.id, orgMembership.userId))
    .where(and(eq(localGroupMember.localGroupId, groupId), after ? gt(user.email, after) : undefined))
    .orderBy(asc(user.email))
    .limit(limit + 1)
  return toPage(rows, limit, (row) => [row.email])
}

/** Add a member to a local group. Adding someone already in it changes nothing. */
export const addLocalGroupMember = async (
  database: typeof DbType,
  { groupId, userId, actorId }: { groupId: string; userId: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    await findGroup(tx, groupId)
    const membershipId = await findMembershipId(tx, userId)
    const [added] = await tx
      .insert(localGroupMember)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        localGroupId: groupId,
        membershipId,
        addedBy: actorId,
      })
      .onConflictDoNothing()
      .returning()
    if (added) {
      await insertAuditEvent(tx, {
        action: 'local_group.member_added',
        outcome: 'success',
        actor: { type: 'user', id: actorId },
        target: { type: 'local_group', id: groupId },
        metadata: { userId },
      })
    }
  })

/** Remove a member from a local group. Removing someone not in it changes nothing. */
export const removeLocalGroupMember = async (
  database: typeof DbType,
  { groupId, userId, actorId }: { groupId: string; userId: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    await findGroup(tx, groupId)
    const membershipId = await findMembershipId(tx, userId)
    const [removed] = await tx
      .delete(localGroupMember)
      .where(and(eq(localGroupMember.localGroupId, groupId), eq(localGroupMember.membershipId, membershipId)))
      .returning()
    if (removed) {
      await insertAuditEvent(tx, {
        action: 'local_group.member_removed',
        outcome: 'success',
        actor: { type: 'user', id: actorId },
        target: { type: 'local_group', id: groupId },
        metadata: { userId },
      })
    }
  })

/** Map a local group to a role. */
export const createLocalGroupRoleMapping = async (
  database: typeof DbType,
  { localGroupId, role, actorId }: { localGroupId: string; role: AssignableRole; actorId: string },
) =>
  database.transaction(async (tx) => {
    await findGroup(tx, localGroupId)
    const [created] = await tx
      .insert(groupRoleMapping)
      .values({ id: crypto.randomUUID(), orgId: getCurrentOrganizationId(), localGroupId, role, createdBy: actorId })
      .onConflictDoNothing()
      .returning()
    if (!created) {
      throw new APIError('CONFLICT', { message: 'This group already maps to that role', code: 'MAPPING_EXISTS' })
    }
    await insertAuditEvent(tx, {
      action: 'group_role_mapping.created',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'group_role_mapping', id: created.id },
      metadata: { localGroupId, role },
    })
    return created.id
  })

/** Remove a local group's role mapping. */
export const deleteLocalGroupRoleMapping = async (
  database: typeof DbType,
  { mappingId, actorId }: { mappingId: string; actorId: string },
) =>
  database.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(groupRoleMapping)
      .where(
        and(
          eq(groupRoleMapping.id, mappingId),
          eq(groupRoleMapping.orgId, getCurrentOrganizationId()),
          isNotNull(groupRoleMapping.localGroupId),
        ),
      )
      .returning()
    if (!deleted) {
      throw new APIError('NOT_FOUND', { message: 'Role mapping not found', code: 'MAPPING_NOT_FOUND' })
    }
    await insertAuditEvent(tx, {
      action: 'group_role_mapping.deleted',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'group_role_mapping', id: deleted.id },
      metadata: { localGroupId: deleted.localGroupId, role: deleted.role },
    })
  })

export type RoleMappingView = {
  id: string
  role: string
  target:
    | { kind: 'local_group'; groupId: string; name: string }
    | { kind: 'scim_group'; connectionId: string; scimGroupId: string; displayName: string | null }
  createdAt: Date
}

/** The org's group-to-role mappings, local and SCIM. A SCIM group's name is shown, never used as a key. */
export const listRoleMappings = async (
  database: QueryableDatabase,
  { connectionId, localGroupId }: { connectionId?: string; localGroupId?: string },
): Promise<RoleMappingView[]> => {
  const filters: (SQL | undefined)[] = [
    eq(groupRoleMapping.orgId, getCurrentOrganizationId()),
    connectionId ? eq(groupRoleMapping.identityConnectionId, connectionId) : undefined,
    localGroupId ? eq(groupRoleMapping.localGroupId, localGroupId) : undefined,
  ]
  const rows = await database
    .select({
      id: groupRoleMapping.id,
      role: groupRoleMapping.role,
      localGroupId: groupRoleMapping.localGroupId,
      localGroupName: localGroup.name,
      connectionId: groupRoleMapping.identityConnectionId,
      scimGroupId: groupRoleMapping.scimGroupId,
      displayName: scimGroup.displayName,
      createdAt: groupRoleMapping.createdAt,
    })
    .from(groupRoleMapping)
    .leftJoin(localGroup, eq(localGroup.id, groupRoleMapping.localGroupId))
    .leftJoin(scimGroup, eq(scimGroup.id, groupRoleMapping.scimGroupId))
    .where(and(...filters))
    .orderBy(asc(groupRoleMapping.createdAt), asc(groupRoleMapping.id))
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    createdAt: row.createdAt,
    target:
      row.localGroupId !== null
        ? { kind: 'local_group', groupId: row.localGroupId, name: row.localGroupName ?? '' }
        : {
            kind: 'scim_group',
            connectionId: row.connectionId!,
            scimGroupId: row.scimGroupId!,
            displayName: row.displayName,
          },
  }))
}

/** A mapping's kind, so the route hands it to the service that owns it. */
export const findRoleMappingKind = async (database: QueryableDatabase, mappingId: string) => {
  const [row] = await database
    .select({ scimGroupId: groupRoleMapping.scimGroupId })
    .from(groupRoleMapping)
    .where(and(eq(groupRoleMapping.id, mappingId), eq(groupRoleMapping.orgId, getCurrentOrganizationId())))
  if (!row) {
    throw new APIError('NOT_FOUND', { message: 'Role mapping not found', code: 'MAPPING_NOT_FOUND' })
  }
  return row.scimGroupId ? 'scim_group' : 'local_group'
}

export type ScimGroupView = {
  id: string
  displayName: string
  externalId: string | null
  memberCount: number
  roles: string[]
}

/**
 * A connection's SCIM groups by name, one page at a time, read-only: the IdP owns them. Map one to a
 * role by its `id`.
 */
export const listScimGroups = async (
  database: QueryableDatabase,
  { identityConnectionId, after, limit }: { identityConnectionId: string; after?: [string, string]; limit: number },
): Promise<Page<ScimGroupView>> => {
  const [connection] = await database
    .select({ scimConnectionId: identityConnection.scimConnectionId })
    .from(identityConnection)
    .where(
      and(eq(identityConnection.id, identityConnectionId), eq(identityConnection.orgId, getCurrentOrganizationId())),
    )
  if (!connection?.scimConnectionId) {
    throw new APIError('NOT_FOUND', { message: 'SCIM connection not found', code: 'SCIM_CONNECTION_NOT_FOUND' })
  }
  const rows = await database
    .select({ id: scimGroup.id, displayName: scimGroup.displayName, externalId: scimGroup.externalId })
    .from(scimGroup)
    .where(
      and(
        eq(scimGroup.connectionId, connection.scimConnectionId),
        after
          ? or(
              gt(scimGroup.displayName, after[0]),
              and(eq(scimGroup.displayName, after[0]), gt(scimGroup.id, after[1])),
            )
          : undefined,
      ),
    )
    .orderBy(asc(scimGroup.displayName), asc(scimGroup.id))
    .limit(limit + 1)
  const page = toPage(rows, limit, (row) => [row.displayName, row.id])
  const ids = page.items.map((row) => row.id)
  const [counts, mappings] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          database
            .select({ groupId: scimGroupMember.groupId, members: count() })
            .from(scimGroupMember)
            .where(inArray(scimGroupMember.groupId, ids))
            .groupBy(scimGroupMember.groupId),
          database
            .select({ groupId: groupRoleMapping.scimGroupId, role: groupRoleMapping.role })
            .from(groupRoleMapping)
            .where(
              and(
                eq(groupRoleMapping.identityConnectionId, identityConnectionId),
                inArray(groupRoleMapping.scimGroupId, ids),
                isNull(groupRoleMapping.localGroupId),
              ),
            ),
        ])
  return {
    items: page.items.map((row) => ({
      ...row,
      memberCount: counts.find((entry) => entry.groupId === row.id)?.members ?? 0,
      roles: mappings.filter((mapping) => mapping.groupId === row.id).map((mapping) => mapping.role),
    })),
    nextCursor: page.nextCursor,
  }
}
