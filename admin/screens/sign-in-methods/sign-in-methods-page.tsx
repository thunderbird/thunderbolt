/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Globe, KeyRound } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useActiveLocale } from '@/i18n/use-active-locale'
import type { AdminConnection, OrgDomain } from '@shared/admin-api'
import { useConnections } from '../../api/use-connections'
import { AdminPage } from '../../components/admin-page'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { AddDomainEditor } from '../domains/add-domain-editor'
import { DomainEditor } from '../domains/domain-editor'
import { getDomainStatus } from '../domains/domain-rules'
import { DomainStatusBadge } from '../domains/domain-status-badge'
import { useDomains, useRemoveDomain } from '../domains/use-domains'
import { ConnectionEditor } from '../identity-providers/connection-editor'
import { connectionBadge, envOwnedLabel, scimLabels, ssoLabels } from '../identity-providers/connection-labels'
import { describeConnection } from '../identity-providers/connection-status'
import { NewConnectionEditor } from '../identity-providers/new-connection-editor'
import { useRetireConnection } from '../identity-providers/use-connection-queries'
import {
  connectionEditId,
  domainEditId,
  newDomainId,
  newSignInMethodId,
  parseSignInMethodId,
} from './sign-in-method-ids'

type SignInMethod = { kind: 'connection'; connection: AdminConnection } | { kind: 'domain'; domain: OrgDomain }

const methodName = (method: SignInMethod) =>
  method.kind === 'connection' ? method.connection.name : method.domain.domain

const ConnectionCard = ({
  connection,
  isSelected,
  onSelect,
}: {
  connection: AdminConnection
  isSelected: boolean
  onSelect: () => void
}) => {
  const { i18n } = useLingui()
  const summary = describeConnection(connection)
  const badge = connectionBadge(summary)
  const parts = [
    summary.sso && i18n._(ssoLabels[summary.sso.protocol]),
    summary.sso?.envOwned && i18n._(envOwnedLabel),
    summary.scim && i18n._(scimLabels[summary.scim]),
    ...connection.claimedDomains,
  ].filter(Boolean)
  return (
    <SettingsSelectableRow
      title={connection.name}
      subtitle={parts.join(' · ')}
      leading={
        <IconTile>
          <KeyRound className="size-5 text-muted-foreground" />
        </IconTile>
      }
      trailingIcon={<StatusBadge tone={badge.tone}>{i18n._(badge.label)}</StatusBadge>}
      ariaLabel={connection.name}
      isSelected={isSelected}
      isDimmed={summary.retired}
      onSelect={onSelect}
    />
  )
}

const DomainSubtitle = ({ domain }: { domain: OrgDomain }) => {
  switch (getDomainStatus(domain)) {
    case 'claimed': {
      const name = domain.claimedBy?.name
      return <Trans>Domain · Signs people in through {name}</Trans>
    }
    case 'verified':
      return domain.enrollmentEnabled ? (
        <Trans>Domain · Open to enrollment</Trans>
      ) : (
        <Trans>Domain · Closed to enrollment</Trans>
      )
    case 'unverified':
      return <Trans>Domain · Waiting for verification</Trans>
  }
}

const DomainCard = ({
  domain,
  isSelected,
  onSelect,
}: {
  domain: OrgDomain
  isSelected: boolean
  onSelect: () => void
}) => (
  <SettingsSelectableRow
    title={domain.domain}
    subtitle={<DomainSubtitle domain={domain} />}
    leading={
      <IconTile>
        <Globe className="size-5 text-muted-foreground" />
      </IconTile>
    }
    trailingIcon={<DomainStatusBadge domain={domain} />}
    ariaLabel={domain.domain}
    isSelected={isSelected}
    onSelect={onSelect}
  />
)

/**
 * Every way people get into the org, in one list by name: identity provider connections (sign-in and
 * provisioning) and the domains the org owns. Each opens its own editor in the side panel.
 */
export const SignInMethodsPage = () => {
  const { t } = useLingui()
  const locale = useActiveLocale()
  const page = useResourcePageState()
  const connections = useConnections()
  const domains = useDomains()
  const retire = useRetireConnection()
  const remove = useRemoveDomain()

  const methods: SignInMethod[] = [
    ...(connections.data ?? []).map((connection) => ({ kind: 'connection' as const, connection })),
    ...(domains.data ?? []).map((domain) => ({ kind: 'domain' as const, domain })),
  ].sort((a, b) => methodName(a).localeCompare(methodName(b), locale))

  const selected = parseSignInMethodId(page.selectedId)
  // A selection that no longer matches a domain (a stale link, a removed domain) opens nothing.
  const selectedDomain = selected?.kind === 'domain' ? domains.data?.find((domain) => domain.id === selected.id) : null
  const removing = parseSignInMethodId(page.removeId)
  const removingDomain = removing?.kind === 'domain' ? domains.data?.find((domain) => domain.id === removing.id) : null
  const removingName = removingDomain?.domain ?? ''

  const panel = () => {
    if (page.selectedId === newSignInMethodId) {
      return (
        <NewConnectionEditor
          onClose={page.close}
          onAddDomain={() => page.select(newDomainId)}
          onCreated={(connectionId) => page.select(connectionEditId(connectionId))}
          onDirty={(dirty) => page.patch({ dirty })}
        />
      )
    }
    if (page.selectedId === newDomainId) {
      return (
        <AddDomainEditor
          onAdded={(domain) => page.select(domainEditId(domain.id))}
          onDirtyChange={(dirty) => page.patch({ dirty })}
          onClose={page.close}
        />
      )
    }
    if (selected?.kind === 'connection') {
      return <ConnectionEditor key={selected.id} connectionId={selected.id} page={page} />
    }
    if (selectedDomain) {
      return (
        <DomainEditor
          key={selectedDomain.id}
          domain={selectedDomain}
          onRemove={() => page.patch({ removeId: domainEditId(selectedDomain.id) })}
          onClose={page.close}
        />
      )
    }
    return null
  }

  const body = () => {
    if (connections.isPending || domains.isPending) {
      return <ListSkeleton />
    }
    if (connections.error || domains.error) {
      return <InlineError error={connections.error ?? domains.error} />
    }
    if (methods.length === 0) {
      return (
        <SettingsEmptyState
          description={
            <Trans>
              No sign-in methods yet. Connect an identity provider to sign people in, or add a domain your organization
              owns.
            </Trans>
          }
        />
      )
    }
    return methods.map((method) => {
      const editId =
        method.kind === 'connection' ? connectionEditId(method.connection.id) : domainEditId(method.domain.id)
      const isSelected = page.selectedId === editId
      const onSelect = () => page.requestSelect(isSelected ? null : editId)
      return method.kind === 'connection' ? (
        <ConnectionCard key={editId} connection={method.connection} isSelected={isSelected} onSelect={onSelect} />
      ) : (
        <DomainCard key={editId} domain={method.domain} isSelected={isSelected} onSelect={onSelect} />
      )
    })
  }

  return (
    <>
      <AdminPage
        title={t`Sign-in methods`}
        action={
          <PageCreateAction label={t`Add sign-in method`} onClick={() => page.requestSelect(newSignInMethodId)} />
        }
        panel={panel()}
        onClose={page.close}
      >
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>
            Connect your identity providers to sign people in and keep accounts in step, and verify the domains your
            organization owns.
          </Trans>
        </p>
        {body()}
      </AdminPage>
      <ResourcePageDialogs
        page={page}
        remove={
          removing?.kind === 'domain'
            ? {
                title: t`Remove ${removingName}?`,
                description: (
                  <Trans>
                    People who joined through this domain stay members. Adding it again needs a new verification record.
                  </Trans>
                ),
                confirmLabel: t`Remove domain`,
                onConfirm: () => remove.mutateAsync(removing.id),
              }
            : {
                title: t`Retire this connection?`,
                description: t`Nobody can sign in through it any more, and members only it admitted lose access. This can't be undone.`,
                confirmLabel: t`Retire connection`,
                // The dialog only opens with a connection's remove id set.
                onConfirm: async () => {
                  await retire.mutateAsync(removing!.id)
                },
              }
        }
      />
    </>
  )
}
