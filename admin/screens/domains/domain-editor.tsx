/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { DetailPanel } from '@/components/detail-panel'
import type { OrgDomain } from '@shared/admin-api'
import { DomainRecordSection } from './domain-record-section'

type DomainEditorProps = {
  domain: OrgDomain
  onClose: () => void
}

export const DomainEditor = ({ domain, onClose }: DomainEditorProps) => (
  <DetailPanel title={domain.domain} onClose={onClose}>
    <DomainRecordSection domain={domain} />
  </DetailPanel>
)
