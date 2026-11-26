/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Ban, Check, LockOpen, SquarePen, Trash2, X } from 'lucide-react'
import type { AdminMember, Invitation, LinkReview } from '@shared/admin-api'
import type { ItemAction } from '../../components/item-actions'
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { invitationEditId } from './invitation-rules'
import { getBlockState, getPurgeState, type ConnectionStatusById } from './member-rules'
import type { LinkReviewDecision } from './use-link-review-decision'

type MemberActionContext = {
  page: ResourcePageState
  selfId: string | null
  connectionStatusById: ConnectionStatusById
  onBlock: (member: AdminMember) => void
  onUnblock: (member: AdminMember) => void
}

/**
 * What an admin can do to a member, in their row's right-click menu and their panel's ⋯ menu:
 * edit; block or unblock (never yourself); and delete permanently once they've lost access,
 * disabled while their identity provider could still reactivate them.
 */
export const memberActions = (member: AdminMember, context: MemberActionContext): ItemAction[] => {
  const purgeState = getPurgeState(member, context.connectionStatusById)
  const canBlock = getBlockState(member, context.selfId).available
  return [
    { id: 'edit', label: <Trans>Edit</Trans>, icon: SquarePen, onSelect: () => context.page.edit(member.userId) },
    ...(member.blocked
      ? [{ id: 'unblock', label: <Trans>Unblock</Trans>, icon: LockOpen, onSelect: () => context.onUnblock(member) }]
      : canBlock
        ? [{ id: 'block', label: <Trans>Block</Trans>, icon: Ban, onSelect: () => context.onBlock(member) }]
        : []),
    ...(purgeState
      ? [
          {
            id: 'purge',
            label: <Trans>Delete</Trans>,
            icon: Trash2,
            disabled: !purgeState.available,
            onSelect: () => context.page.patch({ removeId: member.userId }),
          },
        ]
      : []),
  ]
}

/** What an admin can do to an invitation: revoke it while it's pending. */
export const invitationActions = (invitation: Invitation, page: ResourcePageState): ItemAction[] =>
  invitation.status === 'pending'
    ? [
        {
          id: 'revoke',
          label: <Trans>Revoke</Trans>,
          icon: Ban,
          onSelect: () => page.patch({ removeId: invitationEditId(invitation.id) }),
        },
      ]
    : []

/**
 * What an admin can do to a link review: approve it while it's pending or rejected (approving undoes a
 * rejection), never for their own account; reject it while it's pending.
 */
export const linkReviewActions = (
  review: LinkReview,
  { selfId, onDecide }: { selfId: string | null; onDecide: (decision: LinkReviewDecision) => void },
): ItemAction[] => [
  ...(review.status === 'pending' || review.status === 'rejected'
    ? [
        {
          id: 'approve',
          label: <Trans>Approve</Trans>,
          icon: Check,
          disabled: review.candidateUserId === selfId,
          onSelect: () => onDecide('approve'),
        },
      ]
    : []),
  ...(review.status === 'pending'
    ? [{ id: 'reject', label: <Trans>Reject</Trans>, icon: X, onSelect: () => onDecide('reject') }]
    : []),
]
