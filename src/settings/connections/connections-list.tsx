/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plug, Plus, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { EditDeleteContextMenuContent } from '@/components/settings/edit-delete-context-menu'
import { SettingsEmptyState, SettingsNoResults } from '@/components/settings/settings-empty-state'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSectionLabel,
  SettingsSelectableRow,
} from '@/components/settings/settings-list'
import { StatusIndicator, type StatusState } from '@/components/status-indicator'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { Switch } from '@/components/ui/switch'
import { StatusCard } from '@/components/ui/status-card'
import type { McpServer } from '@/types'
import { cleanServerUrl, serverDisplayName, serverMatchesQuery } from './display'
import type { Integration } from './types'

/** Shared row shell for both integration and MCP-server rows. */
const ConnectionRow = ({
  title,
  subtitle,
  leading,
  isActive,
  isDimmed,
  onSelect,
  trailing,
}: {
  title: string
  subtitle?: string
  leading: ReactNode
  isActive: boolean
  /** Mutes the title (disabled integration / disabled server). */
  isDimmed?: boolean
  onSelect: () => void
  trailing: ReactNode
}) => (
  <SettingsSelectableRow
    title={title}
    subtitle={subtitle}
    leading={<span className="flex size-5 items-center justify-center">{leading}</span>}
    isSelected={isActive}
    isDimmed={isDimmed}
    onSelect={onSelect}
    ariaLabel={`Open ${title}`}
    trailing={trailing}
  />
)

const IntegrationRow = ({
  integration,
  isActive,
  onSelect,
  onToggleEnabled,
}: {
  integration: Integration
  isActive: boolean
  onSelect: () => void
  onToggleEnabled: (next: boolean) => void
}) => (
  <li>
    <ConnectionRow
      title={integration.name}
      subtitle={integration.isConnected ? integration.userEmail : undefined}
      leading={integration.icon}
      isActive={isActive}
      isDimmed={!integration.isConnected}
      onSelect={onSelect}
      trailing={
        <Switch
          checked={integration.isEnabled}
          // Enabling only makes sense once the account is connected — the aside
          // holds the connect flow.
          disabled={!integration.isConnected}
          onCheckedChange={onToggleEnabled}
          aria-label={`${integration.isEnabled ? 'Disable' : 'Enable'} ${integration.name}`}
        />
      }
    />
  </li>
)

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
  const title = serverDisplayName(server)
  const url = cleanServerUrl(server.url ?? '')
  const isEnabled = server.enabled === 1
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <ConnectionRow
              title={title}
              // Hide the subtitle when the name IS the cleaned URL — no point
              // printing the same string twice.
              subtitle={title === url ? undefined : url}
              leading={<StatusIndicator status={isEnabled ? status : 'neutral'} size="sm" />}
              isActive={isActive}
              isDimmed={!isEnabled}
              onSelect={onSelect}
              trailing={
                <Switch
                  checked={isEnabled}
                  onCheckedChange={onToggleEnabled}
                  aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${title}`}
                />
              }
            />
          </div>
        </ContextMenuTrigger>
        <EditDeleteContextMenuContent onEdit={onEdit} onDelete={onDelete} />
      </ContextMenu>
    </li>
  )
}

/**
 * The Connections page list: pre-baked integrations (Thunderbolt, Google,
 * Microsoft) at the top, user-added MCP servers below. Selection opens the
 * slide-in detail panel; the "+" opens the add-MCP-server flow there too.
 */
export const ConnectionsList = ({
  integrations,
  integrationsReady,
  servers,
  serverStatus,
  activeKey,
  onAdd,
  onSelectIntegration,
  onSelectServer,
  onToggleIntegration,
  onToggleServer,
  onEditServer,
  onDeleteServer,
  error,
}: {
  integrations: Integration[]
  /** True once the async sources behind the integrations' enabled state have
   *  resolved — used to remount the rows so their switches render directly in
   *  the loaded position instead of animating off→on. */
  integrationsReady: boolean
  servers: McpServer[]
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
  error?: string | null
}) => {
  const [search, setSearch] = useState('')
  const query = search.trim()

  const { filteredIntegrations, filteredServers } = useMemo(() => {
    const needle = query.toLowerCase()
    return {
      filteredIntegrations: integrations.filter((i) => !query || i.name.toLowerCase().includes(needle)),
      filteredServers: servers.filter((s) => serverMatchesQuery(s, query)),
    }
  }, [integrations, servers, query])

  const nothingMatches = filteredIntegrations.length === 0 && filteredServers.length === 0

  // md:min-w mirrors the skills/agents/models pages: once the detail aside
  // squeezes the list to this floor, the column stops sliding and tucks under
  // the panel via the parent's overflow clip.
  return (
    <SettingsListPane>
      <PageSearch onSearch={setSearch}>
        <PageHeader title="Connections">
          <PageSearch.Button />
          <Button variant="outline" size="icon" aria-label="Add MCP server" className="bg-card" onClick={onAdd}>
            <Plus />
          </Button>
        </PageHeader>

        <PageSearch.Input placeholder="Search connections" onSearch={setSearch} />
      </PageSearch>

      {error && (
        <StatusCard
          icon={<X className="h-4 w-4 text-destructive" />}
          title="Connection update failed"
          description={error}
        />
      )}

      <SettingsListBody>
        {filteredIntegrations.length > 0 && (
          <ul className="flex flex-col gap-4">
            {filteredIntegrations.map((integration) => (
              <IntegrationRow
                key={`${integration.id}:${integrationsReady}`}
                integration={integration}
                isActive={activeKey === `integration:${integration.id}`}
                onSelect={() => onSelectIntegration(integration.id)}
                onToggleEnabled={(next) => onToggleIntegration(integration, next)}
              />
            ))}
          </ul>
        )}

        {filteredServers.length > 0 && (
          <div className="mt-5 flex flex-col gap-2">
            <SettingsSectionLabel>MCP servers</SettingsSectionLabel>
            <ul className="flex flex-col gap-4">
              {filteredServers.map((server) => (
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
              ))}
            </ul>
          </div>
        )}

        {servers.length === 0 && !query && (
          <SettingsEmptyState
            className="mt-1"
            icon={<Plug className="size-8 text-muted-foreground" aria-hidden="true" />}
            description="Connect your own MCP servers to give agents more tools."
            action={
              <Button size="sm" onClick={onAdd}>
                <Plus />
                Add your first server
              </Button>
            }
          />
        )}

        {nothingMatches && query && <SettingsNoResults>No matching connections.</SettingsNoResults>}
      </SettingsListBody>
    </SettingsListPane>
  )
}
