/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { useFormatters } from '@/i18n/use-formatters'
import type { ScimCredential } from '@shared/admin-api'
import { StatusBadge, type StatusTone } from '../../components/status-badge'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'

const statuses: Record<ScimCredential['status'], { label: MessageDescriptor; tone: StatusTone }> = {
  active: { label: msg`Active`, tone: 'success' },
  expired: { label: msg`Expired`, tone: 'warning' },
  revoked: { label: msg`Revoked`, tone: 'neutral' },
  decommissioned: { label: msg`Retired`, tone: 'neutral' },
}

/**
 * A credential by the end of its id (every id shares the plugin's prefix): tokens are never shown
 * again, so this is how an admin tells them apart.
 */
export const shortCredentialId = (credentialId: string) => credentialId.slice(-8)

type ScimCredentialListProps = {
  credentials: ScimCredential[]
  /** Offer Revoke on active credentials. */
  onRevoke?: (credentialId: string) => void
}

/** A connection's SCIM credentials: state, expiry and last use. Never a token. */
export const ScimCredentialList = ({ credentials, onRevoke }: ScimCredentialListProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  if (credentials.length === 0) {
    return (
      <SettingsNoResults>
        <Trans>No credentials.</Trans>
      </SettingsNoResults>
    )
  }
  return (
    <ul className="flex flex-col divide-y">
      {credentials.map((credential) => {
        const status = statuses[credential.status]
        const id = shortCredentialId(credential.credentialId)
        const expires = formatters.date(credential.expiresAt)
        const created = formatters.date(credential.createdAt)
        const lastUsed = credential.lastUsedAt && formatters.relativeTime(credential.lastUsedAt)
        return (
          <li key={credential.credentialId} aria-label={t`Credential ${id}`} className="flex items-center gap-3 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <code>{id}</code>
                <StatusBadge tone={status.tone}>{i18n._(status.label)}</StatusBadge>
              </div>
              <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
                <Trans>
                  Created {created}, expires {expires}
                </Trans>
              </span>
              <span className="text-[length:var(--font-size-sm)] text-muted-foreground">
                {lastUsed ? <Trans>Last used {lastUsed}</Trans> : <Trans>Never used</Trans>}
              </span>
            </div>
            {onRevoke && credential.status === 'active' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t`Revoke credential ${id}`}
                onClick={() => onRevoke(credential.credentialId)}
              >
                <Trans>Revoke</Trans>
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
