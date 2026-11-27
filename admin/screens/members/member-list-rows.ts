/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminMember, Invitation, LinkReview } from '@shared/admin-api'
import { invitationEditId } from './invitation-rules'
import { linkReviewEditId } from './link-review-rules'

/** One row of the Members list, keyed by the selection id that opens its panel. */
export type MemberListRow =
  | { kind: 'review'; key: string; review: LinkReview }
  | { kind: 'invitation'; key: string; invitation: Invitation }
  | { kind: 'member'; key: string; member: AdminMember }

/** The paging of one cursor list in the chain. */
type SegmentPaging = { hasMore: boolean; isLoadingMore: boolean; loadMore: () => void }

/** One cursor list's rows, as a link in the chain. */
export type ListSegment = { rows: MemberListRow[]; list: SegmentPaging }

/** Link reviews as list rows, keyed by their selection id. */
export const reviewRows = (reviews: LinkReview[]): MemberListRow[] =>
  reviews.map((review) => ({ kind: 'review', key: linkReviewEditId(review.id), review }))

/** Invitations as list rows, keyed by their selection id. */
export const invitationRows = (invitations: Invitation[]): MemberListRow[] =>
  invitations.map((invitation) => ({ kind: 'invitation', key: invitationEditId(invitation.id), invitation }))

/** Members as list rows, keyed by user id. */
export const memberRows = (members: AdminMember[]): MemberListRow[] =>
  members.map((member) => ({ kind: 'member', key: member.userId, member }))

/**
 * Several cursor lists as one list with one "Load more". The rows run segment by segment, up to and
 * including the first segment with pages left, and "Load more" loads that segment's next page, so
 * no row ever lands above one already shown.
 */
export const chainSegments = (segments: ListSegment[]) => {
  const openIndex = segments.findIndex((segment) => segment.list.hasMore)
  const shown = openIndex === -1 ? segments : segments.slice(0, openIndex + 1)
  const open = openIndex === -1 ? undefined : segments[openIndex].list
  return {
    rows: shown.flatMap((segment) => segment.rows),
    hasMore: open !== undefined,
    isLoadingMore: open?.isLoadingMore ?? false,
    loadMore: () => open?.loadMore(),
  }
}

/**
 * `items` without any that also sit in `newer`. An item that just moved (a revoke, a rejection, an
 * expiry) can be in both lists while they refetch; the copy in the later list is the newer one.
 */
export const withoutIds = <T extends { id: string }>(items: T[], ...newer: { id: string }[][]): T[] => {
  const newerIds = new Set(newer.flat().map((item) => item.id))
  return items.filter((item) => !newerIds.has(item.id))
}
