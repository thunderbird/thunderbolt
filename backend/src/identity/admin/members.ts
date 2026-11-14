/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType, QueryableDatabase } from '@/db/client'
import {
  groupRoleMapping,
  identityConnection,
  localGroupMember,
  memberRoleGrant,
  membershipSource,
  orgMembership,
  scimProjectionGrant,
  session,
  user,
} from '@/db/schema'
import { APIError } from 'better-auth'
import { and, asc, eq, gt, ilike, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import {
  type AccessDecision,
  type AccessState,
  computeAccess,
  idpManagingSources,
  type MembershipSourceRow,
  requiresSso,
} from '../access'
import { insertAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'
import { adminRole, type assignableRoles, liveScimGrantJoins } from '../roles'
import { type Page, toPage } from './pagination'

/** What the IdP owns on a member it manages: an admin can't edit these here. */
export const idpManagedFields = ['email', 'name', 'scimGroups', 'scimRoles', 'status'] as const

export type MemberRoleSource = {
  role: string
  from: 'local' | 'bootstrap' | 'local_group' | 'scim'
  groupId?: string
  connectionId?: string
}

export type MemberView = {
  userId: string
  email: string
  name: string
  joinedAt: Date
  access: AccessDecision
  blocked: { at: Date; by: string | null; reason: string | null } | null
  sources: {
    kind: MembershipSourceRow['kind']
    status: MembershipSourceRow['status']
    connection: { id: string; name: string } | null
  }[]
  /** Every role the member holds and where it comes from. Usable only while `access` allows them in. */
  roles: MemberRoleSource[]
  /** Null when no IdP manages the member. */
  idpManaged: { connections: { id: string; name: string }[]; fields: typeof idpManagedFields } | null
  requiresSso: boolean
}

type MembershipWithUser = {
  membershipId: string
  userId: string
  email: string
  name: string
  joinedAt: Date
  blockedAt: Date | null
  blockedBy: string | null
  blockReason: string | null
}

const membershipColumns = {
  membershipId: orgMembership.id,
  userId: orgMembership.userId,
  email: user.email,
  name: user.name,
  joinedAt: orgMembership.createdAt,
  blockedAt: orgMembership.blockedAt,
  blockedBy: orgMembership.blockedBy,
  blockReason: orgMembership.blockReason,
}

const selectMemberships = (database: QueryableDatabase, ...filters: (SQL | undefined)[]) =>
  database
    .select(membershipColumns)
    .from(orgMembership)
    .innerJoin(user, eq(user.id, orgMembership.userId))
    .where(and(eq(orgMembership.orgId, getCurrentOrganizationId()), ...filters))

const memberNotFound = () => new APIError('NOT_FOUND', { message: 'Member not found', code: 'MEMBER_NOT_FOUND' })

/**
 * Build the admin view of a batch of members with one query per table, then decide each one's
 * access and roles with the same pure functions sign-in uses, so the two can't disagree.
 */
const toMemberViews = async (database: QueryableDatabase, rows: MembershipWithUser[]): Promise<MemberView[]> => {
  if (rows.length === 0) {
    return []
  }
  const orgId = getCurrentOrganizationId()
  const membershipIds = rows.map((row) => row.membershipId)
  const scimJoins = liveScimGrantJoins(orgId)
  const [sources, grants, groupRoles, scimGrants] = await Promise.all([
    database
      .select({
        id: membershipSource.id,
        membershipId: membershipSource.membershipId,
        kind: membershipSource.kind,
        status: membershipSource.status,
        identityConnectionId: membershipSource.identityConnectionId,
        ref: membershipSource.ref,
      })
      .from(membershipSource)
      .where(inArray(membershipSource.membershipId, membershipIds)),
    database
      .select({
        membershipId: memberRoleGrant.membershipId,
        role: memberRoleGrant.role,
        source: memberRoleGrant.source,
      })
      .from(memberRoleGrant)
      .where(and(eq(memberRoleGrant.orgId, orgId), inArray(memberRoleGrant.membershipId, membershipIds))),
    database
      .select({
        membershipId: localGroupMember.membershipId,
        role: groupRoleMapping.role,
        groupId: localGroupMember.localGroupId,
      })
      .from(localGroupMember)
      .innerJoin(groupRoleMapping, eq(groupRoleMapping.localGroupId, localGroupMember.localGroupId))
      .where(and(eq(localGroupMember.orgId, orgId), inArray(localGroupMember.membershipId, membershipIds))),
    database
      .select({
        userId: scimProjectionGrant.userId,
        role: scimProjectionGrant.role,
        groupId: scimProjectionGrant.sourceId,
        connectionId: identityConnection.id,
      })
      .from(scimProjectionGrant)
      .innerJoin(identityConnection, scimJoins.connection)
      .innerJoin(groupRoleMapping, scimJoins.mapping)
      .where(
        and(
          eq(scimProjectionGrant.provisioningDomainId, orgId),
          inArray(
            scimProjectionGrant.userId,
            rows.map((row) => row.userId),
          ),
        ),
      ),
  ])
  const connectionIds = [...new Set(sources.flatMap((source) => source.identityConnectionId ?? []))]
  const connections =
    connectionIds.length === 0
      ? []
      : await database
          .select({
            id: identityConnection.id,
            name: identityConnection.name,
            status: identityConnection.status,
            ssoProviderId: identityConnection.ssoProviderId,
          })
          .from(identityConnection)
          .where(inArray(identityConnection.id, connectionIds))
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]))
  const connectionStatusById = new Map(connections.map((connection) => [connection.id, connection.status]))
  const ssoConnectionIds = new Set(connections.flatMap((connection) => (connection.ssoProviderId ? connection.id : [])))
  const connectionRef = (id: string | null) => {
    const connection = id ? connectionById.get(id) : undefined
    return connection ? { id: connection.id, name: connection.name } : null
  }

  return rows.map((row) => {
    const memberSources = sources.filter((source) => source.membershipId === row.membershipId)
    const state: AccessState = {
      membership: { id: row.membershipId, orgId, userId: row.userId, blockedAt: row.blockedAt },
      sources: memberSources,
      connectionStatusById,
      ssoConnectionIds,
    }
    const managing = idpManagingSources(state)
    const roles: MemberRoleSource[] = [
      ...grants
        .filter((grant) => grant.membershipId === row.membershipId)
        .map((grant) => ({ role: grant.role, from: grant.source })),
      ...groupRoles
        .filter((mapping) => mapping.membershipId === row.membershipId)
        .map((mapping) => ({ role: mapping.role, from: 'local_group' as const, groupId: mapping.groupId })),
      ...scimGrants
        .filter((grant) => grant.userId === row.userId)
        .map((grant) => ({
          role: grant.role,
          from: 'scim' as const,
          groupId: grant.groupId,
          connectionId: grant.connectionId,
        })),
    ]
    return {
      userId: row.userId,
      email: row.email,
      name: row.name,
      joinedAt: row.joinedAt,
      access: computeAccess(state),
      blocked: row.blockedAt ? { at: row.blockedAt, by: row.blockedBy, reason: row.blockReason } : null,
      sources: memberSources.map((source) => ({
        kind: source.kind,
        status: source.status,
        connection: connectionRef(source.identityConnectionId),
      })),
      roles,
      idpManaged:
        managing.length === 0
          ? null
          : {
              connections: [...new Set(managing.map((source) => source.identityConnectionId))].flatMap(
                (id) => connectionRef(id) ?? [],
              ),
              fields: idpManagedFields,
            },
      requiresSso: requiresSso(state),
    }
  })
}

/** `%`, `_` and `\` match literally in a substring search. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`)

/** The org's members by email, one page at a time. `q` matches part of the email or name. */
export const listMembers = async (
  database: QueryableDatabase,
  { q, after, limit }: { q?: string; after?: string; limit: number },
): Promise<Page<MemberView>> => {
  const pattern = q ? `%${escapeLike(q)}%` : null
  const rows = await selectMemberships(
    database,
    pattern ? or(ilike(user.email, pattern), ilike(user.name, pattern)) : undefined,
    after ? gt(user.email, after) : undefined,
  )
    .orderBy(asc(user.email))
    .limit(limit + 1)
  const page = toPage(rows, limit, (row) => [row.email])
  return { items: await toMemberViews(database, page.items), nextCursor: page.nextCursor }
}

/** One member's admin view. */
export const getMember = async (database: QueryableDatabase, userId: string) => {
  const [view] = await toMemberViews(database, await selectMemberships(database, eq(orgMembership.userId, userId)))
  if (!view) {
    throw memberNotFound()
  }
  return view
}

/**
 * The members who can act as admin now: they have access and hold `admin` from a local grant, a
 * mapped local group, or a mapped SCIM group.
 */
export const listAdmins = async (database: QueryableDatabase) => {
  const orgId = getCurrentOrganizationId()
  const scimJoins = liveScimGrantJoins(orgId)
  const [granted, grouped, projected] = await Promise.all([
    database
      .select({ membershipId: memberRoleGrant.membershipId })
      .from(memberRoleGrant)
      .where(and(eq(memberRoleGrant.orgId, orgId), eq(memberRoleGrant.role, adminRole))),
    database
      .select({ membershipId: localGroupMember.membershipId })
      .from(localGroupMember)
      .innerJoin(groupRoleMapping, eq(groupRoleMapping.localGroupId, localGroupMember.localGroupId))
      .where(and(eq(localGroupMember.orgId, orgId), eq(groupRoleMapping.role, adminRole))),
    database
      .select({ userId: scimProjectionGrant.userId })
      .from(scimProjectionGrant)
      .innerJoin(identityConnection, scimJoins.connection)
      .innerJoin(groupRoleMapping, scimJoins.mapping)
      .where(and(eq(scimProjectionGrant.provisioningDomainId, orgId), eq(scimProjectionGrant.role, adminRole))),
  ])
  const membershipIds = [...granted, ...grouped].map((row) => row.membershipId)
  const userIds = projected.map((row) => row.userId)
  if (membershipIds.length === 0 && userIds.length === 0) {
    return []
  }
  const rows = await selectMemberships(
    database,
    or(
      membershipIds.length > 0 ? inArray(orgMembership.id, membershipIds) : undefined,
      userIds.length > 0 ? inArray(orgMembership.userId, userIds) : undefined,
    ),
  )
  const views = await toMemberViews(database, rows)
  return views.filter((view) => view.access.allowed && view.roles.some((source) => source.role === adminRole))
}

export type BreakGlassStatus = { allAdminsIdpManaged: boolean; adminCount: number; localAdminCount: number }

/**
 * Whether every admin depends on the IdP to sign in. A local admin is one no IdP manages, who can
 * sign in by email code while the IdP is down.
 */
export const getBreakGlassStatus = async (database: QueryableDatabase): Promise<BreakGlassStatus> => {
  const admins = await listAdmins(database)
  const localAdminCount = admins.filter((admin) => !admin.idpManaged).length
  return { allAdminsIdpManaged: localAdminCount === 0, adminCount: admins.length, localAdminCount }
}

/**
 * For a change that can take admin away: `warning: 'NO_LOCAL_ADMIN'` when it left no admin who can
 * sign in without the IdP. The change stands either way; only shared hosting would refuse it.
 */
export const breakGlassWarning = async (database: QueryableDatabase) =>
  (await getBreakGlassStatus(database)).allAdminsIdpManaged ? { warning: 'NO_LOCAL_ADMIN' as const } : {}

const findMembership = async (database: QueryableDatabase, userId: string) => {
  const [row] = await selectMemberships(database, eq(orgMembership.userId, userId))
  if (!row) {
    throw memberNotFound()
  }
  return row
}

/**
 * Block a member. The block outranks every IdP grant: sign-in, API keys, sync and WebSockets are
 * refused from the commit on. Their sessions are deleted; devices and API keys stay, so unblocking
 * is seamless. An admin can't block themselves. Blocking someone already blocked changes nothing.
 */
export const blockMember = async (
  database: typeof DbType,
  { userId, actorId, reason }: { userId: string; actorId: string; reason?: string },
) => {
  if (userId === actorId) {
    throw new APIError('CONFLICT', { message: 'Admins cannot block themselves', code: 'BLOCK_SELF' })
  }
  await database.transaction(async (tx) => {
    const membership = await findMembership(tx, userId)
    const [blocked] = await tx
      .update(orgMembership)
      .set({ blockedAt: new Date(), blockedBy: actorId, blockReason: reason ?? null })
      .where(and(eq(orgMembership.id, membership.membershipId), isNull(orgMembership.blockedAt)))
      .returning()
    if (!blocked) {
      return
    }
    // Deleted here rather than through Better Auth, so its session hooks don't record them.
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning()
    const actor = { type: 'user', id: actorId } as const
    for (const { id } of sessions) {
      await insertAuditEvent(tx, {
        action: 'auth.session_revoked',
        outcome: 'success',
        actor,
        target: { type: 'user', id: userId },
        metadata: { sessionId: id, reason: 'member_blocked' },
      })
    }
    await insertAuditEvent(tx, {
      action: 'member.blocked',
      outcome: 'success',
      actor,
      target: { type: 'user', id: userId },
      metadata: { sessionsRevoked: sessions.length },
    })
  })
}

/** Lift a member's block. Access then follows their sources again: an IdP that deprovisioned them still wins. */
export const unblockMember = async (
  database: typeof DbType,
  { userId, actorId }: { userId: string; actorId: string },
) => {
  await database.transaction(async (tx) => {
    const membership = await findMembership(tx, userId)
    const [unblocked] = await tx
      .update(orgMembership)
      .set({ blockedAt: null, blockedBy: null, blockReason: null })
      .where(and(eq(orgMembership.id, membership.membershipId), isNotNull(orgMembership.blockedAt)))
      .returning()
    if (unblocked) {
      await insertAuditEvent(tx, {
        action: 'member.unblocked',
        outcome: 'success',
        actor: { type: 'user', id: actorId },
        target: { type: 'user', id: userId },
      })
    }
  })
}

type AssignableRole = (typeof assignableRoles)[number]

/** Grant a member a role locally. It stays until an admin revokes it, whatever an IdP does. */
export const grantMemberRole = async (
  database: typeof DbType,
  { userId, role, actorId }: { userId: string; role: AssignableRole; actorId: string },
) => {
  await database.transaction(async (tx) => {
    const membership = await findMembership(tx, userId)
    const [granted] = await tx
      .insert(memberRoleGrant)
      .values({
        id: crypto.randomUUID(),
        orgId: getCurrentOrganizationId(),
        membershipId: membership.membershipId,
        role,
        source: 'local',
        grantedBy: actorId,
      })
      .onConflictDoNothing()
      .returning()
    if (granted) {
      await insertAuditEvent(tx, {
        action: 'member.role_granted',
        outcome: 'success',
        actor: { type: 'user', id: actorId },
        target: { type: 'user', id: userId },
        metadata: { role },
      })
    }
  })
}

/**
 * Revoke a member's local grant of a role, the bootstrap admin's included. A role held only through
 * a group is refused with the reason: a SCIM group's roles follow the IdP, and a local group's follow
 * its membership.
 */
export const revokeMemberRole = async (
  database: typeof DbType,
  { userId, role, actorId }: { userId: string; role: AssignableRole; actorId: string },
) => {
  await database.transaction(async (tx) => {
    const membership = await findMembership(tx, userId)
    const [revoked] = await tx
      .delete(memberRoleGrant)
      .where(and(eq(memberRoleGrant.membershipId, membership.membershipId), eq(memberRoleGrant.role, role)))
      .returning()
    if (revoked) {
      await insertAuditEvent(tx, {
        action: 'member.role_revoked',
        outcome: 'success',
        actor: { type: 'user', id: actorId },
        target: { type: 'user', id: userId },
        metadata: { role, source: revoked.source },
      })
      return
    }
    const [view] = await toMemberViews(tx, [membership])
    const held = view.roles.filter((source) => source.role === role)
    const fromScim = held.filter((source) => source.from === 'scim')
    if (fromScim.length > 0) {
      throw new APIError('CONFLICT', {
        message: 'An identity provider group grants this role; change the group in the identity provider',
        code: 'ROLE_MANAGED_BY_IDP',
        managedBy: fromScim.map(({ connectionId, groupId }) => ({ connectionId, scimGroupId: groupId })),
      })
    }
    if (held.length > 0) {
      throw new APIError('CONFLICT', {
        message: 'A local group grants this role; remove the member from the group',
        code: 'ROLE_FROM_LOCAL_GROUP',
        groupIds: held.map((source) => source.groupId),
      })
    }
    throw new APIError('NOT_FOUND', { message: 'The member does not hold this role', code: 'MEMBER_ROLE_NOT_FOUND' })
  })
}

/** Rename a member. Refused while an IdP manages them: it mirrors their name, and would overwrite the edit. */
export const updateMemberProfile = async (
  database: typeof DbType,
  { userId, name, actorId }: { userId: string; name: string; actorId: string },
) => {
  await database.transaction(async (tx) => {
    const membership = await findMembership(tx, userId)
    const [view] = await toMemberViews(tx, [membership])
    if (view.idpManaged) {
      throw new APIError('CONFLICT', {
        message: 'An identity provider manages this field; change it there',
        code: 'FIELD_MANAGED_BY_IDP',
        field: 'name',
        managedBy: view.idpManaged.connections.map((connection) => connection.id),
      })
    }
    if (membership.name === name) {
      return
    }
    await tx.update(user).set({ name }).where(eq(user.id, userId))
    await insertAuditEvent(tx, {
      action: 'member.updated',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'user', id: userId },
      metadata: { fields: ['name'] },
    })
  })
}
