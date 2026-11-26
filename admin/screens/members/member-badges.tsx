/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import type { AdminMember, Invitation, LinkReview } from '@shared/admin-api'
import { StatusBadge } from '../../components/status-badge'
import { isExpiredInvitation } from './invitation-rules'
import { isAdmin } from './member-rules'

/** A member row's badges: Admin, and Blocked or No access. */
export const MemberBadges = ({ member }: { member: AdminMember }) => (
  <span className="flex flex-wrap items-center gap-1.5">
    {isAdmin(member) && (
      <StatusBadge tone="info">
        <Trans>Admin</Trans>
      </StatusBadge>
    )}
    {member.blocked ? (
      <StatusBadge tone="danger">
        <Trans>Blocked</Trans>
      </StatusBadge>
    ) : (
      !member.access.allowed && (
        <StatusBadge tone="warning">
          <Trans>No access</Trans>
        </StatusBadge>
      )
    )}
  </span>
)

/** An invitation row's badge: Invited, Expired or Revoked. Accepted ones aren't listed. */
export const InvitationBadge = ({ invitation }: { invitation: Invitation }) => {
  if (invitation.status === 'revoked') {
    return (
      <StatusBadge tone="neutral">
        <Trans>Revoked</Trans>
      </StatusBadge>
    )
  }
  return isExpiredInvitation(invitation) ? (
    <StatusBadge tone="warning">
      <Trans>Expired</Trans>
    </StatusBadge>
  ) : (
    <StatusBadge tone="neutral">
      <Trans>Invited</Trans>
    </StatusBadge>
  )
}

/** A link review row's badge: Review pending, or Rejected. Decided ones leave the list. */
export const LinkReviewBadge = ({ review }: { review: LinkReview }) =>
  review.status === 'rejected' ? (
    <StatusBadge tone="danger">
      <Trans>Rejected</Trans>
    </StatusBadge>
  ) : (
    <StatusBadge tone="warning">
      <Trans>Review pending</Trans>
    </StatusBadge>
  )
