/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember } from '@shared/admin-api'

/** The join date. The panel's header names the member and what their identity provider manages. */
export const MemberProfileSection = ({ member }: { member: AdminMember }) => {
  const formatters = useFormatters()
  return (
    <DetailField label={<Trans>Joined</Trans>}>
      <p className="text-base leading-snug text-foreground">{formatters.date(member.joinedAt)}</p>
    </DetailField>
  )
}
