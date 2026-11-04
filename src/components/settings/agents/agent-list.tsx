/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Bot } from 'lucide-react'
import type { Agent } from '@/types/acp'
import { SettingsSectionLabel } from '@/components/settings/settings-list'
import { AgentRow } from './agent-row'
import { AgentListRow } from './agent-list-row'
import { Switch } from '@/components/ui/switch'

type AgentListProps = {
  /** Unified list from `useAllAgents` (built-in first, then system, then customs). */
  agents: Agent[]
  /** The agent id whose detail is currently open — brightens that row. */
  selectedId?: string | null
  /** Opens the detail panel for the given agent. */
  onOpenAgent: (agent: Agent) => void
  cloudAgents?: { record: { id: string; enabled: boolean }; config: { name: string } }[]
  onOpenCloudAgent?: (id: string) => void
  currentUserId?: string | null
  onToggleAgent?: (agent: Agent, enabled: boolean) => void
  onToggleCloudAgent?: (id: string, enabled: boolean) => void
  togglePending?: boolean
}

/**
 * Agent rows open settings, with independent activation toggles for owned agents.
 * When system agents exist the list splits into two labeled sections —
 * "Your agents" (the built-in Thunderbolt agent + the user's own connected
 * agents) and "System agents" (provided by the deployment). With no system
 * agents the labels are noise, so the rows render as one flat list.
 */
export const AgentList = ({
  agents,
  cloudAgents = [],
  selectedId,
  onOpenAgent,
  onOpenCloudAgent,
  currentUserId,
  onToggleAgent,
  onToggleCloudAgent,
  togglePending,
}: AgentListProps) => {
  const { t } = useLingui()
  const systemAgents = agents.filter((a) => a.type !== 'built-in' && a.isSystem === 1)
  const yourAgents = agents.filter((a) => a.type === 'built-in' || a.isSystem !== 1)
  const showSections = systemAgents.length > 0 && (yourAgents.length > 0 || cloudAgents.length > 0)
  const cloudRows = cloudAgents.map((agent) => (
    <AgentListRow
      key={agent.record.id}
      testId={`agent-row-${agent.record.id}`}
      title={agent.config.name}
      subtitle={agent.record.enabled ? t`Thunderbolt agent` : t`Thunderbolt agent · Disabled`}
      icon={<Bot className="size-5 text-muted-foreground" aria-hidden="true" />}
      isSelected={selectedId === agent.record.id}
      isDimmed={!agent.record.enabled}
      ariaLabel={t`Open ${agent.config.name}`}
      onOpen={() => onOpenCloudAgent?.(agent.record.id)}
      trailing={
        onToggleCloudAgent && (
          <Switch
            checked={agent.record.enabled}
            disabled={togglePending}
            onCheckedChange={(enabled) => onToggleCloudAgent(agent.record.id, enabled)}
            aria-label={agent.record.enabled ? t`Disable ${agent.config.name}` : t`Enable ${agent.config.name}`}
          />
        )
      }
    />
  ))

  const rows = (list: Agent[]) =>
    list.map((agent) => (
      <AgentRow
        key={agent.id}
        agent={agent}
        isSelected={selectedId === agent.id}
        onOpen={onOpenAgent}
        togglePending={togglePending}
        onToggle={
          onToggleAgent &&
          agent.type !== 'built-in' &&
          agent.isSystem !== 1 &&
          !!currentUserId &&
          agent.userId === currentUserId
            ? (enabled) => onToggleAgent(agent, enabled)
            : undefined
        }
      />
    ))

  // gap-4 between rows — same rhythm as the models page's card list.
  if (!showSections) {
    return (
      <div className="flex flex-col gap-4" data-testid="agent-list">
        {rows(agents)}
        {cloudRows}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="agent-list">
      <section className="flex flex-col gap-2" data-testid="agent-section-yours">
        <SettingsSectionLabel>
          <Trans>Your agents</Trans>
        </SettingsSectionLabel>
        <div className="flex flex-col gap-4">
          {rows(yourAgents)}
          {cloudRows}
        </div>
      </section>
      <section className="flex flex-col gap-2" data-testid="agent-section-system">
        <SettingsSectionLabel>
          <Trans>System agents</Trans>
        </SettingsSectionLabel>
        <div className="flex flex-col gap-4">{rows(systemAgents)}</div>
      </section>
    </div>
  )
}
