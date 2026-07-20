/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'
import { AgentRow } from './agent-row'

const SectionLabel = ({ children }: { children: string }) => (
  <h2 className="text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </h2>
)

type AgentListProps = {
  /** Unified list from `useAllAgents` (built-in first, then system, then customs). */
  agents: Agent[]
  /** The agent id whose detail is currently open — brightens that row. */
  selectedId?: string | null
  /** Opens the detail panel for the given agent. */
  onOpenAgent: (agent: Agent) => void
}

/**
 * The agents list: read-only rows that each open a slide-in detail panel.
 * When system agents exist the list splits into two labeled sections —
 * "Your agents" (the built-in Thunderbolt agent + the user's own connected
 * agents) and "System agents" (provided by the deployment). With no system
 * agents the labels are noise, so the rows render as one flat list.
 */
export const AgentList = ({ agents, selectedId, onOpenAgent }: AgentListProps) => {
  const systemAgents = agents.filter((a) => a.type !== 'built-in' && a.isSystem === 1)
  const yourAgents = agents.filter((a) => a.type === 'built-in' || a.isSystem !== 1)
  const showSections = systemAgents.length > 0 && yourAgents.length > 0

  const rows = (list: Agent[]) =>
    list.map((agent) => (
      <AgentRow key={agent.id} agent={agent} isSelected={selectedId === agent.id} onOpen={onOpenAgent} />
    ))

  // gap-4 between rows — same rhythm as the models page's card list.
  if (!showSections) {
    return (
      <div className="flex flex-col gap-4" data-testid="agent-list">
        {rows(agents)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="agent-list">
      <section className="flex flex-col gap-2" data-testid="agent-section-yours">
        <SectionLabel>Your agents</SectionLabel>
        <div className="flex flex-col gap-4">{rows(yourAgents)}</div>
      </section>
      <section className="flex flex-col gap-2" data-testid="agent-section-system">
        <SectionLabel>System agents</SectionLabel>
        <div className="flex flex-col gap-4">{rows(systemAgents)}</div>
      </section>
    </div>
  )
}
