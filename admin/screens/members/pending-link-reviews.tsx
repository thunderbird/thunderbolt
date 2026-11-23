/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Link2 } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { useFormatters } from '@/i18n/use-formatters'
import type { LinkReview } from '@shared/admin-api'
import type { CursorList } from '../../api/use-cursor-list'
import { AdminSection } from '../../components/admin-section'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { StatusBadge } from '../../components/status-badge'
import { linkReviewStatusLabels, linkReviewStatusTones } from './link-review-labels'
import { linkReviewEditId } from './link-review-rules'

type PendingLinkReviewsProps = {
  reviews: CursorList<LinkReview>
  /** The rejected reviews, when the admin asked for them; approving one undoes the rejection. */
  rejected: CursorList<LinkReview> | null
  selectedId: string | null
  /** Open a review's panel, or close it when it's the one open. */
  onSelect: (editId: string | null) => void
}

/**
 * The identities waiting for an admin to link them, and the rejected ones when asked for: a section
 * above the invitations and members.
 */
export const PendingLinkReviews = ({ reviews, rejected, selectedId, onSelect }: PendingLinkReviewsProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const count = reviews.items.length
  const rejectedCount = rejected?.items.length ?? 0

  const row = (review: LinkReview) => {
    const editId = linkReviewEditId(review.id)
    const connection = review.connection.name
    const lastSeen = formatters.relativeTime(review.lastSeenAt)
    return (
      <SettingsSelectableRow
        key={review.id}
        ariaLabel={review.incomingEmail}
        isSelected={selectedId === editId}
        onSelect={() => onSelect(selectedId === editId ? null : editId)}
        leading={
          <IconTile>
            <Link2 className="size-5 text-muted-foreground" />
          </IconTile>
        }
        title={review.incomingEmail}
        subtitle={t`${connection}, ${lastSeen}`}
        trailing={
          <span className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-muted-foreground">
            {review.attempts > 1 && <Plural value={review.attempts} one="# attempt" other="# attempts" />}
            {review.status !== 'pending' && (
              <StatusBadge tone={linkReviewStatusTones[review.status]}>
                {i18n._(linkReviewStatusLabels[review.status])}
              </StatusBadge>
            )}
          </span>
        }
      />
    )
  }

  const countLabel = reviews.hasMore ? `${formatters.number(count)}+` : formatters.number(count)

  return (
    <AdminSection
      title={<Trans>Waiting to be linked</Trans>}
      description={
        <Trans>
          Arrived from an identity provider with the email of an existing account. Approve to link one to that account.
        </Trans>
      }
      summary={
        <>
          {count > 0 && <StatusBadge tone="neutral">{countLabel}</StatusBadge>}
          {rejectedCount > 0 && (
            <StatusBadge tone="danger">
              <Plural value={rejectedCount} one="# rejected" other="# rejected" />
            </StatusBadge>
          )}
        </>
      }
    >
      {reviews.isLoading && <ListSkeleton />}
      {reviews.isEmpty && rejectedCount === 0 && (
        <SettingsEmptyState
          icon={<Link2 className="size-10 text-muted-foreground" />}
          title={t`Nothing waiting to be linked`}
          description={t`When an identity provider sends someone with the email of an existing account and no rule can link them, they wait here for you.`}
        />
      )}
      {reviews.items.map(row)}
      <LoadMoreFooter hasMore={reviews.hasMore} isLoading={reviews.isLoadingMore} onLoadMore={reviews.loadMore} />
      {rejected?.items.map(row)}
      {rejected && (
        <LoadMoreFooter hasMore={rejected.hasMore} isLoading={rejected.isLoadingMore} onLoadMore={rejected.loadMore} />
      )}
    </AdminSection>
  )
}
