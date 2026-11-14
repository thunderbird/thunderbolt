/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { identityConnection, membershipSource, orgMembership, user } from '@/db/schema'
import { APIError } from 'better-auth'
import { and, eq, inArray } from 'drizzle-orm'
import { type AccessState, computeAccess, idpManagingSources } from './access'
import { insertAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

const refuse = (message: string, code: string) => new APIError('CONFLICT', { message, code })

const memberNotFound = () => new APIError('NOT_FOUND', { message: 'Member not found', code: 'MEMBER_NOT_FOUND' })

/**
 * Permanently delete a member who has lost access, and everything they own: the user row cascades
 * to their data, devices, `org_envelopes` and SCIM records, the tombstone included. Server-only,
 * for the admin routes. Refused while the member still has access, and while an IdP has only
 * suspended them, since `active:false` can be reversed. Allowed for a member an IdP deleted, an
 * admin blocked, or a local member with no live source. The audit event has no foreign key, so it
 * outlives the user.
 *
 * The membership and its sources are locked before access is checked: a SCIM restore, an unblock or
 * a new source either commits first and is seen, or waits for the purge and finds the member gone.
 */
export const purgeMember = async (
  database: typeof DbType,
  { userId, actorId }: { userId: string; actorId: string },
) => {
  if (userId === actorId) {
    throw new APIError('BAD_REQUEST', { message: 'Admins cannot purge themselves', code: 'PURGE_SELF' })
  }
  await database.transaction(async (tx) => {
    const [target] = await tx.select({ isAnonymous: user.isAnonymous }).from(user).where(eq(user.id, userId))
    if (!target || target.isAnonymous) {
      throw memberNotFound()
    }
    const orgId = getCurrentOrganizationId()
    const [membership] = await tx
      .select({
        id: orgMembership.id,
        orgId: orgMembership.orgId,
        userId: orgMembership.userId,
        blockedAt: orgMembership.blockedAt,
      })
      .from(orgMembership)
      .where(and(eq(orgMembership.orgId, orgId), eq(orgMembership.userId, userId)))
      .for('update')
    const sources = membership
      ? await tx
          .select({
            id: membershipSource.id,
            kind: membershipSource.kind,
            status: membershipSource.status,
            identityConnectionId: membershipSource.identityConnectionId,
            ref: membershipSource.ref,
          })
          .from(membershipSource)
          .where(eq(membershipSource.membershipId, membership.id))
          .for('update')
      : []
    // As `loadAccessState` reads it: only a `scim` or `sso` source's connection decides access.
    const connectionIds = [
      ...new Set(
        sources.flatMap(
          (source) => ((source.kind === 'scim' || source.kind === 'sso') && source.identityConnectionId) || [],
        ),
      ),
    ]
    const connections =
      connectionIds.length === 0
        ? []
        : await tx
            .select({
              id: identityConnection.id,
              status: identityConnection.status,
              ssoProviderId: identityConnection.ssoProviderId,
            })
            .from(identityConnection)
            .where(inArray(identityConnection.id, connectionIds))
    const state: AccessState = {
      membership: membership ?? null,
      sources,
      connectionStatusById: new Map(connections.map((connection) => [connection.id, connection.status])),
      ssoConnectionIds: new Set(connections.flatMap((connection) => (connection.ssoProviderId ? connection.id : []))),
    }

    const access = computeAccess(state)
    if (access.allowed) {
      throw refuse('This member still has access', 'MEMBER_HAS_ACCESS')
    }
    if (idpManagingSources(state).some((source) => source.status === 'suspended')) {
      throw refuse('An identity provider has only suspended this member', 'MEMBER_SUSPENDED_BY_IDP')
    }
    await insertAuditEvent(tx, {
      action: 'member.purged',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'user', id: userId },
      metadata: { reason: access.reason },
    })
    await tx.delete(user).where(eq(user.id, userId))
  })
}
