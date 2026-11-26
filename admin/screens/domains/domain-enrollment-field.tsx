/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { useId } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { OrgDomain } from '@shared/admin-api'
import { getEnrollmentLock } from './domain-rules'
import { useSetDomainEnrollment } from './use-domains'
import { InlineError } from '../../components/inline-error'

const EnrollmentLockReason = ({ domain }: { domain: OrgDomain }) => {
  if (getEnrollmentLock(domain) === 'unverified') {
    return <Trans>Verify this domain before opening it to enrollment.</Trans>
  }
  const name = domain.claimedBy?.name
  return <Trans>Claimed by {name}. Release the claim to open enrollment.</Trans>
}

/** The switch that lets anyone with a verified email on the domain join, and why it's locked. */
export const DomainEnrollmentField = ({ domain }: { domain: OrgDomain }) => {
  const switchId = useId()
  const descriptionId = useId()
  const reasonId = useId()
  const setEnrollment = useSetDomainEnrollment(domain.id)
  const lock = getEnrollmentLock(domain)

  return (
    <DetailField label={<Trans>Enrollment</Trans>} className="gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={switchId}>
            <Trans>Open to enrollment</Trans>
          </Label>
          <p id={descriptionId} className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>Anyone with a verified email on this domain can join as a member.</Trans>
          </p>
        </div>
        <Switch
          id={switchId}
          aria-describedby={lock ? `${descriptionId} ${reasonId}` : descriptionId}
          checked={domain.enrollmentEnabled}
          disabled={lock !== null || setEnrollment.isPending}
          onCheckedChange={(enabled) => setEnrollment.mutate(enabled)}
        />
      </div>
      {lock && (
        <p id={reasonId} className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <EnrollmentLockReason domain={domain} />
        </p>
      )}
      <InlineError error={setEnrollment.error} />
    </DetailField>
  )
}
