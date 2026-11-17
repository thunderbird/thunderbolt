/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { CopyableField } from './copyable-field'

type CopyOnceSecretProps = {
  label: string
  secret: string
  /** Values to paste beside the secret, such as the SCIM base URL. */
  details?: { label: string; value: string }[]
  /** The caller drops the secret here; it is never fetched again. */
  onDone: () => void
}

/**
 * A secret the API returns once (a SCIM token), with copy buttons. Hold the secret only in component
 * state, from a mutation using `secretMutationOptions`, and drop it in `onDone`.
 */
export const CopyOnceSecret = ({ label, secret, details = [], onDone }: CopyOnceSecretProps) => {
  const { t } = useLingui()
  return (
    <section aria-label={label} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{label}</h3>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Copy it now. It's shown only once and can't be retrieved later.</Trans>
        </p>
      </div>
      <CopyableField label={label} copyLabel={t`Copy ${label}`} value={secret} />
      {details.map((detail) => (
        <div key={detail.label} className="flex flex-col gap-1">
          <span className="text-[length:var(--font-size-sm)] text-muted-foreground">{detail.label}</span>
          <CopyableField label={detail.label} copyLabel={t`Copy ${detail.label}`} value={detail.value} />
        </div>
      ))}
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          <Trans>Done</Trans>
        </Button>
      </div>
    </section>
  )
}
