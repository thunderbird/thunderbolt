/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { user } from '@/db/schema'
import { APIError } from 'better-auth'
import { eq } from 'drizzle-orm'
import { computeAccess, idpManagingSources } from './access'
import { insertAuditEvent } from './audit/write'
import { lockAccessState } from './lock-access-state'

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
 * The user, their membership and its sources are locked before access is checked (`lockAccessState`).
 */
export const purgeMember = async (
  database: typeof DbType,
  { userId, actorId }: { userId: string; actorId: string },
) => {
  if (userId === actorId) {
    throw new APIError('BAD_REQUEST', { message: 'Admins cannot purge themselves', code: 'PURGE_SELF' })
  }
  await database.transaction(async (tx) => {
    const locked = await lockAccessState(tx, userId)
    if (!locked || locked.isAnonymous) {
      throw memberNotFound()
    }
    const { state } = locked
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
