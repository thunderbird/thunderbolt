/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import type { OrgDomain } from '@shared/admin-api'
import { ItemActionsMenu, type ItemAction } from '../../components/item-actions'
import { DomainClaimSection } from './domain-claim-section'
import { DomainEnrollmentField } from './domain-enrollment-field'
import { DomainRecordSection } from './domain-record-section'
import { DomainVerificationSection } from './domain-verification-section'

type DomainEditorProps = {
  domain: OrgDomain
  /** The domain's actions for the ⋯ menu, the same ones its row offers. */
  actions: ItemAction[]
  onClose: () => void
}

/** One domain: its DNS record, verification, enrollment and claim. Every change applies at once. */
export const DomainEditor = ({ domain, actions, onClose }: DomainEditorProps) => (
  <DetailPanel title={domain.domain} onClose={onClose} actions={<ItemActionsMenu actions={actions} />}>
    <DomainRecordSection domain={domain} />
    <DetailDivider />
    <DomainVerificationSection domain={domain} />
    <DetailDivider />
    <DomainEnrollmentField domain={domain} />
    <DetailDivider />
    <DomainClaimSection domain={domain} />
  </DetailPanel>
)
