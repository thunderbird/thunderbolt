/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useFormatters } from '@/i18n/use-formatters'
import type { Invitation } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { InlineError } from '../../components/inline-error'
import { isExpiredInvitation } from './invitation-rules'

type InvitationPanelProps = {
  invitation: Invitation
  onClose: () => void
  onRevoked: (invitation: Invitation) => void
}

/** A pending or revoked invitation: when it was sent, when its link stops working, and revoking it. */
export const InvitationPanel = ({ invitation, onClose, onRevoked }: InvitationPanelProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const revoke = useMutation({
    mutationFn: () => api.invitations.revoke(invitation.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.invitations.all })
      onRevoked(invitation)
    },
    onSettled: () => setConfirming(false),
  })
  const invitedOn = formatters.date(invitation.createdAt)
  const expiresOn = formatters.date(invitation.expiresAt)

  const status = () => {
    if (invitation.status === 'revoked') {
      return <Trans>Revoked. Its link no longer works.</Trans>
    }
    return isExpiredInvitation(invitation) ? (
      <Trans>Expired on {expiresOn}. Invite them again to send a new link.</Trans>
    ) : (
      <Trans>Waiting for them to sign in. The link works until {expiresOn}.</Trans>
    )
  }

  return (
    <DetailPanel title={invitation.email} subtitle={t`Invitation`} onClose={onClose}>
      <DetailField label={<Trans>Status</Trans>}>
        <p className="text-[length:var(--font-size-body)]">{status()}</p>
      </DetailField>
      <DetailField label={<Trans>Invited</Trans>}>
        <p className="text-[length:var(--font-size-body)]">{invitedOn}</p>
        {invitation.idpOverride && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Invited past the identity provider that claims this domain. The audit log records it.</Trans>
          </p>
        )}
      </DetailField>
      {invitation.status === 'pending' && (
        <div className="flex flex-col items-start gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Trans>Revoke invitation</Trans>
          </Button>
          <InlineError error={revoke.error} />
        </div>
      )}
      <ConfirmActionDialog
        open={confirming}
        title={t`Revoke this invitation?`}
        description={t`Its link stops working. You can invite the address again later.`}
        confirmLabel={t`Revoke invitation`}
        isPending={revoke.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => revoke.mutate()}
      />
    </DetailPanel>
  )
}
