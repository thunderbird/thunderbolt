/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Check, ChevronDown } from 'lucide-react'
import { useFormatters } from '@/i18n/use-formatters'
import type { AttestationEvidence } from '@/attestation/types'

const checkLabels = {
  hardware: msg`Hardware attestation`,
  code: msg`Signed build provenance`,
  measurement: msg`Matching measurements`,
  channel: msg`Enclave-bound encryption key`,
  policy: msg`Verified deployment policy`,
}
const detailLabels = {
  source: msg`Source repository`,
  release: msg`Release digest`,
  measurement: msg`Enclave measurement`,
  manifest: msg`Deployment manifest digest`,
  policy: msg`Deployment policy hashes`,
}

/** Progressive disclosure keeps measurements accessible without making the panel an audit log. */
export const AttestationDetails = ({ evidence, hour12 }: { evidence: AttestationEvidence; hour12: boolean }) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()

  return (
    <>
      <ul className="space-y-2.5 py-1">
        {evidence.checks.map((check) => (
          <li key={check} className="flex items-center gap-2.5 text-[length:var(--font-size-sm)]">
            <Check aria-hidden="true" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {i18n._(checkLabels[check])}
          </li>
        ))}
      </ul>
      <details className="group border-t pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-md text-[length:var(--font-size-xs)] text-muted-foreground hover:text-foreground focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <Trans>Connection details</Trans>
          <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <dl className="mt-3 space-y-3 text-[length:var(--font-size-xs)]">
          <div>
            <dt className="text-muted-foreground">
              <Trans>Verified on this device</Trans>
            </dt>
            <dd className="mt-1">
              <time dateTime={new Date(evidence.verifiedAt).toISOString()}>
                {formatters.date(evidence.verifiedAt)} · {formatters.time(evidence.verifiedAt, { hour12 })}
              </time>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              <Trans>Enclave endpoint</Trans>
            </dt>
            <dd className="mt-1 break-all font-mono select-text">{evidence.endpoint}</dd>
          </div>
          {evidence.details.map((detail) => (
            <div key={detail.label}>
              <dt className="text-muted-foreground">{i18n._(detailLabels[detail.label])}</dt>
              <dd className="mt-1 break-all whitespace-pre-line font-mono select-text">{detail.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  )
}
