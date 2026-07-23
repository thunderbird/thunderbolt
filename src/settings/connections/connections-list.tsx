/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plug, Plus, SquarePen, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { StatusIndicator, type StatusState } from '@/components/status-indicator'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { McpServer } from '@/types'
import { cleanServerUrl, serverDisplayName, serverMatchesQuery } from './display'
import type { Integration } from './types'

/** Shared row shell for both integration and MCP-server rows. */
const ConnectionRow = ({
  title,
  subtitle,
  leading,
  isActive,
  disabledLook,
  onSelect,
  switchProps,
}: {
  title: string
  subtitle?: string
  leading: ReactNode
  isActive: boolean
  /** Mutes the title (disabled integration / disabled server). */
  disabledLook?: boolean
  onSelect: () => void
  switchProps: { checked: boolean; disabled?: boolean; onCheckedChange: (next: boolean) => void; label: string }
}) => (
  <Card
    className={cn(
      'flex-row items-center gap-0 border-border p-0 transition-colors',
      isActive ? 'bg-accent' : 'hover:bg-secondary/50',
    )}
  >
    <button
      type="button"
      aria-label={`Open ${title}`}
      aria-pressed={isActive}
      onClick={onSelect}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-l-[inherit] px-4 py-3 text-left"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{leading}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-base font-medium', disabledLook && 'text-muted-foreground')}>
          {title}
        </span>
        {subtitle && (
          <span className="block truncate text-[length:var(--font-size-sm)] text-muted-foreground">{subtitle}</span>
        )}
      </span>
    </button>
    <div className="flex shrink-0 items-center pr-4">
      <Switch
        checked={switchProps.checked}
        disabled={switchProps.disabled}
        onCheckedChange={switchProps.onCheckedChange}
        aria-label={switchProps.label}
      />
    </div>
  </Card>
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
      disabledLook={!integration.isConnected}
      onSelect={onSelect}
      switchProps={{
        checked: integration.isEnabled,
        // Enabling only makes sense once the account is connected — the aside
        // holds the connect flow.
        disabled: !integration.isConnected,
        onCheckedChange: onToggleEnabled,
        label: `${integration.isEnabled ? 'Disable' : 'Enable'} ${integration.name}`,
      }}
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
  const enabled = server.enabled === 1
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
              leading={<StatusIndicator status={enabled ? status : 'neutral'} size="sm" />}
              isActive={isActive}
              disabledLook={!enabled}
              onSelect={onSelect}
              switchProps={{
                checked: enabled,
                onCheckedChange: onToggleEnabled,
                label: `${enabled ? 'Disable' : 'Enable'} ${title}`,
              }}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-56">
          <ContextMenuItem onClick={onEdit} className="cursor-pointer">
            <SquarePen className="size-4 mr-2" />
            Edit
          </ContextMenuItem>
          <ContextMenuItem onClick={onDelete} className="cursor-pointer">
            <Trash2 className="size-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
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
}) => {
  const [search, setSearch] = useState('')

  const { filteredIntegrations, filteredServers } = useMemo(() => {
    const query = search.trim()
    const needle = query.toLowerCase()
    return {
      filteredIntegrations: integrations.filter((i) => !query || i.name.toLowerCase().includes(needle)),
      filteredServers: servers.filter((s) => serverMatchesQuery(s, query)),
    }
  }, [integrations, servers, search])

  const nothingMatches = filteredIntegrations.length === 0 && filteredServers.length === 0

  // md:min-w mirrors the skills/agents/models pages: once the detail aside
  // squeezes the list to this floor, the column stops sliding and tucks under
  // the panel via the parent's overflow clip.
  return (
    <section className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-3 bg-background p-4 md:min-w-[360px] md:px-5 text-foreground">
      <PageSearch onSearch={setSearch}>
        <PageHeader title="Connections">
          <PageSearch.Button />
          <Button variant="outline" size="icon" aria-label="Add MCP server" className="bg-card" onClick={onAdd}>
            <Plus />
          </Button>
        </PageHeader>

        <PageSearch.Input placeholder="Search connections" onSearch={setSearch} />
      </PageSearch>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
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
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">MCP servers</h2>
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

        {servers.length === 0 && !search.trim() && (
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/25 px-6 py-10 text-center">
            <Plug className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="max-w-md text-sm text-muted-foreground">
              Connect your own MCP servers to give agents more tools.
            </p>
            <Button size="sm" onClick={onAdd}>
              <Plus />
              Add your first server
            </Button>
          </div>
        )}

        {nothingMatches && search.trim() && (
          <p className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No matching connections.
          </p>
        )}
      </div>
    </section>
  )
}
