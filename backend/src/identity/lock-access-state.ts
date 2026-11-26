/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { QueryableDatabase } from '@/db/client'
import { identityConnection, membershipSource, orgMembership, user } from '@/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import type { AccessState } from './access'
import { getCurrentOrganizationId } from './current-organization'

/**
 * Read what `computeAccess` needs, as `loadAccessState` does, locking the user row, their membership
 * and its sources until the transaction ends, so a decision to delete the user still holds when the
 * delete runs. Every SCIM write that links, provisions or restores the user references one of those
 * rows, so it either commits first and is seen here, or waits for the transaction and finds the user
 * gone. Returns null for a user that doesn't exist.
 */
export const lockAccessState = async (tx: QueryableDatabase, userId: string) => {
  const [target] = await tx
    .select({ isAnonymous: user.isAnonymous })
    .from(user)
    .where(eq(user.id, userId))
    .for('update')
  if (!target) {
    return null
  }
  const [membership] = await tx
    .select({
      id: orgMembership.id,
      orgId: orgMembership.orgId,
      userId: orgMembership.userId,
      blockedAt: orgMembership.blockedAt,
    })
    .from(orgMembership)
    .where(and(eq(orgMembership.orgId, getCurrentOrganizationId()), eq(orgMembership.userId, userId)))
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
  return { isAnonymous: target.isAnonymous === true, state }
}
