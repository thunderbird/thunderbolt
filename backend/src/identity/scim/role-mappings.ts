/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import type { db as DbType } from '@/db/client'
import { groupRoleMapping, identityConnection, scimGroup } from '@/db/schema'
import { APIError } from 'better-auth'
import { and, eq, isNotNull } from 'drizzle-orm'
import { insertAuditEvent } from '../audit/write'
import { getCurrentOrganizationId } from '../current-organization'

/** What a role name may be. */
export const roleNamePattern = '^[a-z][a-z0-9_-]{0,62}$'

/**
 * Re-run the role projection for every SCIM user in the org, so a mapping change reaches members
 * now rather than at the IdP's next change to them. The plugin walks the org in batches, each in
 * its own transaction, so this can't share the mapping's.
 */
const replayScimRoles = (auth: Auth) =>
  auth.api.reconcileSCIMProjection({ body: { provisioningDomainId: getCurrentOrganizationId() } })

type CreateScimGroupRoleMappingInput = {
  identityConnectionId: string
  /** The plugin's SCIM group id, never its display name. */
  scimGroupId: string
  role: string
  actorId: string
}

/**
 * Map a SCIM group of a connection to a role, then apply it to the group's members. Server-only,
 * for the admin routes. The connection's SCIM side must be active and the group its own. Returns
 * the mapping id.
 */
export const createScimGroupRoleMapping = async (
  auth: Auth,
  database: typeof DbType,
  { identityConnectionId, scimGroupId, role, actorId }: CreateScimGroupRoleMappingInput,
) => {
  if (!new RegExp(roleNamePattern).test(role)) {
    throw new APIError('BAD_REQUEST', { message: `Invalid role "${role}"`, code: 'ROLE_INVALID' })
  }
  const orgId = getCurrentOrganizationId()
  const id = await database.transaction(async (tx) => {
    const [connection] = await tx
      .select({ scimConnectionId: identityConnection.scimConnectionId })
      .from(identityConnection)
      .where(
        and(
          eq(identityConnection.id, identityConnectionId),
          eq(identityConnection.orgId, orgId),
          eq(identityConnection.status, 'active'),
          isNotNull(identityConnection.scimConnectionId),
        ),
      )
    const [group] = connection
      ? await tx
          .select({ id: scimGroup.id })
          .from(scimGroup)
          .where(and(eq(scimGroup.id, scimGroupId), eq(scimGroup.connectionId, connection.scimConnectionId!)))
      : []
    if (!group) {
      throw new APIError('NOT_FOUND', { message: 'SCIM group not found', code: 'SCIM_GROUP_NOT_FOUND' })
    }
    const [created] = await tx
      .insert(groupRoleMapping)
      .values({ id: crypto.randomUUID(), orgId, identityConnectionId, scimGroupId, role, createdBy: actorId })
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
      connectionId: identityConnectionId,
      metadata: { scimGroupId, role },
    })
    return created.id
  })
  await replayScimRoles(auth)
  return id
}

/** Remove a SCIM group's role mapping, then take the role from the group's members. Server-only. */
export const deleteScimGroupRoleMapping = async (
  auth: Auth,
  database: typeof DbType,
  { mappingId, actorId }: { mappingId: string; actorId: string },
) => {
  await database.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(groupRoleMapping)
      .where(
        and(
          eq(groupRoleMapping.id, mappingId),
          eq(groupRoleMapping.orgId, getCurrentOrganizationId()),
          isNotNull(groupRoleMapping.scimGroupId),
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
      connectionId: deleted.identityConnectionId,
      metadata: { scimGroupId: deleted.scimGroupId, role: deleted.role },
    })
  })
  await replayScimRoles(auth)
}
