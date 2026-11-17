/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import type { LinkReview } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import type { LinkReviewDecision } from './use-link-review-decision'

type LinkReviewConfirmDialogProps = {
  review: LinkReview
  decision: LinkReviewDecision | null
  isPending: boolean
  error: unknown
  onConfirm: (decision: LinkReviewDecision) => void
  onCancel: () => void
}

/** Confirms a decision, naming both identities. Stays open with the error when the decision fails. */
export const LinkReviewConfirmDialog = ({
  review,
  decision,
  isPending,
  error,
  onConfirm,
  onCancel,
}: LinkReviewConfirmDialogProps) => {
  const { t, i18n } = useLingui()
  const incoming = review.incomingEmail
  const subject = review.externalId
  const connection = review.connection.name
  const existing = review.candidate.email
  const isApprove = decision === 'approve'

  return (
    <ConfirmActionDialog
      open={decision !== null}
      title={isApprove ? t`Approve this link?` : t`Reject this link?`}
      description={
        <>
          {isApprove ? (
            <Trans>
              {incoming} (subject <code>{subject}</code>) from {connection} will be linked to the existing account{' '}
              {existing}. The next sign-in or provisioning attempt from this connection attaches to that account.
            </Trans>
          ) : (
            <Trans>
              {incoming} (subject <code>{subject}</code>) from {connection} stays unlinked from {existing}, and is
              refused until an admin approves the link.
            </Trans>
          )}
          {error !== null && (
            <span role="alert" className="mt-2 block text-destructive">
              {i18n._(getAdminErrorMessage(error))}
            </span>
          )}
        </>
      }
      confirmLabel={isApprove ? t`Approve` : t`Reject`}
      confirmVariant={isApprove ? 'default' : 'destructive'}
      isPending={isPending}
      onConfirm={() => decision && onConfirm(decision)}
      onCancel={onCancel}
    />
  )
}
