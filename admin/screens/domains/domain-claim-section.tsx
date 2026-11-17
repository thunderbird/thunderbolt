/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { OrgDomain } from '@shared/admin-api'
import { getConnectionKindLabel } from './domain-rules'
import { useClaimDomain, useClaimableConnections, useReleaseDomain } from './use-domains'
import { InlineError } from '../../components/inline-error'

const hintClass = 'text-[length:var(--font-size-sm)] text-muted-foreground'

const linkClass = 'font-medium text-foreground underline underline-offset-4'

const ClaimPicker = ({ domain }: { domain: OrgDomain }) => {
  const { t, i18n } = useLingui()
  const hintId = useId()
  const connections = useClaimableConnections()
  const claim = useClaimDomain(domain.id)
  const [connectionId, setConnectionId] = useState('')
  const verified = domain.verifiedAt !== null

  if (connections.data?.length === 0) {
    return (
      <p className={hintClass}>
        <Trans>
          No identity provider can claim this domain yet.{' '}
          <Link to="/admin/identity-providers" className={linkClass}>
            Add an identity provider
          </Link>{' '}
          first.
        </Trans>
      </p>
    )
  }
  return (
    <>
      <div className="flex items-center gap-2">
        <Select value={connectionId} onValueChange={setConnectionId} disabled={!verified || !connections.data}>
          <SelectTrigger aria-label={t`Identity provider`} aria-describedby={hintId} className="min-w-0 flex-1">
            <SelectValue placeholder={t`Choose an identity provider`} />
          </SelectTrigger>
          <SelectContent>
            {connections.data?.map((connection) => {
              const kind = getConnectionKindLabel(connection)
              return (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                  {kind && <span className="text-muted-foreground">{i18n._(kind)}</span>}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={!verified || connectionId === '' || claim.isPending}
          onClick={() => claim.mutate(connectionId)}
        >
          <Trans>Claim</Trans>
        </Button>
      </div>
      <p id={hintId} className={hintClass}>
        {verified ? (
          <Trans>Claiming turns enrollment off. Releasing the claim doesn't turn it back on.</Trans>
        ) : (
          <Trans>Verify this domain before an identity provider can claim it.</Trans>
        )}
      </p>
      <InlineError error={connections.error ?? claim.error} />
    </>
  )
}

const ClaimHolder = ({ domain, claimedBy }: { domain: OrgDomain; claimedBy: NonNullable<OrgDomain['claimedBy']> }) => {
  const release = useReleaseDomain(domain.id)
  const name = claimedBy.name
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-[length:var(--font-size-sm)]">
          <Trans>
            Claimed by{' '}
            <Link to={`/admin/identity-providers?edit=${encodeURIComponent(claimedBy.id)}`} className={linkClass}>
              {name}
            </Link>
          </Trans>
        </p>
        <Button type="button" variant="outline" disabled={release.isPending} onClick={() => release.mutate()}>
          <Trans>Release claim</Trans>
        </Button>
      </div>
      <p className={hintClass}>
        <Trans>Release the claim before removing this domain.</Trans>
      </p>
      <InlineError error={release.error} />
    </>
  )
}

/** Assign the domain to an identity provider, or release it. A claim covers this exact domain only. */
export const DomainClaimSection = ({ domain }: { domain: OrgDomain }) => {
  const name = domain.domain
  return (
    <DetailField label={<Trans>Identity provider claim</Trans>} className="gap-2">
      <p className={hintClass}>
        <Trans>
          A claimed domain is closed to enrollment and to plain invitations: people on it sign in through the identity
          provider.
        </Trans>
      </p>
      {domain.claimedBy ? (
        <ClaimHolder domain={domain} claimedBy={domain.claimedBy} />
      ) : (
        <ClaimPicker domain={domain} />
      )}
      <p className={hintClass}>
        <Trans>
          A claim covers {name} only. Subdomains such as mail.{name} are never trusted automatically: add, verify and
          claim each one on its own.
        </Trans>
      </p>
    </DetailField>
  )
}
