/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState, type ReactNode } from 'react'
import { DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { useAuth } from '@/contexts/auth-context'
import { useFormatters } from '@/i18n/use-formatters'
import type { LinkReview } from '@shared/admin-api'
import { type Availability, GuardedAction } from '../../components/guarded-action'
import { StatusBadge } from '../../components/status-badge'
import { LinkReviewConfirmDialog } from './link-review-confirm-dialog'
import { linkReviewStatusLabels, linkReviewStatusTones, linkReviewTriggerLabels } from './link-review-labels'
import { type LinkReviewDecision, useLinkReviewDecision } from './use-link-review-decision'

const ownAccount: Availability = {
  available: false,
  reason: msg`This is your own account, so another admin has to approve the link.`,
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-[length:var(--font-size-sm)] text-muted-foreground">{label}</dt>
    <dd className="break-words">{children}</dd>
  </div>
)

const Identity = ({ title, children }: { title: string; children: ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-3">
    <DetailSectionTitle>{title}</DetailSectionTitle>
    <dl className="flex flex-col gap-3">{children}</dl>
  </section>
)

type LinkReviewPanelProps = {
  review: LinkReview
  onClose: () => void
  /** After a decision went through; the review has left or moved in the list. */
  onDecided: () => void
}

/** One review: the identity that arrived and the existing account it would link to, and the decision. */
export const LinkReviewPanel = ({ review, onClose, onDecided }: LinkReviewPanelProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const currentUserId = useAuth().useSession().data?.user.id
  const [confirming, setConfirming] = useState<LinkReviewDecision | null>(null)
  const decision = useLinkReviewDecision({
    onDecided: () => {
      setConfirming(null)
      onDecided()
    },
  })

  // The server refuses both an admin's own link (LINK_REVIEW_SELF) and a second decision.
  const isOwnAccount = review.candidateUserId === currentUserId
  const canApprove = review.status === 'pending' || review.status === 'rejected'
  const canReject = review.status === 'pending'

  const decidedAt = review.resolvedAt && formatters.relativeTime(review.resolvedAt)

  const cancel = () => {
    decision.reset()
    setConfirming(null)
  }

  return (
    <DetailPanel title={review.incomingEmail} subtitle={review.connection.name} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={linkReviewStatusTones[review.status]}>
          {i18n._(linkReviewStatusLabels[review.status])}
        </StatusBadge>
        {decidedAt && (
          <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Decided {decidedAt}</Trans>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Identity title={t`Incoming identity`}>
          <Fact label={t`Name`}>{review.incomingName || <span className="text-muted-foreground">—</span>}</Fact>
          <Fact label={t`Email`}>{review.incomingEmail}</Fact>
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
        </Identity>
        <Identity title={t`Existing account`}>
          <Fact label={t`Name`}>{review.candidate.name || <span className="text-muted-foreground">—</span>}</Fact>
          <Fact label={t`Email`}>{review.candidate.email}</Fact>
        </Identity>
      </div>

      {(canApprove || canReject) && (
        <FormFooter>
          {canReject && (
            <Button type="button" variant="outline" onClick={() => setConfirming('reject')}>
              <Trans>Reject</Trans>
            </Button>
          )}
          {canApprove && (
            <GuardedAction
              variant="default"
              size="default"
              availability={isOwnAccount ? ownAccount : { available: true }}
              onClick={() => setConfirming('approve')}
            >
              <Trans>Approve</Trans>
            </GuardedAction>
          )}
        </FormFooter>
      )}

      <LinkReviewConfirmDialog
        review={review}
        decision={confirming}
        isPending={decision.isPending}
        error={decision.error}
        onConfirm={(choice) => decision.mutate({ reviewId: review.id, decision: choice })}
        onCancel={cancel}
      />
    </DetailPanel>
  )
}
