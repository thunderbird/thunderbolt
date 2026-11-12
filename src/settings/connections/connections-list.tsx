/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plug, Plus } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsListBody, SettingsListPane, SettingsSelectableRow } from '@/components/settings/settings-list'
import { StatusIndicator, type StatusState } from '@/components/status-indicator'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { Switch } from '@/components/ui/switch'
import type { McpServer } from '@/types'
import { serverDisplayName, serverMatchesQuery } from './display'
import { ProviderConnectionIcon } from './provider-connection-icon'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderConnection } from '@/providers/types'
import type { Integration } from './types'

/** Shared row shell for both integration and MCP-server rows. */
const ConnectionRow = ({
  contextMenu,
  title,
  leading,
  isActive,
  isDimmed,
  onSelect,
  trailing,
}: {
  contextMenu?: { onEdit?: () => void; onRemove?: () => void }
  title: string
  leading: ReactNode
  isActive: boolean
  /** Mutes the title (disabled integration / disabled server). */
  isDimmed?: boolean
  onSelect: () => void
  trailing: ReactNode
}) => {
  const { t } = useLingui()

  return (
    <SettingsSelectableRow
      contextMenu={contextMenu}
      title={title}
      leading={<span className="flex size-5 items-center justify-center">{leading}</span>}
      isSelected={isActive}
      isDimmed={isDimmed}
      onSelect={onSelect}
      ariaLabel={t`Open ${title}`}
      trailing={trailing}
    />
  )
}

const IntegrationRow = ({
  onRemove,
  integration,
  isActive,
  onSelect,
  onToggleEnabled,
  disabled = false,
}: {
  onRemove?: () => void
  integration: Pick<Integration, 'provider' | 'name' | 'icon' | 'isEnabled' | 'isConnected'>
  disabled?: boolean
  isActive: boolean
  onSelect: () => void
  onToggleEnabled: (next: boolean) => void
}) => {
  const { t } = useLingui()
  const integrationName = integration.name

  return (
    <li>
      <ConnectionRow
        contextMenu={{ onEdit: integration.provider !== 'thunderbolt-pro' ? onSelect : undefined, onRemove }}
        title={integration.name}
        leading={integration.icon}
        isActive={isActive}
        isDimmed={!integration.isConnected}
        onSelect={onSelect}
        trailing={
          <Switch
            checked={integration.isEnabled}
            // Enabling only makes sense once the account is connected — the aside
            // holds the connect flow.
            disabled={disabled || !integration.isConnected}
            onCheckedChange={onToggleEnabled}
            aria-label={integration.isEnabled ? t`Disable ${integrationName}` : t`Enable ${integrationName}`}
          />
        }
      />
    </li>
  )
}

const ServerRow = ({
  server,
  status,
  isActive,
  onSelect,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  server: McpServer
  status: StatusState
  isActive: boolean
  onSelect: () => void
  onToggleEnabled: (next: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) => {
  const { t } = useLingui()
  const title = serverDisplayName(server)
  const isEnabled = server.enabled === 1
  return (
    <li>
      <ConnectionRow
        contextMenu={{ onEdit, onRemove: onDelete }}
        title={title}
        leading={<StatusIndicator status={isEnabled ? status : 'neutral'} size="sm" />}
        isActive={isActive}
        isDimmed={!isEnabled}
        onSelect={onSelect}
        trailing={
          <Switch
            checked={isEnabled}
            onCheckedChange={onToggleEnabled}
            aria-label={isEnabled ? t`Disable ${title}` : t`Enable ${title}`}
          />
        }
      />
    </li>
  )
}

/**
 * Lists integrations and named provider connections, followed by MCP servers.
 * Selection opens details; the create action offers providers and MCP setup.
 */
export const ConnectionsList = ({
  aiProviders,
  areProvidersReady,
  onToggleProvider,
  isProviderTogglePending,
  providerError,
  onSelectProvider,
  onEditProvider,
  onRemoveProvider,
  onRemoveIntegration,
  integrations,
  areIntegrationsReady,
  servers,
  areServersReady,
  serverStatus,
  activeKey,
  onAdd,
  onSelectIntegration,
  onSelectServer,
  onToggleIntegration,
  onToggleServer,
  onEditServer,
  onDeleteServer,
}: {
  aiProviders: ProviderConnection[]
  areProvidersReady: boolean
  onToggleProvider: (id: string, enabled: boolean) => void
  isProviderTogglePending: boolean
  providerError: string | null
  onSelectProvider: (id: string) => void
  onEditProvider: (id: string) => void
  onRemoveProvider: (id: string) => void
  onRemoveIntegration: (id: string) => void
  integrations: Integration[]
  /** True once the async sources behind the integrations' enabled state have
   *  resolved — used to remount the rows so their switches render directly in
   *  the loaded position instead of animating off→on. */
  areIntegrationsReady: boolean
  servers: McpServer[]
  areServersReady: boolean
  /** Live connection state for a server row's status dot. */
  serverStatus: (server: McpServer) => StatusState
  /** `integration:<id>` / `server:<id>` of the row whose detail panel is open, or null. */
  activeKey: string | null
  onAdd: () => void
  onSelectIntegration: (id: string) => void
  onSelectServer: (id: string) => void
  onToggleIntegration: (integration: Integration, next: boolean) => void
  onToggleServer: (id: string, next: boolean) => void
  onEditServer: (id: string) => void
  onDeleteServer: (id: string) => void
}) => {
  const { t, i18n } = useLingui()
  const [search, setSearch] = useState('')
  const query = search.trim()

  const { filteredIntegrations, filteredServers } = useMemo(() => {
    const needle = query.toLowerCase()
    return {
      filteredIntegrations: integrations.filter((i) => !query || i.name.toLowerCase().includes(needle)),
      filteredServers: servers.filter((s) => serverMatchesQuery(s, query)),
    }
  }, [integrations, servers, query])

  const filteredProviders = aiProviders.filter((provider) =>
    `${provider.name} ${getProviderDefinition(provider.provider).name}`.toLowerCase().includes(query.toLowerCase()),
  )

  const nothingMatches =
    filteredProviders.length === 0 && filteredIntegrations.length === 0 && filteredServers.length === 0
  const isEmpty =
    areProvidersReady &&
    areIntegrationsReady &&
    areServersReady &&
    aiProviders.length === 0 &&
    integrations.length === 0 &&
    servers.length === 0

  // md:min-w mirrors the skills/agents/models pages: once the detail aside
  // squeezes the list to this floor, the column stops sliding and tucks under
  // the panel via the parent's overflow clip.
  return (
    <SettingsListPane>
      <PageSearch onSearch={setSearch}>
        <PageHeader title={t`Connections`}>
          <PageSearch.Button />
          <PageCreateAction label={t`New Connection`} onClick={onAdd} />
        </PageHeader>

        <PageSearch.Input placeholder={t`Search connections`} onSearch={setSearch} />
      </PageSearch>

      <SettingsListBody>
        {providerError && (
          <p role="alert" className="text-sm text-destructive">
            {providerError}
          </p>
        )}
        {!nothingMatches && (
          <ul className="flex flex-col gap-4">
            {[
              ...filteredIntegrations.map((integration) => ({
                name: integration.name,
                row: (
                  <IntegrationRow
                    key={`${integration.id}:${areIntegrationsReady}`}
                    integration={integration}
                    onRemove={
                      integration.provider !== 'thunderbolt-pro' && integration.isConnected
                        ? () => onRemoveIntegration(integration.id)
                        : undefined
                    }
                    isActive={activeKey === `integration:${integration.id}`}
                    onSelect={() => onSelectIntegration(integration.id)}
                    onToggleEnabled={(next) => onToggleIntegration(integration, next)}
                  />
                ),
              })),
              ...filteredProviders.map((provider) => ({
                name: provider.name,
                row: (
                  <li key={`${provider.id}:${areProvidersReady}`}>
                    <ConnectionRow
                      contextMenu={{
                        onEdit: () => onEditProvider(provider.id),
                        onRemove: () => onRemoveProvider(provider.id),
                      }}
                      title={provider.name}
                      leading={<ProviderConnectionIcon provider={provider.provider} />}
                      isActive={activeKey === `provider:${provider.id}`}
                      isDimmed={!provider.enabled || !provider.connected}
                      onSelect={() => onSelectProvider(provider.id)}
                      trailing={
                        <Switch
                          checked={provider.enabled === 1}
                          onCheckedChange={(next) => onToggleProvider(provider.id, next)}
                          disabled={!areProvidersReady || isProviderTogglePending}
                          aria-label={provider.enabled ? t`Disable ${provider.name}` : t`Enable ${provider.name}`}
                        />
                      }
                    />
                  </li>
                ),
              })),
              ...filteredServers.map((server) => ({
                name: serverDisplayName(server),
                row: (
                  <ServerRow
                    key={server.id}
                    server={server}
                    status={serverStatus(server)}
                    isActive={activeKey === `server:${server.id}`}
                    onSelect={() => onSelectServer(server.id)}
                    onToggleEnabled={(next) => onToggleServer(server.id, next)}
                    onEdit={() => onEditServer(server.id)}
                    onDelete={() => onDeleteServer(server.id)}
                  />
                ),
              })),
            ]
              .sort((a, b) => a.name.localeCompare(b.name, i18n.locale, { sensitivity: 'base' }))
              .map(({ row }) => row)}
          </ul>
        )}

        {isEmpty && !query && (
          <EmptyState
            icon={Plug}
            title={t`No connections yet`}
            description={t`Connect providers, accounts, or MCP servers to use their models and tools.`}
            action={
              <Button variant="outline" onClick={onAdd}>
                <Plus />
                <Trans>Add connection</Trans>
              </Button>
            }
          />
        )}

        {nothingMatches && query && (
          <SettingsNoResults>
            <Trans>No matching connections.</Trans>
          </SettingsNoResults>
        )}
      </SettingsListBody>
    </SettingsListPane>
  )
}
