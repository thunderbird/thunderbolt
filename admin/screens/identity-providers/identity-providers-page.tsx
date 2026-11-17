/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { KeyRound } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import type { AdminConnection } from '@shared/admin-api'
import { getAdminErrorMessage } from '../../api/error-messages'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { connectionBadge, envOwnedLabel, scimLabels, ssoLabels } from './connection-labels'
import { describeConnection } from './connection-status'
import { NewConnectionEditor } from './new-connection-editor'
import { useConnections } from './use-connection-queries'

const ConnectionRow = ({
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

/** The org's identity providers: each connection's sign-in and provisioning, and adding new ones. */
export const IdentityProvidersPage = () => {
  const { t, i18n } = useLingui()
  const page = useResourcePageState()
  const connections = useConnections()

  const panel =
    page.selectedId === 'new' ? (
      <NewConnectionEditor
        onClose={page.close}
        onCreated={(connectionId) => page.select(connectionId)}
        onDirty={(dirty) => page.patch({ dirty })}
      />
    ) : null

  const body = () => {
    if (connections.isPending) {
      return <ListSkeleton />
    }
    if (connections.error) {
      return (
        <p role="alert" className="text-destructive">
          {i18n._(getAdminErrorMessage(connections.error))}
        </p>
      )
    }
    if (connections.data.length === 0) {
      return (
        <SettingsEmptyState
          description={<Trans>No identity providers yet. Add one to sign people in or provision them.</Trans>}
        />
      )
    }
    return connections.data.map((connection) => (
      <ConnectionRow
        key={connection.id}
        connection={connection}
        isSelected={page.selectedId === connection.id}
        onSelect={() => page.requestSelect(page.selectedId === connection.id ? null : connection.id)}
      />
    ))
  }

  return (
    <AdminPage
      title={t`Identity providers`}
      action={<PageCreateAction label={t`Add connection`} onClick={() => page.requestSelect('new')} />}
      panel={panel}
      onClose={page.close}
    >
      <p className="text-sm text-muted-foreground">
        <Trans>Connect your identity provider to sign people in and keep accounts in step with it.</Trans>
      </p>
      {body()}
      <ResourcePageDialogs page={page} />
    </AdminPage>
  )
}
