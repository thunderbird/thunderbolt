/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { useFormatters } from '@/i18n/use-formatters'
import type { Invitation } from '@shared/admin-api'
import { ItemActionsMenu, type ItemAction } from '../../components/item-actions'
import { isExpiredInvitation } from './invitation-rules'

type InvitationPanelProps = {
  invitation: Invitation
  onClose: () => void
  /** The invitation's actions for the ⋯ menu, the same ones its row offers. */
  actions: ItemAction[]
}

/** A pending or revoked invitation: when it was sent and when its link stops working. */
export const InvitationPanel = ({ invitation, onClose, actions }: InvitationPanelProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const invitedOn = formatters.date(invitation.createdAt)
  const expiresOn = formatters.date(invitation.expiresAt)

  const status = () => {
    if (invitation.status === 'revoked') {
      return <Trans>Revoked</Trans>
    }
    return isExpiredInvitation(invitation) ? <Trans>Expired {expiresOn}</Trans> : <Trans>Expires {expiresOn}</Trans>
  }

  return (
    <DetailPanel
      title={invitation.email}
      subtitle={t`Invitation`}
      onClose={onClose}
      actions={<ItemActionsMenu actions={actions} />}
    >
      <DetailField label={<Trans>Status</Trans>}>
        <p className="text-base leading-snug text-foreground">{status()}</p>
      </DetailField>
      <DetailField label={<Trans>Invited</Trans>}>
        <p className="text-base leading-snug text-foreground">{invitedOn}</p>
        {invitation.idpOverride && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Identity provider override</Trans>
          </p>
        )}
      </DetailField>
    </DetailPanel>
  )
}
