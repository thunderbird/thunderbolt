/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Server } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { IconTile } from '@/components/settings/icon-tile'
import { builtInAgent } from '@/defaults/agents'
import { getGroupAgentAccessSources, getMemberAgentAccessSources, type AgentAccessSource } from '../agent-access'
import type { PreviewGroup, PreviewMember, PreviewState } from '../data'

type AccessBadgeSource = AgentAccessSource | { type: 'everyone' }

type AgentAccessSummaryProps = { state: PreviewState } & (
  | { member: PreviewMember; group?: never }
  | { group: PreviewGroup; member?: never }
)

/** Compact access summaries use the same live-grant calculation as the member agent preview. */
export const AgentAccessSummary = ({ state, member, group }: AgentAccessSummaryProps) => {
  const { t } = useLingui()
  const companyAgents = state.agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      builtIn: false,
      sources: member ? getMemberAgentAccessSources(agent, member, state) : getGroupAgentAccessSources(agent, group),
    }))
    .filter((agent) => agent.sources.length > 0)
  const agents =
    member && member.deletedAt === null && state.policy.thunderboltAllowed
      ? [
          {
            id: builtInAgent.id,
            name: builtInAgent.name,
            builtIn: true,
            sources: [{ type: 'everyone' } satisfies AccessBadgeSource],
          },
          ...companyAgents,
        ]
      : companyAgents
  const grantLabel = (source: AccessBadgeSource): string => {
    if (source.type === 'group') {
      return member ? t`Via ${source.group.name}` : t`Shared with this group`
    }
    return t`Everyone`
  }

  if (!agents.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {member ? <Trans>No agents with access.</Trans> : <Trans>No agents shared with this group.</Trans>}
      </p>
    )
  }

  return (
    <ul className="grid grid-cols-2 gap-2">
      {agents.map((agent) => (
        <li key={agent.id} className="flex min-w-0 flex-col gap-3 rounded-xl border p-3">
          <div className="flex min-w-0 items-center gap-2">
            <IconTile className="size-7">
              {agent.builtIn ? <AppLogo className="size-4" alt="" /> : <Server className="size-4" aria-hidden="true" />}
            </IconTile>
            <span className="break-words text-sm font-medium">{agent.name}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.sources.map((source) => (
              <span
                key={source.type === 'group' ? source.group.id : source.type}
                className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {grantLabel(source)}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
