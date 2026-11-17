/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useFormatters } from '@/i18n/use-formatters'
import type { OrgDomain } from '@shared/admin-api'
import { getDomainCheckErrorMessage } from './domain-rules'
import { DomainStatusBadge } from './domain-status-badge'
import { useVerifyDomain } from './use-domains'
import { InlineError } from '../../components/inline-error'

/** The domain's status, the last DNS check and why it failed, and the button that checks again. */
export const DomainVerificationSection = ({ domain }: { domain: OrgDomain }) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()
  const verify = useVerifyDomain(domain.id)
  const checkError = domain.lastCheckError
  const reason = checkError && getDomainCheckErrorMessage(checkError)
  const lastChecked = domain.lastCheckedAt && formatters.relativeTime(domain.lastCheckedAt)

  return (
    <DetailField label={<Trans>Verification</Trans>}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <DomainStatusBadge domain={domain} />
          <span className="truncate text-[length:var(--font-size-sm)] text-muted-foreground">
            {lastChecked ? <Trans>Last checked {lastChecked}</Trans> : <Trans>Not checked yet</Trans>}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
          {verify.isPending ? (
            <Trans>Checking…</Trans>
          ) : domain.verifiedAt ? (
            <Trans>Check again</Trans>
          ) : (
            <Trans>Verify</Trans>
          )}
        </Button>
      </div>
      {checkError && (
        <Alert variant="destructive" className="mt-2">
          <AlertTitle>
            <Trans>The last check failed</Trans>
          </AlertTitle>
          <AlertDescription>{reason ? i18n._(reason) : checkError}</AlertDescription>
        </Alert>
      )}
      <InlineError error={verify.error} className="mt-2" />
    </DetailField>
  )
}
