/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { useFormatters } from '@/i18n/use-formatters'
import type { LinkReview } from '@shared/admin-api'
import { ItemActionsMenu, type ItemAction } from '../../components/item-actions'
import { linkReviewStatusLabels, linkReviewTriggerLabels } from './link-review-labels'

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <DetailField label={label}>
    <p className="break-words text-base leading-snug text-foreground">{children}</p>
  </DetailField>
)

type LinkReviewPanelProps = {
  review: LinkReview
  /** The review is for the signed-in admin's own account, which only another admin may approve. */
  isOwnAccount: boolean
  /** Approve and reject, the same actions the review's row offers. */
  actions: ItemAction[]
  onClose: () => void
}

/** One review, read-only: the identity that arrived and the existing account it would link to. */
export const LinkReviewPanel = ({ review, isOwnAccount, actions, onClose }: LinkReviewPanelProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const status = i18n._(linkReviewStatusLabels[review.status])
  const decidedAt = review.resolvedAt && formatters.relativeTime(review.resolvedAt)

  return (
    <DetailPanel
      title={review.incomingEmail}
      subtitle={decidedAt ? t`${status} · Decided ${decidedAt}` : status}
      actions={<ItemActionsMenu actions={actions} />}
      onClose={onClose}
    >
      {isOwnAccount && review.status !== 'approved' && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Another admin has to approve your own link.</Trans>
        </p>
      )}
      <Fact label={t`Name`}>{review.incomingName || '—'}</Fact>
      <Fact label={t`Subject`}>
        <code className="break-all">{review.externalId}</code>
      </Fact>
      <Fact label={t`Identity provider`}>{review.connection.name}</Fact>
      <Fact label={t`Arrived through`}>{i18n._(linkReviewTriggerLabels[review.trigger])}</Fact>
      <Fact label={t`Attempts`}>
        <Plural value={review.attempts} one="# attempt" other="# attempts" />
      </Fact>
      <Fact label={t`First seen`}>{formatters.date(review.createdAt)}</Fact>
      <Fact label={t`Last seen`}>{formatters.relativeTime(review.lastSeenAt)}</Fact>
      <DetailDivider />
      <DetailField label={t`Existing account`}>
        <p className="break-words text-base leading-snug text-foreground">{review.candidate.name || '—'}</p>
        <p className="break-words text-base leading-snug text-foreground">{review.candidate.email}</p>
      </DetailField>
    </DetailPanel>
  )
}
