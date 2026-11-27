/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Globe, KeyRound, Plus } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSectionLabel, SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
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
import { itemContextMenuItems, type ItemAction } from '../../components/item-actions'
import { connectionActions, domainActions } from './sign-in-method-actions'
import { ConnectionEditor } from '../identity-providers/connection-editor'
import { RetireScimDialog } from '../identity-providers/retire-scim-dialog'
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

/** The name a sign-in method is listed under. */
const methodName = (method: SignInMethod) =>
  method.kind === 'connection' ? method.connection.name : method.domain.domain

const ConnectionCard = ({
  connection,
  isSelected,
  onSelect,
  actions,
}: {
  connection: AdminConnection
  isSelected: boolean
  onSelect: () => void
  actions: ItemAction[]
}) => {
  const { t, i18n } = useLingui()
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
      trailingIcon={badge && <StatusBadge tone={badge.tone}>{i18n._(badge.label)}</StatusBadge>}
      ariaLabel={t`Open ${connection.name}`}
      isSelected={isSelected}
      isDimmed={summary.retired}
      onSelect={onSelect}
      contextMenuItems={itemContextMenuItems(actions)}
    />
  )
}

/** What a domain does, under its name; an unverified one says so with its badge instead. */
const DomainSubtitle = ({ domain }: { domain: OrgDomain }) => {
  switch (getDomainStatus(domain)) {
    case 'claimed': {
      const name = domain.claimedBy?.name
      return <Trans>Claimed by {name}</Trans>
    }
    case 'verified':
      return domain.enrollmentEnabled ? <Trans>Open to enrollment</Trans> : <Trans>Closed to enrollment</Trans>
    case 'unverified':
      return null
  }
}

const DomainCard = ({
  domain,
  isSelected,
  onSelect,
  actions,
}: {
  domain: OrgDomain
  isSelected: boolean
  onSelect: () => void
  actions: ItemAction[]
}) => {
  const { t } = useLingui()
  return (
    <SettingsSelectableRow
      title={domain.domain}
      subtitle={<DomainSubtitle domain={domain} />}
      leading={
        <IconTile>
          <Globe className="size-5 text-muted-foreground" />
        </IconTile>
      }
      trailingIcon={getDomainStatus(domain) === 'unverified' && <DomainStatusBadge domain={domain} />}
      ariaLabel={t`Open ${domain.domain}`}
      isSelected={isSelected}
      onSelect={onSelect}
      contextMenuItems={itemContextMenuItems(actions)}
    />
  )
}

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
  const [retiringScim, setRetiringScim] = useState<AdminConnection | null>(null)
  const [search, setSearch] = useState('')

  const methods: SignInMethod[] = [
    ...(connections.data ?? []).map((connection) => ({ kind: 'connection' as const, connection })),
    ...(domains.data ?? []).map((domain) => ({ kind: 'domain' as const, domain })),
  ].sort((a, b) => methodName(a).localeCompare(methodName(b), locale))
  const query = search.trim().toLocaleLowerCase(locale)
  const matches = methods.filter((method) => methodName(method).toLocaleLowerCase(locale).includes(query))
  // Retired connections sit under their own heading, as disabled skills do.
  const isRetired = (method: SignInMethod) =>
    method.kind === 'connection' && describeConnection(method.connection).retired
  const active = matches.filter((method) => !isRetired(method))
  const retired = matches.filter(isRetired)

  const selected = parseSignInMethodId(page.selectedId)
  // A selection that no longer matches a domain (a stale link, a removed domain) opens nothing.
  const selectedDomain = selected?.kind === 'domain' ? domains.data?.find((domain) => domain.id === selected.id) : null
  const removing = parseSignInMethodId(page.removeId)
  const removingName =
    removing?.kind === 'domain'
      ? (domains.data?.find((domain) => domain.id === removing.id)?.domain ?? '')
      : (connections.data?.find((connection) => connection.id === removing?.id)?.name ?? '')

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
          onBack={() => page.requestSelect(newSignInMethodId)}
        />
      )
    }
    if (selected?.kind === 'connection') {
      // A fresh draft each time the edit form opens.
      return (
        <ConnectionEditor
          key={`${selected.id}:${page.isEditing}`}
          connectionId={selected.id}
          name={connections.data?.find((connection) => connection.id === selected.id)?.name}
          page={page}
          onRetireScim={() => {
            const connection = connections.data?.find((item) => item.id === selected.id)
            if (connection) {
              setRetiringScim(connection)
            }
          }}
        />
      )
    }
    if (selectedDomain) {
      return (
        <DomainEditor
          key={selectedDomain.id}
          domain={selectedDomain}
          actions={domainActions(selectedDomain, page)}
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
        <EmptyState
          icon={KeyRound}
          title={t`No sign-in methods yet`}
          action={
            <Button size="sm" variant="outline" onClick={() => page.requestSelect(newSignInMethodId)}>
              <Plus />
              <Trans>Add your first sign-in method</Trans>
            </Button>
          }
        />
      )
    }
    if (matches.length === 0) {
      return (
        <SettingsNoResults>
          <Trans>No matching sign-in methods.</Trans>
        </SettingsNoResults>
      )
    }
    const row = (method: SignInMethod) => {
      const editId =
        method.kind === 'connection' ? connectionEditId(method.connection.id) : domainEditId(method.domain.id)
      const onSelect = () => page.requestSelect(editId)
      return (
        <li key={editId}>
          {method.kind === 'connection' ? (
            <ConnectionCard
              connection={method.connection}
              isSelected={page.selectedId === editId && !page.isEditing}
              onSelect={onSelect}
              actions={connectionActions(method.connection, page, () => setRetiringScim(method.connection))}
            />
          ) : (
            <DomainCard
              domain={method.domain}
              isSelected={page.selectedId === editId && !page.isEditing}
              onSelect={onSelect}
              actions={domainActions(method.domain, page)}
            />
          )}
        </li>
      )
    }
    return (
      <>
        {active.length > 0 && <ul className="flex flex-col gap-4">{active.map(row)}</ul>}
        {retired.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            <SettingsSectionLabel>
              <Trans>Retired</Trans>
            </SettingsSectionLabel>
            <ul className="flex flex-col gap-4">{retired.map(row)}</ul>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <AdminPage
        title={t`Sign In`}
        search={{ placeholder: t`Search sign-in methods`, onSearch: setSearch }}
        isEmpty={connections.isSuccess && domains.isSuccess && methods.length === 0}
        action={
          <PageCreateAction label={t`New Sign-in Method`} onClick={() => page.requestSelect(newSignInMethodId)} />
        }
        panel={panel()}
        onClose={page.close}
      >
        {body()}
      </AdminPage>
      {retiringScim && <RetireScimDialog connection={retiringScim} onClose={() => setRetiringScim(null)} />}
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
                title: t`Retire ${removingName}?`,
                description: t`Nobody can sign in through it any more, and members only it admitted lose access. This can't be undone.`,
                confirmLabel: t`Retire connection`,
                // A retired connection stays listed, so its panel stays open to show it retired.
                closesPanel: false,
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
