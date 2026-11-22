/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { Invitation } from '@shared/admin-api'

/** The backend leaves an unused invitation pending past its expiry, but its link no longer works. */
export const isExpiredInvitation = (invitation: Invitation, now = Date.now()) =>
  invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= now

const invitationEditPrefix = 'invite:'

/** The `?edit=` value that opens an invitation's panel on Members; member ids never carry the prefix. */
export const invitationEditId = (invitationId: string) => `${invitationEditPrefix}${invitationId}`

/** The invitation id an `?edit=` value opens, or null for a member or the invite form. */
export const parseInvitationEditId = (editId: string | null) =>
  editId?.startsWith(invitationEditPrefix) ? editId.slice(invitationEditPrefix.length) : null
