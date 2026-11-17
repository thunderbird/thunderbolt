/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Globe } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import type { OrgDomain } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { AddDomainEditor } from './add-domain-editor'
import { DomainEditor } from './domain-editor'
import { getDomainStatus } from './domain-rules'
import { DomainStatusBadge } from './domain-status-badge'
import { useDomains, useRemoveDomain } from './use-domains'

const newDomainId = 'new'

const DomainSubtitle = ({ domain }: { domain: OrgDomain }) => {
  switch (getDomainStatus(domain)) {
    case 'claimed': {
      const name = domain.claimedBy?.name
      return <Trans>Claimed by {name}</Trans>
    }
    case 'verified':
      return domain.enrollmentEnabled ? <Trans>Open to enrollment</Trans> : <Trans>Closed to enrollment</Trans>
    case 'unverified':
      return <Trans>Waiting for verification</Trans>
  }
}

export const DomainsPage = () => {
  const { t, i18n } = useLingui()
  const page = useResourcePageState()
  const domains = useDomains()
  // A selection that no longer matches a row (a stale link, a removed domain) opens nothing.
  const selected = domains.data?.find((domain) => domain.id === page.selectedId)
  const removing = domains.data?.find((domain) => domain.id === page.removeId)
  const remove = useRemoveDomain()
  const removingName = removing?.domain ?? ''

  const panel =
    page.selectedId === newDomainId ? (
      <AddDomainEditor
        onAdded={(domain) => page.select(domain.id)}
        onDirtyChange={(dirty) => page.patch({ dirty })}
        onClose={page.close}
      />
    ) : (
      selected && (
        <DomainEditor
          key={selected.id}
          domain={selected}
          onRemove={() => page.patch({ removeId: selected.id })}
          onClose={page.close}
        />
      )
    )

  return (
    <AdminPage
      title={t`Domains`}
      action={<PageCreateAction label={t`Add domain`} onClick={() => page.requestSelect(newDomainId)} />}
      panel={panel}
      onClose={page.close}
    >
      <p className="text-sm text-muted-foreground">
        <Trans>Verify the domains your organization owns, then decide how people on each one join.</Trans>
      </p>
      {domains.isPending && <ListSkeleton />}
      {domains.error && (
        <p role="alert" className="text-sm text-destructive">
          {i18n._(getAdminErrorMessage(domains.error))}
        </p>
      )}
      {domains.data?.length === 0 && (
        <SettingsEmptyState
          icon={<Globe className="size-6 text-muted-foreground" />}
          title={t`No domains yet`}
          description={
            <Trans>Add a domain, verify it, then let people on it join or hand it to an identity provider.</Trans>
          }
        />
      )}
      {domains.data?.map((domain) => (
        <SettingsSelectableRow
          key={domain.id}
          title={domain.domain}
          subtitle={<DomainSubtitle domain={domain} />}
          leading={
            <IconTile>
              <Globe className="size-5 text-muted-foreground" />
            </IconTile>
          }
          trailingIcon={<DomainStatusBadge domain={domain} />}
          ariaLabel={domain.domain}
          isSelected={page.selectedId === domain.id}
          onSelect={() => page.requestSelect(page.selectedId === domain.id ? null : domain.id)}
        />
      ))}
      <ResourcePageDialogs
        page={page}
        remove={{
          title: t`Remove ${removingName}?`,
          description: (
            <Trans>
              People who joined through this domain stay members. Adding it again needs a new verification record.
            </Trans>
          ),
          confirmLabel: t`Remove domain`,
          onConfirm: (id) => remove.mutateAsync(id),
        }}
      />
    </AdminPage>
  )
}
