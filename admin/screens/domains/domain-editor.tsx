/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Trash2 } from 'lucide-react'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { OrgDomain } from '@shared/admin-api'
import { DomainClaimSection } from './domain-claim-section'
import { DomainEnrollmentField } from './domain-enrollment-field'
import { DomainRecordSection } from './domain-record-section'
import { DomainVerificationSection } from './domain-verification-section'

type DomainEditorProps = {
  domain: OrgDomain
  onRemove: () => void
  onClose: () => void
}

/** One domain: its DNS record, verification, enrollment and claim. Every change applies at once. */
export const DomainEditor = ({ domain, onRemove, onClose }: DomainEditorProps) => (
  <DetailPanel
    title={domain.domain}
    onClose={onClose}
    actions={
      <DetailActionsMenu>
        {/* The backend refuses to remove a claimed domain; the claim section says why. */}
        <DropdownMenuItem variant="destructive" disabled={domain.claimedBy !== null} onClick={onRemove}>
          <Trash2 />
          <Trans>Remove domain</Trans>
        </DropdownMenuItem>
      </DetailActionsMenu>
    }
  >
    <DomainRecordSection domain={domain} />
    <DetailDivider />
    <DomainVerificationSection domain={domain} />
    <DetailDivider />
    <DomainEnrollmentField domain={domain} />
    <DetailDivider />
    <DomainClaimSection domain={domain} />
  </DetailPanel>
)
