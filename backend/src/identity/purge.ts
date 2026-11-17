/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/auth'
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context'
import { APIError } from 'better-auth'
import { computeAccess, idpManagingSources, loadAccessState } from './access'
import { createAuditEvent } from './audit/write'

const refuse = (message: string, code: string) => new APIError('CONFLICT', { message, code })

/**
 * Permanently delete a member who has lost access, and everything they own: the user row cascades
 * to their data, devices, `org_envelopes` and SCIM records, the tombstone included. Server-only,
 * for the admin routes. Refused while the member still has access, and while an IdP has only
 * suspended them, since `active:false` can be reversed. Allowed for a member an IdP deleted, an
 * admin blocked, or a local member with no live source. The audit event has no foreign key, so it
 * outlives the user.
 */
export const purgeMember = async (auth: Auth, { userId, actorId }: { userId: string; actorId: string }) => {
  if (userId === actorId) {
    throw new APIError('BAD_REQUEST', { message: 'Admins cannot purge themselves', code: 'PURGE_SELF' })
  }
  const { adapter } = await auth.$context
  await runWithTransaction(adapter, async () => {
    const tx = await getCurrentAdapter(adapter)
    const target = await tx.findOne<{ id: string; isAnonymous: boolean | null }>({
      model: 'user',
      where: [{ field: 'id', value: userId }],
    })
    if (!target || target.isAnonymous) {
      throw new APIError('NOT_FOUND', { message: 'Member not found', code: 'MEMBER_NOT_FOUND' })
    }
    const state = await loadAccessState(tx, userId)
    const access = computeAccess(state)
    if (access.allowed) {
      throw refuse('This member still has access', 'MEMBER_HAS_ACCESS')
    }
    if (idpManagingSources(state).some((source) => source.status === 'suspended')) {
      throw refuse('An identity provider has only suspended this member', 'MEMBER_SUSPENDED_BY_IDP')
    }
    await createAuditEvent(tx, {
      action: 'member.purged',
      outcome: 'success',
      actor: { type: 'user', id: actorId },
      target: { type: 'user', id: userId },
      metadata: { reason: access.reason },
    })
    await tx.delete({ model: 'user', where: [{ field: 'id', value: userId }] })
  })
}
