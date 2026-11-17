/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Link2 } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useFormatters } from '@/i18n/use-formatters'
import { getAdminErrorMessage } from '../../api/error-messages'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { PanelSections } from '../../components/panel-sections'
import { StatusBadge } from '../../components/status-badge'
import { linkReviewStatusLabels, linkReviewStatusTones } from './link-review-labels'
import { LinkReviewPanel } from './link-review-panel'
import { linkReviewStatuses, useLinkReviewsPageState } from './use-link-reviews-page-state'

// Radix Select can't hold an empty value.
const allConnections = 'all'

/** Identities waiting for an admin to link them to an existing account, and the decided ones. */
export const LinkReviewsPage = () => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const state = useLinkReviewsPageState()
  const { page, reviews, selected } = state

  const list = () => {
    if (reviews.isLoading) {
      return <ListSkeleton />
    }
    if (reviews.error && reviews.items.length === 0) {
      return (
        <p role="alert" className="text-destructive">
          {i18n._(getAdminErrorMessage(reviews.error))}
        </p>
      )
    }
    if (reviews.isEmpty) {
      return (
        <SettingsNoResults>
          {state.status === 'pending' ? <Trans>No links are waiting for review.</Trans> : <Trans>No reviews.</Trans>}
        </SettingsNoResults>
      )
    }
    return (
      <>
        {reviews.items.map((review) => {
          const connection = review.connection.name
          const lastSeen = formatters.relativeTime(review.lastSeenAt)
          return (
            <SettingsSelectableRow
              key={review.id}
              ariaLabel={review.incomingEmail}
              isSelected={page.selectedId === review.id}
              onSelect={() => page.requestSelect(page.selectedId === review.id ? null : review.id)}
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
                  {state.status !== review.status && (
                    <StatusBadge tone={linkReviewStatusTones[review.status]}>
                      {i18n._(linkReviewStatusLabels[review.status])}
                    </StatusBadge>
                  )}
                </span>
              }
            />
          )
        })}
        {reviews.error && (
          <p role="alert" className="text-destructive">
            {i18n._(getAdminErrorMessage(reviews.error))}
          </p>
        )}
        <LoadMoreFooter hasMore={reviews.hasMore} isLoading={reviews.isLoadingMore} onLoadMore={reviews.loadMore} />
      </>
    )
  }

  return (
    <AdminPage
      title={t`Link reviews`}
      onClose={page.close}
      panel={
        selected && (
          <LinkReviewPanel
            key={selected.id}
            review={selected}
            onClose={page.close}
            onDecided={() => page.select(null)}
          />
        )
      }
    >
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>
          These identities arrived from an identity provider with the email of an existing account, and no automatic
          rule could link them. Approve to link one to that account.
        </Trans>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <PanelSections
          label={t`Status`}
          value={state.status}
          onChange={state.setStatus}
          sections={linkReviewStatuses.map((status) => ({ id: status, label: i18n._(linkReviewStatusLabels[status]) }))}
        />
        <Select
          value={state.connectionId ?? allConnections}
          onValueChange={(value) => state.setConnectionId(value === allConnections ? undefined : value)}
        >
          <SelectTrigger aria-label={t`Identity provider`} className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={allConnections}>{t`All identity providers`}</SelectItem>
            {state.connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {list()}
    </AdminPage>
  )
}
