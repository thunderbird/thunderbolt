/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentRow } from './agent-row'
import type { Agent } from '@/types/acp'

type AgentListProps = {
  agents: Agent[]
  currentUserId: string | null
  /** Defaults to true. Mirrors `add_agents`; gates the row enable/disable toggle. */
  canEditAgents?: boolean
  /** Defaults to true — when false the Remove affordance is hidden on every row.
   *  Mirrors the workspace `remove_agents` permission; the BE is authoritative. */
  canRemoveAgents?: boolean
  onToggle: (agent: Agent, enabled: boolean) => void
  onEdit: (agent: Agent) => void
  onDelete: (agent: Agent) => void
}

/** Renders the unified agent list returned by `useAllAgents` (built-in first,
 *  then system, then user customs). Composition lives in the DAL — this
 *  component is purely visual + event-dispatching so it stays trivial to test. */
export const AgentList = ({
  agents,
  currentUserId,
  canEditAgents = true,
  canRemoveAgents = true,
  onToggle,
  onEdit,
  onDelete,
}: AgentListProps) => (
  <div className="grid gap-3" data-testid="agent-list">
    {agents.map((agent) => (
      <AgentRow
        key={agent.id}
        agent={agent}
        currentUserId={currentUserId}
        canEditAgents={canEditAgents}
        canRemoveAgents={canRemoveAgents}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    ))}
  </div>
)
