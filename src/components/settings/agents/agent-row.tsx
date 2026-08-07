/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { iconForAgent } from '@/components/agent-icon'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { AgentDeployBadge } from './agent-deploy-badge'
import { AgentListRow } from './agent-list-row'
import { agentProvenanceLine } from './agent-provenance'

type AgentRowProps = {
  agent: Agent
  /** Whether this row's detail panel is open — brightens the row like other
   *  selected list items across the app. */
  isSelected?: boolean
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
export const AgentRow = ({ agent, isSelected, onOpen }: AgentRowProps) => {
  const Icon = iconForAgent(agent)
  const disabled = agent.enabled !== 1
  // Only user deploys carry a live status; system-discovered pipelines are
  // already running (isSystem).
  const isUserDeploy = agent.type === 'managed-acp' && agent.isSystem !== 1

  return (
    <AgentListRow
      testId={`agent-row-${agent.id}`}
      isSelected={isSelected}
      onOpen={() => onOpen(agent)}
      ariaLabel={`Open ${agent.name}`}
      isDimmed={disabled}
      icon={
        // The logo reads slightly smaller than the lucide glyphs at equal
        // box size, so it gets a half-step bump.
        <Icon
          className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-5.5' : 'size-5')}
          aria-hidden="true"
        />
      }
      title={agent.name}
      subtitleTestId={`agent-provenance-${agent.id}`}
      subtitle={
        <span className="inline-flex max-w-full items-center gap-1 align-middle">
          <span className="truncate">
            {agentProvenanceLine(agent)}
            {disabled && ' · Disabled'}
          </span>
          {isUserDeploy && <AgentDeployBadge agent={agent} />}
        </span>
      }
      chevronTestId={`agent-chevron-${agent.id}`}
    />
  )
}
