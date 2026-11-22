/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import type { OrgDomain } from '@shared/admin-api'
import { CopyableField } from '../../components/copyable-field'

/** The TXT record that proves the org controls the domain. */
export const DomainRecordSection = ({ domain }: { domain: OrgDomain }) => {
  const { t } = useLingui()
  return (
    <DetailField label={<Trans>DNS record</Trans>}>
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>Add this TXT record at your DNS provider, then verify the domain.</Trans>
      </p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[length:var(--font-size-sm)]">
        <dt className="text-muted-foreground">
          <Trans>Type</Trans>
        </dt>
        <dd className="font-mono">TXT</dd>
        <dt className="text-muted-foreground">
          <Trans>Name</Trans>
        </dt>
        <dd className="min-w-0">
          <CopyableField label={t`Record name`} copyLabel={t`Copy record name`} value={domain.record.name} />
        </dd>
        <dt className="text-muted-foreground">
          <Trans>Value</Trans>
        </dt>
        <dd className="min-w-0">
          <CopyableField label={t`Record value`} copyLabel={t`Copy record value`} value={domain.record.value} />
        </dd>
      </dl>
    </DetailField>
  )
}
