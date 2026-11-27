/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import {
  groupRoleMapping,
  identityConnection,
  localGroupMember,
  memberRoleGrant,
  scimProjectionGrant,
} from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { type AccessDecision, type AuthAdapter, computeAccess, loadAccessState } from './access'
import { getCurrentOrganizationId } from './current-organization'

/** Every member with access holds this role. */
export const memberRole = 'member'

export const adminRole = 'admin'

/** The roles an admin can grant or map a group to: the ones the system knows. `member` is implicit. */
export const assignableRoles = [adminRole] as const

export type RoleSources = {
  /** `member_role_grant` rows: local grants, the bootstrap admin's included. */
  grants: string[]
  /** Roles mapped to the member's local groups through `group_role_mapping`. */
  localGroupRoles: string[]
  /** Roles the SCIM plugin projected from the member's IdP groups. */
  scimRoles: string[]
}

/** The union of every role source, plus `member`. */
export const computeRoles = ({ grants, localGroupRoles, scimRoles }: RoleSources): Set<string> =>
  new Set([memberRole, ...grants, ...localGroupRoles, ...scimRoles])

/**
 * The joins that keep only SCIM grants that still hold: the connection's SCIM side is active and the
 * mapping that produced the grant still exists. The plugin's stored grants trail both until a replay
 * or a retire walk reaches them, so a stored grant alone grants nothing.
 */
export const liveScimGrantJoins = (orgId = getCurrentOrganizationId()) => ({
  connection: and(
    eq(identityConnection.orgId, orgId),
    eq(identityConnection.scimConnectionId, scimProjectionGrant.connectionId),
    eq(identityConnection.status, 'active'),
  ),
  mapping: and(
    eq(groupRoleMapping.orgId, orgId),
    eq(groupRoleMapping.identityConnectionId, identityConnection.id),
    eq(groupRoleMapping.scimGroupId, scimProjectionGrant.sourceId),
    eq(groupRoleMapping.role, scimProjectionGrant.role),
  ),
})

/**
 * Read a membership's role sources. Through Drizzle, not the auth adapter: the adapter only knows
 * the SCIM tables once the SCIM plugin is installed, and roles are never needed inside a hook.
 */
export const loadRoleSources = async (
  database: QueryableDatabase,
  membership: { id: string; userId: string },
  orgId = getCurrentOrganizationId(),
): Promise<RoleSources> => {
  const scimJoins = liveScimGrantJoins(orgId)
  const [grants, localGroupRoles, scimGrants] = await Promise.all([
    database
      .select({ role: memberRoleGrant.role })
      .from(memberRoleGrant)
      .where(and(eq(memberRoleGrant.orgId, orgId), eq(memberRoleGrant.membershipId, membership.id))),
    database
      .select({ role: groupRoleMapping.role })
      .from(localGroupMember)
      .innerJoin(groupRoleMapping, eq(groupRoleMapping.localGroupId, localGroupMember.localGroupId))
      .where(and(eq(localGroupMember.orgId, orgId), eq(localGroupMember.membershipId, membership.id))),
    database
      .select({ role: scimProjectionGrant.role })
      .from(scimProjectionGrant)
      .innerJoin(identityConnection, scimJoins.connection)
      .innerJoin(groupRoleMapping, scimJoins.mapping)
      .where(
        and(eq(scimProjectionGrant.userId, membership.userId), eq(scimProjectionGrant.provisioningDomainId, orgId)),
      ),
  ])
  return {
    grants: grants.map((grant) => grant.role),
    localGroupRoles: localGroupRoles.map((mapping) => mapping.role),
    scimRoles: scimGrants.map((grant) => grant.role),
  }
}

export type MemberAuthorization = { access: AccessDecision; roles: Set<string> }

/**
 * A user's access and roles in the current org. Roles are usable only with access, so a refused
 * member has none, even when a local grant (the bootstrap admin's, say) is still stored.
 */
export const getMemberAuthorization = async (
  { adapter, database }: { adapter: AuthAdapter; database: QueryableDatabase },
  userId: string,
): Promise<MemberAuthorization> => {
  const state = await loadAccessState(adapter, userId)
  const access = computeAccess(state)
  if (!access.allowed || !state.membership) {
    return { access, roles: new Set() }
  }
  return { access, roles: computeRoles(await loadRoleSources(database, state.membership)) }
}
