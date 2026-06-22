/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Card, CardHeader } from '@/components/ui/card'
import { ScopeBadge } from '@/components/scope-badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useState } from 'react'
import { Globe, Pencil, Server, Trash2, Zap } from 'lucide-react'
import type { Agent } from '@/types/acp'

/** Visual order: built-in (zap) → managed/system (server) → remote (globe). */
const iconForAgent = (agent: Agent) => {
  if (agent.type === 'built-in') {
    return Zap
  }
  if (agent.type === 'managed-acp') {
    return Server
  }
  return Globe
}

/** Human label rendered next to each row's name. */
const badgeForAgent = (agent: Agent): string => {
  if (agent.type === 'built-in') {
    return 'Built-in'
  }
  if (agent.type === 'managed-acp') {
    return 'System'
  }
  return 'Remote'
}

/** Predicate for the delete action's visibility. Customs the current user owns
 *  can be soft-deleted; built-in and system agents are managed externally and
 *  must not be removable from the UI. Exported for unit testing without
 *  rendering the full row tree.
 *
 *  `canRemoveAgents` reflects the workspace `remove_agents` permission — when
 *  false, no row is removable regardless of ownership. Defaults to true so
 *  existing callers keep working.
 */
export const canDeleteAgent = (
  agent: Agent,
  currentUserId: string | null,
  canRemoveAgents: boolean = true,
): boolean => {
  if (agent.type === 'built-in') {
    return false
  }
  if (agent.isSystem === 1) {
    return false
  }
  if (!currentUserId) {
    return false
  }
  if (!canRemoveAgents) {
    return false
  }
  return agent.userId === currentUserId
}

/** Predicate for the edit action's visibility. Mirrors `canDeleteAgent`:
 *  built-in is in-code, system agents are managed via env vars, and customs
 *  belong to the user who created them. */
export const canEditAgent = (agent: Agent, currentUserId: string | null): boolean =>
  canDeleteAgent(agent, currentUserId)

/** Computes the toggle's disabled state and the corresponding "always available"
 *  tooltip text. Built-in is an in-code constant; system agents are configured
 *  on the backend via env vars — neither can be toggled by the user. Exported
 *  for unit testing the branching without rendering the portaled tooltip. */
export const agentToggleDisabled = (agent: Agent): { disabled: boolean; disabledTooltip: string | null } => {
  if (agent.type === 'built-in') {
    return { disabled: true, disabledTooltip: 'Built-in agent is always available' }
  }
  if (agent.type === 'managed-acp' && agent.isSystem === 1) {
    return { disabled: true, disabledTooltip: 'System agent is always available' }
  }
  return { disabled: false, disabledTooltip: null }
}

type AgentRowProps = {
  agent: Agent
  currentUserId: string | null
  /** Defaults to true. Mirrors the workspace `add_agents` permission — also
   *  used for the enable/disable toggle since toggling is a PATCH the BE
   *  gates on `add_agents`. */
  canEditAgents?: boolean
  /** Defaults to true. Mirrors the workspace `remove_agents` permission. */
  canRemoveAgents?: boolean
  /** When true, the scope badge (Private / Shared) shows on `remote-acp` rows.
   *  Resolved once at the page level via `useScopePickerEnabled()` and threaded
   *  down — keeps the row purely visual + provider-free for tests. */
  scopePickerEnabled?: boolean
  onToggle: (agent: Agent, enabled: boolean) => void
  onEdit: (agent: Agent) => void
  onDelete: (agent: Agent) => void
}

export const AgentRow = ({
  agent,
  currentUserId,
  canEditAgents = true,
  canRemoveAgents = true,
  scopePickerEnabled = false,
  onToggle,
  onEdit,
  onDelete,
}: AgentRowProps) => {
  const Icon = iconForAgent(agent)
  const badge = badgeForAgent(agent)
  const showEdit = canEditAgent(agent, currentUserId)
  const showDelete = canDeleteAgent(agent, currentUserId, canRemoveAgents)
  const { disabled: toggleDisabled, disabledTooltip } = agentToggleDisabled(agent)
  const finalToggleDisabled = toggleDisabled || !canEditAgents
  const isEnabled = agent.enabled === 1
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleDelete = () => {
    setDeleteOpen(false)
    onDelete(agent)
  }

  return (
    <Card data-testid={`agent-row-${agent.id}`} className="border border-border">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Icon className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg font-medium truncate">{agent.name}</span>
                <span
                  className="text-[length:var(--font-size-xs)] text-muted-foreground rounded-md border border-border px-2 py-0.5 shrink-0"
                  data-testid={`agent-badge-${agent.id}`}
                >
                  {badge}
                </span>
              </div>
              {agent.description && (
                <p className="text-[length:var(--font-size-sm)] text-muted-foreground truncate">{agent.description}</p>
              )}
              {agent.type === 'remote-acp' && (
                <ScopeBadge scope={agent.scope} show={scopePickerEnabled} className="mt-1" />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Switch
                    data-testid={`agent-toggle-${agent.id}`}
                    checked={isEnabled}
                    disabled={finalToggleDisabled}
                    onCheckedChange={(checked) => onToggle(agent, checked)}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{disabledTooltip ?? (isEnabled ? 'Disable agent' : 'Enable agent')}</p>
              </TooltipContent>
            </Tooltip>
            {showEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0"
                    aria-label={`Edit ${agent.name}`}
                    data-testid={`agent-edit-${agent.id}`}
                    onClick={() => onEdit(agent)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Edit agent</p>
                </TooltipContent>
              </Tooltip>
            )}
            {showDelete && (
              <Popover open={deleteOpen} onOpenChange={setDeleteOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0"
                    aria-label={`Remove ${agent.name}`}
                    data-testid={`agent-delete-${agent.id}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" side="bottom" align="end">
                  <div className="space-y-3">
                    <div>
                      <h4 className="font-medium">Remove Agent</h4>
                      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
                        Are you sure you want to remove {agent.name}?
                      </p>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)}>
                        Cancel
                      </Button>
                      <Button variant="destructive" size="sm" onClick={handleDelete}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </CardHeader>
    </Card>
  )
}
