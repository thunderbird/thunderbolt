/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { membershipSourceKinds } from '@/db/schema'
import type { AuthAdapter, MembershipRow } from './access'
import { createAuditEvent } from './audit/write'
import { getCurrentOrganizationId } from './current-organization'

/** How a member got in: one `membership_source` row. */
export type Admission = {
  kind: (typeof membershipSourceKinds)[number]
  ref?: string | null
  identityConnectionId?: string | null
}

/** Create a membership with its first source, and record the admission. */
export const createMembership = async (adapter: AuthAdapter, userId: string, admission: Admission) => {
  const orgId = getCurrentOrganizationId()
  const membership = await adapter.create<Record<string, unknown>, MembershipRow>({
    model: 'orgMembership',
    data: { orgId, userId },
  })
  await addMembershipSource(adapter, membership.id, admission)
  await createAuditEvent(adapter, {
    action: 'member.admitted',
    outcome: 'success',
    actor: { type: 'user', id: userId },
    target: { type: 'user', id: userId },
    connectionId: admission.identityConnectionId ?? null,
    metadata: { kind: admission.kind },
  })
  return membership
}

/** Add a source to an existing membership. */
export const addMembershipSource = (adapter: AuthAdapter, membershipId: string, admission: Admission) =>
  adapter.create({
    model: 'membershipSource',
    data: {
      orgId: getCurrentOrganizationId(),
      membershipId,
      kind: admission.kind,
      ref: admission.ref ?? null,
      identityConnectionId: admission.identityConnectionId ?? null,
    },
  })
