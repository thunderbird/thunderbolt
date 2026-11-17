/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import type { OrgDomain } from '@shared/admin-api'
import { StatusBadge } from '../../components/status-badge'
import { getDomainStatus } from './domain-rules'

export const DomainStatusBadge = ({ domain }: { domain: OrgDomain }) => {
  switch (getDomainStatus(domain)) {
    case 'claimed':
      return (
        <StatusBadge tone="info">
          <Trans>Claimed</Trans>
        </StatusBadge>
      )
    case 'verified':
      return (
        <StatusBadge tone="success">
          <Trans>Verified</Trans>
        </StatusBadge>
      )
    case 'unverified':
      return (
        <StatusBadge tone="warning">
          <Trans>Unverified</Trans>
        </StatusBadge>
      )
  }
}
