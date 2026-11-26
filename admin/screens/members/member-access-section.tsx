/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember } from '@shared/admin-api'
import { StatusBadge } from '../../components/status-badge'
import { accessRefusalLabels } from './member-labels'

/** Whether the member can sign in, and when and why they were blocked. */
export const MemberAccessSection = ({ member }: { member: AdminMember }) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()
  const blockedOn = member.blocked ? formatters.date(member.blocked.at) : ''
  const blockReason = member.blocked?.reason

  return (
    <DetailField label={<Trans>Access</Trans>}>
      <div className="flex flex-col gap-2">
        <div>
          {member.access.allowed ? (
            <StatusBadge tone="success">
              <Trans>Can sign in</Trans>
            </StatusBadge>
          ) : (
            <StatusBadge tone="danger">{i18n._(accessRefusalLabels[member.access.reason])}</StatusBadge>
          )}
        </div>
        {member.blocked && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {blockReason ? (
              <Trans>
                Blocked on {blockedOn}: {blockReason}
              </Trans>
            ) : (
              <Trans>Blocked on {blockedOn}</Trans>
            )}
          </p>
        )}
      </div>
    </DetailField>
  )
}
