/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'

import { iconForAgent } from '@/components/agent-icon'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { agentProvenanceLine } from './agent-provenance'

type AgentRowProps = {
  agent: Agent
  /** Whether this row's detail panel is open — brightens the row like other
   *  selected list items across the app. */
  selected?: boolean
  /** Opens the detail panel. The whole row is the tap target; there are no
   *  inline edit / toggle / delete affordances — management lives in the
   *  detail. */
  onOpen: (agent: Agent) => void
}

/**
 * A single agent list row: icon + name on the primary line, provenance on the
 * secondary line, and a chevron. Every row opens the slide-in detail panel;
 * a disabled custom agent renders dimmed with a "Disabled" suffix so its
 * state stays visible without a switch on the row.
 */
export const AgentRow = ({ agent, selected, onOpen }: AgentRowProps) => {
  const Icon = iconForAgent(agent)
  const disabled = agent.enabled !== 1

  return (
    <Card data-testid={`agent-row-${agent.id}`} className="border border-border p-0">
      <button
        type="button"
        onClick={() => onOpen(agent)}
        aria-label={`Open ${agent.name}`}
        aria-pressed={selected}
        className={cn(
          'flex w-full cursor-pointer items-center gap-3 rounded-[inherit] px-4 py-3 text-left transition-colors',
          selected ? 'bg-accent' : 'hover:bg-secondary/50',
        )}
      >
        <div className="flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          {/* The logo reads slightly smaller than the lucide glyphs at equal
              box size, so it gets a half-step bump. */}
          <Icon
            className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-5.5' : 'size-5')}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-base font-medium', disabled && 'text-muted-foreground')}>{agent.name}</div>
          <div
            className="truncate text-[length:var(--font-size-sm)] text-muted-foreground"
            data-testid={`agent-provenance-${agent.id}`}
          >
            {agentProvenanceLine(agent)}
            {disabled && ' · Disabled'}
          </div>
        </div>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
          data-testid={`agent-chevron-${agent.id}`}
        />
      </button>
    </Card>
  )
}
